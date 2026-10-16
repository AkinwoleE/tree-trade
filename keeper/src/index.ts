import "./env";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Account, AccountAddress, Aptos, AptosConfig, Network, type InputEntryFunctionData } from "@aptos-labs/ts-sdk";
import { ENTRY, MARKETS, MARKET_SYMBOLS, MODULE_ADDR, PRICE_DECIMALS, VIEW, fn } from "../../web/src/config/contract";
import { defaultMedianSource, type Prices } from "../../web/src/lib/prices";
import { fromUnits, isLiquidatable, liqPrice, pnl, toUnits, type Position } from "../../web/src/lib/positions";
import { USDC_DECIMALS, marketSymbol } from "../../web/src/config/contract";
import { botsApiKey, countingClient, decibelApiKey, startUsageLog } from "./usage";
import { loadKeeperAccount } from "./signer";

const { values: flags } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    once: { type: "boolean", default: false },
    interval: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (flags.help) {
  console.log(`Tree Trade keeper

  --dry-run        fetch prices and scan positions, log what would be sent, submit nothing
  --once           run a single iteration and exit
  --interval <s>   seconds between iterations (default PUSH_INTERVAL_SECS or 10)

  Usage reduction (2026-10-16): prices are pushed only on a move >= PUSH_MOVE_BPS (default 10)
  or every PUSH_MAX_AGE_SECS (default 30); open positions come from one batched view
  (exchange::open_positions) every SCAN_SECS (default 20, every tick when one is near liquidation);
  liquidation is computed locally and confirmed on chain (simulation) only when crossed.
`);
  process.exit(0);
}

const DRY_RUN = flags["dry-run"]!;
const INTERVAL_SECS = Number(flags.interval ?? process.env.PUSH_INTERVAL_SECS ?? 10);
const TICK_TIMEOUT_MS = Number(process.env.KEEPER_TICK_TIMEOUT_MS ?? 90_000);

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

// Prefer public fullnode: Geomi org MonthlyCredit is exhausted; anonymous api.testnet IP limits starve price pushes.
const FULLNODE = process.env.APTOS_FULLNODE || "https://fullnode.testnet.aptoslabs.com/v1";
// Keeper chain traffic stays on the free anonymous public node (Plankton, 2026-10-16); KEEPER_APTOS_API_KEY=none.
// The hedger shares this .env but reads botsApiKey() directly, so it stays keyed.
const API_KEY = process.env.KEEPER_APTOS_API_KEY === "none" ? undefined : botsApiKey();
const aptos = new Aptos(
  new AptosConfig({
    network: Network.TESTNET,
    fullnode: FULLNODE,
    client: countingClient(),
    clientConfig: API_KEY ? { API_KEY } : undefined,
  }),
);

const decibelKey = decibelApiKey();
// Deviation-checked multi-source median, shared with /api/price-sig (ORACLE_RISK.md fix 1).
const prices = defaultMedianSource({ decibelKey, pythKey: process.env.PYTH_API_KEY, pythBase: process.env.PYTH_HERMES_URL, decibelMinIntervalMs: Number(process.env.DECIBEL_MIN_INTERVAL_SECS ?? 30) * 1000 });

const { account, from } = loadKeeperAccount();

/** ts-sdk v7 raised the default max_gas_amount to 2,000,000 (2 APT reserved per tx); keep v5's 200,000. */
const MAX_GAS = 200_000;
const GAS_UNIT_PRICE = Number(process.env.GAS_UNIT_PRICE || 100);

/** Rate-limited (429) requests are retried briefly: a liquidation window can close within seconds. */
async function withRetry<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries || !/429|Too Many Requests/.test(errMsg(e))) throw e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Light transaction path: local sequence number + chain clock          */
/* ------------------------------------------------------------------ */
// Building with an explicit sequence number and gas price makes build.simple fully local on testnet
// (chain id is static, the entry ABI is memoized by the SDK), so a push is submit + one wait.
let seq: bigint | undefined;
/** chain time (µs) minus local time (µs), refreshed from every committed tx timestamp. */
let clockOffsetUs: bigint | undefined;

