/**
 * Tree Trade hedger: mirrors hedge-requested Tree Trade positions with opposite-side positions on Decibel testnet,
 * on Trading Accounts whose owners delegated perp trading to this service. Separate process from the keeper.
 *
 *   npx tsx src/hedge/hedger.ts              # live if HEDGER_PRIVATE_KEY is set, else mock
 *   npx tsx src/hedge/hedger.ts --mock       # force the in-memory Decibel client
 *   npx tsx src/hedge/hedger.ts --once
 *
 * State (statuses, pending orders, pruned requests) is written atomically to HEDGE_STATE_PATH
 * (default keeper/hedge-state.json); the web app's /api/hedge/status serves it.
 */
import "../env";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Account, Aptos, AptosConfig, Ed25519PrivateKey, Network, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";
import { ENTRY, MODULE_ADDR, VIEW, fn, marketSymbol } from "../../../web/src/config/contract";
import { decibelConfig } from "./decibel-config";
import { KEEPER_LOG, botsApiKey, countingClient, startUsageLog } from "../usage";
import { LiveDecibelClient, MockDecibelClient, type DecibelClient } from "./decibel-client";
import { DEFAULT_SYNC, HedgeSync, emptyState, type ChainPort, type HedgeRequestRow, type HedgeState, type TTPosition } from "./sync";

const { values: flags } = parseArgs({
  options: {
    mock: { type: "boolean", default: false },
    once: { type: "boolean", default: false },
    interval: { type: "string" },
  },
});

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);
const INTERVAL_SECS = Number(flags.interval ?? process.env.HEDGE_INTERVAL_SECS ?? 15);
const STATE_PATH = path.resolve(process.env.HEDGE_STATE_PATH ?? path.join(import.meta.dirname, "../../hedge-state.json"));
const LOCK_PATH = STATE_PATH.replace(/\.json$/, ".lock");
/** ts-sdk v7 defaults max_gas_amount to 2,000,000; prune needs a few hundred units. */
const PRUNE_MAX_GAS = 20_000;
const TICK_TIMEOUT_MS = 120_000;

const FULLNODE = process.env.APTOS_FULLNODE || "https://fullnode.testnet.aptoslabs.com/v1";
const aptos = new Aptos(
  new AptosConfig({
    network: Network.TESTNET,
    fullnode: FULLNODE,
    client: countingClient(),
    clientConfig: botsApiKey() ? { API_KEY: botsApiKey()! } : undefined,
  }),
);

function loadHedger(): Account | undefined {
  const k = process.env.HEDGER_PRIVATE_KEY;
  if (!k) return undefined;
  return Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(PrivateKey.formatPrivateKey(k.trim(), PrivateKeyVariants.Ed25519)) });
}

/** Single instance: two hedgers on the same accounts could both act on one target before either fill lands. */
function acquireLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK_PATH, "utf8"));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        console.error(`another hedger (pid ${pid}) holds ${LOCK_PATH}; exiting`);
        process.exit(1);
      } catch {
        /* stale lock */
      }
    }
  } catch {
    /* no lock */
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  const release = () => {
    try {
      if (Number(fs.readFileSync(LOCK_PATH, "utf8")) === process.pid) fs.unlinkSync(LOCK_PATH);
    } catch {
      /* ignore */
    }
  };
  process.on("exit", release);
}

function loadState(mode: "live" | "mock", hedger: string): HedgeState {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as HedgeState;
    if (s.version === 1 && s.mode === mode && s.hedger === hedger) return s;
    log(`state file is for ${s.mode}/${s.hedger}; starting fresh`);
  } catch {
    /* none yet */
  }
  return emptyState(mode, hedger);
}