async function ensureSeqAndClock(signer: Account) {
  if (seq === undefined) seq = BigInt((await aptos.getAccountInfo({ accountAddress: signer.accountAddress })).sequence_number);
  if (clockOffsetUs === undefined) {
    const ledger = await aptos.getLedgerInfo();
    clockOffsetUs = BigInt(ledger.ledger_timestamp) - BigInt(Date.now()) * 1000n;
  }
}
/** Chain-clock seconds, 1 s behind to stay <= ledger time (publish_time must not be ahead of chain time). */
const chainNowSecs = () => (BigInt(Date.now()) * 1000n + (clockOffsetUs ?? 0n)) / 1_000_000n - 1n;

async function build(signer: Account, data: InputEntryFunctionData) {
  await ensureSeqAndClock(signer);
  return aptos.transaction.build.simple({
    sender: signer.accountAddress,
    data,
    options: { maxGasAmount: MAX_GAS, gasUnitPrice: GAS_UNIT_PRICE, accountSequenceNumber: seq! },
  });
}

async function submit(signer: Account, data: InputEntryFunctionData): Promise<string> {
  let pending;
  try {
    const txn = await build(signer, data);
    pending = await withRetry(() => aptos.signAndSubmitTransaction({ signer, transaction: txn }));
    seq = seq! + 1n;
  } catch (e) {
    seq = undefined; // stale/duplicate sequence number etc.: re-read it next time
    throw e;
  }
  try {
    const res = await aptos.waitForTransaction({ transactionHash: pending.hash, options: { checkSuccess: true, timeoutSecs: 20 } });
    if ("timestamp" in res) clockOffsetUs = BigInt(res.timestamp) - BigInt(Date.now()) * 1000n;
    return res.hash;
  } catch (e) {
    // Committed-but-aborted keeps the sequence number; a timeout may not have — re-read to be safe.
    if (!/abort|EXECUTION_FAILURE|Move abort/i.test(errMsg(e))) seq = undefined;
    throw e;
  }
}

/** Simulate first so we never pay gas for a liquidation the contract would reject. */
async function simulate(signer: Account, data: InputEntryFunctionData): Promise<{ ok: boolean; status: string }> {
  const txn = await build(signer, data);
  const [res] = await withRetry(() => aptos.transaction.simulate.simple({ signerPublicKey: signer.publicKey, transaction: txn }));
  return { ok: res.success, status: res.vm_status };
}

const PUSH_MOVE_BPS = Number(process.env.PUSH_MOVE_BPS ?? 10);
/** On-chain max_staleness is 60 s (opens/closes carry their own signed price; liquidations need this one). */
const PUSH_MAX_AGE_SECS = Number(process.env.PUSH_MAX_AGE_SECS ?? 30);
let lastPushAt = 0;

function needsPush(p: Prices, force: boolean): string | undefined {
  if (force) return "liquidation";
  if (!lastPushAt) return "first";
  if (Date.now() - lastPushAt >= PUSH_MAX_AGE_SECS * 1000) return "age";
  const moved = MARKET_SYMBOLS.find((s) => lastPushed[s] && Math.abs(p[s]! / lastPushed[s]! - 1) * 10_000 >= PUSH_MOVE_BPS);
  return moved ? `${moved} moved` : undefined;
}

async function pushPrices(p: Prices, why: string) {
  if (account) await ensureSeqAndClock(account);
  const publishTime = chainNowSecs();
  const raw = MARKET_SYMBOLS.map((s) => toUnits(p[s]!, PRICE_DECIMALS));
  const data: InputEntryFunctionData = { function: fn(ENTRY.pushPrices), functionArguments: [...raw, publishTime] };
  if (DRY_RUN || !account) {
    log(`[dry-run] ${ENTRY.pushPrices}(${raw.join(", ")}, ${publishTime}) (${why})`);
    return;
  }
  const hash = await submit(account, data);
  lastPushAt = Date.now();
  log(`pushed prices (${why}) tx=${hash}`);
}