function saveState(s: HedgeState) {
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

/**
 * Tree Trade chain reads (views) and the prune write. Built to spend ~nothing when nothing changes:
 *  - Open positions come from the keeper's exchange::open_positions snapshot (keeper/open-positions.json, refreshed
 *    every SCAN_SECS). If it is stale (keeper down), one batched open_positions view of our own replaces it.
 *    Positions newer than the snapshot are read directly, so a fresh hedged open is never mistaken for a closed one.
 *  - hedge::active_requests is re-read only when the open set changed or every HEDGE_REQ_REFRESH_SECS (default 60;
 *    catches request_hedge / cancel_hedge on an existing position).
 */
const OPEN_SNAPSHOT = process.env.OPEN_SNAPSHOT_PATH ?? path.join(import.meta.dirname, "../../open-positions.json");
const SNAPSHOT_MAX_AGE_MS = Number(process.env.HEDGE_SNAPSHOT_MAX_AGE_SECS ?? 60) * 1000;
const REQ_REFRESH_MS = Number(process.env.HEDGE_REQ_REFRESH_SECS ?? 60) * 1000;
interface OpenRow { id: string; owner: string; market: number; isLong: boolean; notional: string; entry: string }

function chainPort(signer: Account | undefined): ChainPort {
  let open = new Map<string, TTPosition>();
  let openUpTo = 0; // next_position_id covered by `open`
  let openKey = "";
  let reqs: HedgeRequestRow[] | undefined;
  let reqKey = "";
  let reqAt = 0;
  const direct = new Map<string, TTPosition>();
  let selfScan: { at: number; from: number } | undefined;
  const toTT = (r: OpenRow): TTPosition => ({
    id: r.id,
    owner: String(r.owner),
    symbol: marketSymbol(Number(r.market)) ?? String(r.market),
    isLong: r.isLong === true,
    notionalRaw: BigInt(r.notional),
    entryPriceRaw: BigInt(r.entry),
  });

  async function scanSelf(from: number): Promise<{ rows: OpenRow[]; next: number }> {
    const rows: OpenRow[] = [];
    let start = from;
    for (;;) {
      const r = (await aptos.view({ payload: { function: fn(VIEW.openPositions), functionArguments: [start, 500] } })) as unknown[];
      const [ids, owners, marketsHex, longs, , , nots, entries] = r as [string[], string[], string, boolean[], unknown, unknown, string[], string[]];
      const markets = Buffer.from(String(marketsHex).replace(/^0x/, ""), "hex");
      ids.forEach((id, i) => rows.push({ id: String(id), owner: owners[i], market: markets[i], isLong: longs[i], notional: String(nots[i]), entry: String(entries[i]) }));
      start = Number(r[10]);
      if (start >= Number(r[11])) return { rows, next: Number(r[11]) };
    }
  }

  async function loadOpen(minId: number) {
    let snap: { at: number; from: number; nextPositionId: number; positions: OpenRow[] } | undefined;
    try {
      snap = JSON.parse(fs.readFileSync(OPEN_SNAPSHOT, "utf8"));
    } catch {
      /* none */
    }
    let rows: OpenRow[], next: number;
    if (snap && Date.now() - snap.at <= SNAPSHOT_MAX_AGE_MS && snap.from <= minId) {
      ({ positions: rows, nextPositionId: next } = snap);
    } else if (selfScan && selfScan.from <= minId && Date.now() - selfScan.at < 30_000) {
      return; // our own scan is recent enough
    } else {
      ({ rows, next } = await scanSelf(Math.max(0, minId)));
      selfScan = { at: Date.now(), from: Math.max(0, minId) }; // throws on RPC failure: never treat unknown as closed
    }
    open = new Map(rows.map((r) => [String(r.id), toTT(r)]));
    openUpTo = next;
    openKey = [...open.keys()].join(",");
  }

  return {
    async requests(): Promise<HedgeRequestRow[]> {
      const minId = reqs?.length ? Math.min(...reqs.map((r) => Number(r.positionId))) : 0;
      const prevKey = openKey;
      await loadOpen(minId);
      if (!reqs || openKey !== prevKey || Date.now() - reqAt >= REQ_REFRESH_MS) {
        const [ids, owners, subs] = (await aptos.view({ payload: { function: fn(VIEW.hedgeRequests), functionArguments: [] } })) as [string[], string[], string[]];
        reqs = ids.map((id, i) => ({ positionId: String(id), owner: owners[i], subaccount: subs[i] }));
        reqAt = Date.now();
        const k = reqs.map((r) => r.positionId).join(",");
        if (k !== reqKey) {
          // Requests changed: if a requested position predates the loaded range, reload from the lowest one.
          const lo = reqs.length ? Math.min(...reqs.map((r) => Number(r.positionId))) : 0;
          if (lo < minId) await loadOpen(lo);
          reqKey = k;
        }
      }
      return reqs;
    },
    async position(id: string): Promise<TTPosition | null> {
      const hit = open.get(id);
      if (hit) return hit;
      if (Number(id) < openUpTo) {
        direct.delete(id);
        return null; // inside the scanned range and not open: closed or liquidated
      }
      // Newer than the open set we hold: read it directly (cached; position details are immutable).
      const d = direct.get(id);
      if (d) return d;
      try {
        const t = await aptos.view({ payload: { function: fn(VIEW.getPosition), functionArguments: [id] } });
        const [owner, market, isLong, , , notional, entry] = t;
        const p = toTT({ id, owner: String(owner), market: Number(market), isLong: isLong === true, notional: String(notional), entry: String(entry) });
        direct.set(id, p);
        return p;
      } catch (e) {
        const [exists] = await aptos.view({ payload: { function: fn(VIEW.positionExists), functionArguments: [id] } });
        if (exists === false) return null;
        throw e;
      }
    },
    async prune(id: string): Promise<string> {
      if (!signer) throw new Error("no hedger key: prune skipped (mock mode)");
      const txn = await aptos.transaction.build.simple({
        sender: signer.accountAddress,
        data: { function: fn(ENTRY.pruneHedge), functionArguments: [id] },
        options: { maxGasAmount: PRUNE_MAX_GAS },
      });
      const p = await aptos.signAndSubmitTransaction({ signer, transaction: txn });
      const r = await aptos.waitForTransaction({ transactionHash: p.hash });
      if (!r.success) throw new Error(r.vm_status);
      return p.hash;
    },
  };
}

async function main() {
  const signer = loadHedger();
  const mock = flags.mock || !signer;
  let client: DecibelClient;
  if (mock) {
    const m = new MockDecibelClient();
    client = m;
    log("Decibel client: MOCK (no HEDGER_PRIVATE_KEY or --mock); every requested subaccount is treated as delegated");
  } else {
    client = new LiveDecibelClient(decibelConfig(), signer!, botsApiKey());
    log(`Decibel client: LIVE package=${decibelConfig().deployment.package} (fullnode${botsApiKey() ? " + node API key" : ", anonymous"})`);
  }
  startUsageLog("hedger", KEEPER_LOG);
  log(`hedger starting — module=${MODULE_ADDR} hedger=${client.hedgerAddress} interval=${INTERVAL_SECS}s state=${STATE_PATH}`);
  acquireLock();

  const chain = chainPort(mock ? undefined : signer);
  const sync = new HedgeSync(client, chain, loadState(client.mode, client.hedgerAddress), {
    ...DEFAULT_SYNC,
    reconcileMs: Number(process.env.HEDGE_RECONCILE_SECS ?? 300) * 1000,
    slippageBps: Number(process.env.HEDGE_SLIPPAGE_BPS ?? DEFAULT_SYNC.slippageBps),
    log: (m) => log(m),
    persist: (st) => saveState(st),
  });

  let stopping = false;
  const stop = () => {
    log("stopping…");
    stopping = true;
    // A tick can be stuck in an RPC; state from the last completed tick is already on disk.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let lastSummary = "";
  let quietTicks = 0;
  while (!stopping) {
    const started = Date.now();
    try {
      if (client instanceof MockDecibelClient) {
        for (const r of await chain.requests()) for (const mk of ["BTC/USD", "ETH/USD"]) client.delegate(r.subaccount, mk);
        client.step();
      }
      // Watchdog: a hung RPC must not freeze hedging. Exit and let run-hedger.sh restart from the saved state;
      // reconciliation makes the restart safe.
      const watchdog = setTimeout(() => {
        log(`tick exceeded ${TICK_TIMEOUT_MS} ms; exiting for a clean restart`);
        process.exit(1);
      }, TICK_TIMEOUT_MS);
      const s = await sync.tick().finally(() => clearTimeout(watchdog));
      saveState(s);
      const groups = Object.values(s.groups);
      const summary = `${Object.keys(s.positions).length} hedged position(s), ${groups.length} group(s)${groups.length ? ": " + groups.map((g) => `${g.market}@${g.subaccount.slice(0, 8)} ${g.status} ${g.actual}/${g.target}`).join(", ") : ""}`;
      // Log on change, and as a heartbeat every 20 ticks.
      if (summary !== lastSummary || ++quietTicks >= 20) {
        log(`tick: ${summary}`);
        lastSummary = summary;
        quietTicks = 0;
      }
    } catch (e) {
      log(`tick failed: ${errMsg(e)}`);
    }
    if (flags.once) break;
    const wait = Math.max(0, INTERVAL_SECS * 1000 - (Date.now() - started));
    for (let t = 0; t < wait && !stopping; t += 500) await new Promise((r) => setTimeout(r, Math.min(500, wait - t)));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