/* ------------------------------------------------------------------ */
/* Open positions: one batched view, local liquidation math            */
/* ------------------------------------------------------------------ */
// exchange::open_positions(start_id, max_ids) walks position ids from the lowest still-open id
// (the cursor) to next_position_id and returns every open position with its on-chain liquidation
// price, so one view replaces the old indexer trader discovery + user_positions/get_position/
// is_liquidatable per trader and per position.
const SCAN_SECS = Number(process.env.SCAN_SECS ?? 20);
const SCAN_PAGE = 500;
/** Within this distance of the liquidation price a position is "near": rescan every tick. */
const NEAR_BPS = Number(process.env.NEAR_LIQ_BPS ?? 100);
let open = new Map<string, Position>();
let cursor = 0;
let lastScanAt = 0;
let lastScanLog = "";

// The hedger reads this snapshot instead of polling the chain itself (one open_positions scan serves both bots).
// It falls back to its own open_positions view when the snapshot is stale.
interface OpenSnapshotRow { id: string; owner: string; market: number; isLong: boolean; notional: string; entry: string }
const OPEN_SNAPSHOT = process.env.OPEN_SNAPSHOT_PATH ?? path.join(import.meta.dirname, "../open-positions.json");
function writeOpenSnapshot(rows: OpenSnapshotRow[], nextPositionId: number) {
  try {
    const tmp = `${OPEN_SNAPSHOT}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), from: cursor, nextPositionId, positions: rows }));
    fs.renameSync(tmp, OPEN_SNAPSHOT);
  } catch (e) {
    log(`open snapshot write failed: ${errMsg(e)}`);
  }
}

async function refreshOpenPositions() {
  const next = new Map<string, Position>();
  const raw: OpenSnapshotRow[] = [];
  let start = cursor;
  for (;;) {
    const r = await withRetry(() => aptos.view({ payload: { function: fn(VIEW.openPositions), functionArguments: [start, SCAN_PAGE] } }));
    const [ids, owners, marketsHex, longs, margins, levs, nots, entries, opened, liqs, nextScan, total] = r as [
      string[], string[], string, boolean[], string[], string[], string[], string[], string[], string[], string, string,
    ];
    const markets = Buffer.from(String(marketsHex).replace(/^0x/, ""), "hex");
    ids.forEach((id, i) => {
      const market = markets[i];
      raw.push({ id: String(id), owner: owners[i], market, isLong: longs[i], notional: String(nots[i]), entry: String(entries[i]) });
      next.set(String(id), {
        id: String(id),
        owner: owners[i],
        market,
        symbol: marketSymbol(market),
        isLong: longs[i],
        margin: fromUnits(margins[i], USDC_DECIMALS),
        leverage: Number(levs[i]),
        notional: fromUnits(nots[i], USDC_DECIMALS),
        entryPrice: fromUnits(entries[i], PRICE_DECIMALS),
        openedAt: Number(opened[i]),
        liqPrice: fromUnits(liqs[i], PRICE_DECIMALS),
      });
    });
    start = Number(nextScan);
    if (start >= Number(total)) break;
  }
  open = next;
  writeOpenSnapshot(raw, Number(start));
  // Ids are never reused, so everything below the lowest open id stays closed.
  cursor = next.size ? Math.min(...[...next.keys()].map(Number)) : start;
  lastScanAt = Date.now();
}

const distBps = (pos: Position, mark: number) => {
  const l = liqPrice(pos);
  return l ? ((pos.isLong ? mark - l : l - mark) / mark) * 10_000 : Infinity;
};
const anyNear = (p: Prices) => [...open.values()].some((pos) => pos.symbol && p[pos.symbol] && distBps(pos, p[pos.symbol]!) < NEAR_BPS);

/** Refresh when due, then return locally-liquidatable positions (no chain calls besides the one view). */
async function scan(p: Prices): Promise<Position[]> {
  if (Date.now() - lastScanAt >= SCAN_SECS * 1000 || anyNear(p)) {
    try {
      await refreshOpenPositions();
    } catch (e) {
      log(`scan: open_positions failed: ${errMsg(e)} (using last known ${open.size})`);
    }
  }
  const crossed = [...open.values()].filter((pos) => pos.symbol && p[pos.symbol] !== undefined && isLiquidatable(pos, p[pos.symbol]!));
  const line = `scan: ${open.size} open position(s) from id ${cursor}, ${crossed.length} liquidatable (local)`;
  if (line !== lastScanLog || crossed.length) log(line);
  lastScanLog = line;
  return crossed;
}

async function liquidate(candidates: Position[], p: Prices) {
  for (const pos of candidates) {
    const mark = pos.symbol ? p[pos.symbol] : undefined;
    const desc =
      `#${pos.id} ${pos.owner} ${pos.isLong ? "LONG" : "SHORT"} ${pos.symbol} ${pos.leverage}x ` +
      `entry=${pos.entryPrice} mark=${mark} liq≈${liqPrice(pos).toFixed(2)} pnl=${mark ? pnl(pos, mark).toFixed(2) : "?"}`;
    const data: InputEntryFunctionData = { function: fn(ENTRY.liquidate), functionArguments: [BigInt(pos.id)] };
    if (!account) {
      log(`[dry-run] would liquidate ${desc} (no key, not simulated)`);
      continue;
    }
    try {
      const sim = await simulate(account, data); // the on-chain check, only for locally-crossed positions
      if (DRY_RUN) {
        log(`[dry-run] would liquidate ${desc} — simulation: ${sim.status}`);
        continue;
      }
      if (!sim.ok) {
        log(`skip ${desc} — simulation: ${sim.status}`);
        continue;
      }
      const hash = await submit(account, data);
      open.delete(pos.id);
      log(`liquidated ${desc} tx=${hash}`);
    } catch (e) {
      log(`liquidate ${desc} failed: ${errMsg(e)}`);
    }
  }
}

const MAX_JUMP = Number(process.env.MAX_PRICE_JUMP ?? 0.02);
let lastPushed: Prices = {};
let pendingJump: Prices | undefined;
const OI_EVERY_SECS = Number(process.env.OI_EVERY_SECS ?? 120);
let lastOiAt = 0;
async function tick() {
  let quote;
  try {
    quote = await prices.fetch();
  } catch (e) {
    log(`prices: ${errMsg(e)}`);
    return;
  }
  // Outlier guard (REVIEW H-4): a single bad print (or a venue switch) must not instantly liquidate 1000x
  // positions. A move > MAX_JUMP vs the last push is only pushed once a second tick confirms it.
  const jump = MARKET_SYMBOLS.find((s) => lastPushed[s] && Math.abs(quote.prices[s]! / lastPushed[s]! - 1) > MAX_JUMP);
  if (jump) {
    const confirmed = pendingJump && MARKET_SYMBOLS.every((s) => Math.abs(quote.prices[s]! / pendingJump![s]! - 1) < MAX_JUMP / 4);
    if (!confirmed) {
      log(`prices: ${jump} moved >${MAX_JUMP * 100}% vs last push (${lastPushed[jump]} -> ${quote.prices[jump]}); waiting for confirmation`);
      pendingJump = quote.prices;
      if (lastPushed.BTC) await liquidate(await scan(lastPushed), lastPushed);
      return;
    }
  }
  pendingJump = undefined;
  const candidates = await scan(quote.prices);
  // Liquidations read the stored oracle price, so push it first whenever a position has crossed.
  const why = needsPush(quote.prices, candidates.length > 0);
  if (why) {
    log(`prices via ${quote.source}: ${MARKET_SYMBOLS.map((s) => `${s}=${quote.prices[s]}`).join(" ")}${Object.keys(quote.rejected).length ? ` rejected=${JSON.stringify(quote.rejected)}` : ""}`);
    try {
      await pushPrices(quote.prices, why);
      lastPushed = quote.prices;
    } catch (e) {
      log(`push_prices failed: ${errMsg(e)}`);
    }
  }
  if (candidates.length) await liquidate(candidates, quote.prices);
  if (Date.now() - lastOiAt >= OI_EVERY_SECS * 1000) {
    lastOiAt = Date.now();
    try {
      await trailOiCaps(quote.prices);
    } catch (e) {
      log(`oi caps: ${errMsg(e)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Trailing per-side OI caps (Paper Trade #/how/risk)                   */
/* ------------------------------------------------------------------ */
// Each side independently: target cap = current OI qty + qty worth OI_HEADROOM_USD (default
// $1B) at the current price. Leave the cap alone while headroom is within +/-10% of the target
// ($900M-$1.1B); otherwise rebuild it to the target.
// Sized to book depth, not $1B (ORACLE_RISK.md fix 5).
const OI_HEADROOM_USD = Number(process.env.OI_HEADROOM_USD || 7_500_000);
const OI_BAND = 0.1;
// On chain the keeper's caps lapse to the default oi_caps after 900s without an update (V4), so
// re-send them at least this often even when unchanged.
const CAPS_HEARTBEAT_MS = Number(process.env.CAPS_HEARTBEAT_SECS || 300) * 1000;
const capsSentAt = new Map<string, number>();
async function trailOiCaps(p: Prices) {
  if (!account || DRY_RUN) return;
  for (const s of MARKET_SYMBOLS) {
    const px = p[s];
    if (!px) continue;
    const [lq, sq, lc, sc] = (await aptos.view({ payload: { function: fn(VIEW.sideOi), functionArguments: [MARKETS[s]] } })).map((x) => BigInt(String(x)));
    const head = BigInt(Math.round((OI_HEADROOM_USD / px) * 1e8)); // 1e-8 asset units
    const lo = (head * BigInt(Math.round((1 - OI_BAND) * 1000))) / 1000n;
    const hi = (head * BigInt(Math.round((1 + OI_BAND) * 1000))) / 1000n;
    const fix = (oi: bigint, cap: bigint) => { const h = cap - oi; return h < lo || h > hi ? oi + head : cap; };
    const nl = fix(lq, lc), ns = fix(sq, sc);
    if (nl === lc && ns === sc && Date.now() - (capsSentAt.get(s) ?? 0) < CAPS_HEARTBEAT_MS) continue;
    const hash = await submit(account, { function: fn(ENTRY.setSideCaps), functionArguments: [MARKETS[s], nl, ns] });
    capsSentAt.set(s, Date.now());
    log(`oi caps ${s}: long ${lc}->${nl} short ${sc}->${ns} (qty 1e-8, headroom $${OI_HEADROOM_USD}) tx=${hash}`);
  }
}

async function main() {
  log(`keeper starting — module=${MODULE_ADDR} interval=${INTERVAL_SECS}s dry-run=${DRY_RUN}`);
  log(`signer: ${account ? `${account.accountAddress.toString()} (from ${from})` : "none"}`);
  log(`price sources: median(${prices.names.join(", ")}), max deviation 0.3%, min 2`);
  log(`push on ${PUSH_MOVE_BPS}bp move or every ${PUSH_MAX_AGE_SECS}s; scan every ${SCAN_SECS}s (each tick when <${NEAR_BPS}bp from liq); oi caps every ${OI_EVERY_SECS}s; bots key=${API_KEY ? "set" : "unset"}`);
  startUsageLog("keeper");
  if (MODULE_ADDR === "0x0") log("WARNING: MODULE_ADDR not set");
  // AUDIT decision 3: the keeper runs on its own role key, never the package admin key.
  if (account && AccountAddress.from(MODULE_ADDR).equals(account.accountAddress) && process.env.ALLOW_ADMIN_KEEPER !== "1") {
    console.error("Refusing to start: KEEPER key is the package admin. Use the dedicated keeper role key.");
    process.exit(1);
  }
  if (!account && !DRY_RUN) {
    console.error("No keeper key found (set KEEPER_PRIVATE_KEY or APTOS_PROFILE). Use --dry-run to run without one.");
    process.exit(1);
  }

  let stopping = false;
  process.on("SIGINT", () => {
    log("stopping…");
    stopping = true;
  });

  while (!stopping) {
    const started = Date.now();
    // Watchdog: a hung RPC (e.g. a dead socket after the box is paused) must not freeze price pushes —
    // the oracle rejects prices older than 60s, so a stuck keeper blocks every trade. Exit and let run.sh restart.
    const watchdog = setTimeout(() => {
      log(`tick exceeded ${TICK_TIMEOUT_MS} ms; exiting for a clean restart`);
      process.exit(1);
    }, TICK_TIMEOUT_MS);
    await tick().finally(() => clearTimeout(watchdog));
    if (flags.once) break;
    const wait = Math.max(0, INTERVAL_SECS * 1000 - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
