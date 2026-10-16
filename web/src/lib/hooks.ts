"use client";
import { visibleInterval } from "@/lib/visible-interval";
import { TX_EVENT } from "@/lib/activity-decode";
import { retry429 } from "@/lib/retry";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import type { CommittedTransactionResponse, MoveValue } from "@aptos-labs/ts-sdk";
import { Hex } from "@aptos-labs/ts-sdk";
import {
  ENTRY,
  MARKETS,
  MARKET_SYMBOLS,
  PAPER_DECIMALS,
  PRICE_DECIMALS,
  USDC_DECIMALS,
  VIEW,
  fn,
  type MarketSymbol,
} from "@/config/contract";
import { type PriceQuote } from "@/lib/prices";
import { decodePosition, fromUnits, type Position } from "@/lib/positions";
import { aptos, explorerTx, view } from "@/lib/chain";
import { loadSession, clearSession, sessionAccount, type Session } from "@/lib/session";

/** Live prices from our server route (Decibel when a key is configured, else a public market feed). */
/** Fallback poll only: the app streams prices over SSE (/api/stream); this runs only while the stream is stale. */
export function usePrices(intervalMs = 15_000, enabled = true) {
  const source = useMemo(
    () => ({
      fetch: async (): Promise<PriceQuote> => {
        const r = await fetch("/api/prices", { cache: "no-store" });
        const j = await r.json();
        if (!r.ok || !j.prices) throw new Error(j.error || "price feed unavailable");
        return j as PriceQuote;
      },
    }),
    [],
  );
  const [quote, setQuote] = useState<PriceQuote>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const q = await source.fetch();
        if (alive) {
          setQuote(q);
          setError(undefined);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    if (!enabled) return;
    tick();
    const stop = visibleInterval(tick, intervalMs);
    return () => {
      alive = false;
      stop();
    };
  }, [source, intervalMs, enabled]);

  return { quote, error };
}

export interface AccountData {
  usdc?: number;
  /** seconds until the faucet can be used again */
  faucetCooldown?: number;
  /** exchange trading balance (free collateral), USDC */
  collateral?: number;
  positions: Position[];
  paper?: number;
  staked?: number;
  /** claimable staking rewards, USDC */
  pending?: number;
  /** unpaid winnings waiting in the payout queue (spendable as margin) */
  queued?: { total: number; firstIndex?: number; ahead: number; entries: number };
}

export interface OracleQuote {
  price: number;
  publishTime: number;
}

export interface QueueRow {
  index: number;
  owner: string;
  positionId: string;
  original: number;
  remaining: number;
}

export interface PoolData {
  faucetAmount?: number;
  paused?: boolean;
  oracle: Partial<Record<MarketSymbol, OracleQuote>>;
  maxStaleness?: number;
  /** [vault, total trading balances, total locked margin, pool, dev fees] USDC */
  accounting?: number[];
  openInterest: Partial<Record<MarketSymbol, { long: number; short: number; cap: number }>>;
  /** [to stakers, to dev] USDC */
  feeStats?: number[];
  queue?: { head: number; tail: number; owed: number; rows: QueueRow[] };
  /** tracked LP = LP cash - queue - debt-funded margin (signed), SEEDS per $1 */
  trackedLp?: number;
  seedsRate?: number;
  debtMargin?: number;
  /** per-side OI and caps in asset units (BTC/ETH) */
  sideOi: Partial<Record<MarketSymbol, { long: number; short: number; longCap: number; shortCap: number }>>;
  paperSupply?: number;
  paperStaked?: number;
  /** [total deposited, total claimed, vault balance] USDC */
  rewards?: number[];
}

/** How many payout-queue entries the UI loads. */
const QUEUE_PAGE = 25;

/** Polls all on-chain state the UI needs. `refresh()` forces an immediate reload. */
export function useChainData(address: string | undefined, intervalMs = 15_000) {
  const [account, setAccount] = useState<AccountData>({ positions: [] });
  const [pool, setPool] = useState<PoolData>({ oracle: {}, openInterest: {}, sideOi: {} });
  const [errors, setErrors] = useState<string[]>([]);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    const errs: string[] = [];
    const v = async (label: string, fid: string, args: (string | number)[] = []) => {
      try {
        return await view(fid, args);
      } catch (e) {
        errs.push(`${label}: ${(e as Error).message.split("\n")[0].slice(0, 160)}`);
        return undefined;
      }
    };
    const usdc = (x: MoveValue | undefined) => fromUnits(x, USDC_DECIMALS);

    const [faucetCfg, paused, maxStale, acct, fees, qs, supply, totStaked, rewards, oracle, oi] = await Promise.all([
      v("faucet_config", VIEW.faucetConfig),
      v("is_paused", VIEW.isPaused),
      v("max_staleness", VIEW.maxStaleness),
      v("accounting", VIEW.accounting),
      v("fee_stats", VIEW.feeStats),
      v("queue_state", VIEW.queueState),
      v("SEEDS supply", VIEW.paperTotalSupply),
      v("SEEDS staked", VIEW.paperTotalStaked),
      v("reward_stats", VIEW.rewardStats),
      Promise.all(MARKET_SYMBOLS.map((s) => v(`price_info ${s}`, VIEW.priceInfo, [MARKETS[s]]))),
      Promise.all(MARKET_SYMBOLS.map((s) => v(`open_interest ${s}`, VIEW.openInterest, [MARKETS[s]]))),
    ]);
    const [sr, v2s, so] = await Promise.all([
      v("seeds_rate", VIEW.seedsRate),
      v("v2_state", VIEW.v2State),
      Promise.all(MARKET_SYMBOLS.map((s) => v(`side_oi ${s}`, VIEW.sideOi, [MARKETS[s]]))),
    ]);

    let queue: PoolData["queue"];
    if (qs) {
      const head = Number(qs[0]);
      const tail = Number(qs[1]);
      const idx = Array.from({ length: Math.min(tail - head, QUEUE_PAGE) }, (_, i) => head + i);
      const rows = await Promise.all(idx.map((i) => v(`queue_entry ${i}`, VIEW.queueEntry, [i])));
      queue = {
        head,
        tail,
        owed: usdc(qs[2]),
        rows: rows.flatMap((r, i) =>
          r
            ? [{ index: idx[i], owner: String(r[0]), positionId: String(r[1]), original: usdc(r[2]), remaining: usdc(r[3]) }]
            : [],
        ),
      };
    }

    const nextPool: PoolData = {
      faucetAmount: faucetCfg ? usdc(faucetCfg[0]) : undefined,
      paused: paused ? paused[0] === true : undefined,
      maxStaleness: maxStale ? Number(maxStale[0]) : undefined,
      accounting: acct?.map(usdc),
      feeStats: fees?.map(usdc),
      queue,
      paperSupply: supply ? fromUnits(supply[0], PAPER_DECIMALS) : undefined,
      paperStaked: totStaked ? fromUnits(totStaked[0], PAPER_DECIMALS) : undefined,
      rewards: rewards?.map(usdc),
      oracle: {},
      openInterest: {},
      trackedLp: sr ? usdc(sr[0]) * (sr[1] === true ? -1 : 1) : undefined,
      seedsRate: sr ? Number(sr[2]) / 1e6 : undefined,
      debtMargin: v2s ? usdc(v2s[0]) : undefined,
      sideOi: {},
    };
    const qty = (x: MoveValue) => Number(BigInt(String(x))) / 1e8;
    MARKET_SYMBOLS.forEach((s, i) => {
      const x = so[i];
      if (x) nextPool.sideOi[s] = { long: qty(x[0]), short: qty(x[1]), longCap: qty(x[2]), shortCap: qty(x[3]) };
    });
    MARKET_SYMBOLS.forEach((s, i) => {
      const o = oracle[i];
      if (o) nextPool.oracle[s] = { price: fromUnits(o[0], PRICE_DECIMALS), publishTime: Number(o[1]) };
      const x = oi[i];
      if (x) nextPool.openInterest[s] = { long: usdc(x[0]), short: usdc(x[1]), cap: usdc(x[2]) };
    });

    let nextAccount: AccountData = { positions: [] };
    if (address) {
      const [bal, cooldown, coll, ids, paper, staked, pending] = await Promise.all([
        v("usdc balance", VIEW.usdcBalance, [address]),
        v("faucet cooldown", VIEW.faucetCooldown, [address]),
        v("trading balance", VIEW.tradingBalance, [address]),
        v("user_positions", VIEW.userPositions, [address]),
        v("SEEDS balance", VIEW.paperBalance, [address]),
        v("staked", VIEW.staked, [address]),
        v("pending rewards", VIEW.pendingRewards, [address]),
      ]);
      const qb = await v("queued balance", VIEW.queuedBalanceOf, [address]);
      const posIds = ((ids?.[0] as string[] | undefined) ?? []).map(String);
      const positions = await Promise.all(
        posIds.map(async (pid) => {
          const [t, liq] = await Promise.all([
            v(`position ${pid}`, VIEW.getPosition, [pid]),
            v(`liquidation_price ${pid}`, VIEW.liquidationPrice, [pid]),
          ]);
          if (!t) return null;
          const p = decodePosition(pid, t);
          if (liq) p.liqPrice = fromUnits(liq[0], PRICE_DECIMALS);
          return p;
        }),
      );
      nextAccount = {
        usdc: bal ? usdc(bal[0]) : undefined,
        faucetCooldown: cooldown ? Number(cooldown[0]) : undefined,
        collateral: coll ? usdc(coll[0]) : undefined,
        positions: positions.filter((p): p is Position => p !== null),
        paper: paper ? fromUnits(paper[0], PAPER_DECIMALS) : undefined,
        staked: staked ? fromUnits(staked[0], PAPER_DECIMALS) : undefined,
        pending: pending ? usdc(pending[0]) : undefined,
        queued: qb
          ? { total: usdc(qb[0]), firstIndex: Number(qb[3]) > 0 ? Number(qb[1]) : undefined, ahead: usdc(qb[2]), entries: Number(qb[3]) }
          : undefined,
      };
    }

    if (id !== reqId.current) return; // a newer load started
    setPool(nextPool);
    setAccount(nextAccount);
    setErrors(errs);
  }, [address]);

  useEffect(() => {
    load();
    return visibleInterval(load, intervalMs);
  }, [load, intervalMs]);

  return { account, pool, errors, refresh: load };
}

export type Submit = (
  label: string,
  entry: (typeof ENTRY)[keyof typeof ENTRY],
  args: (string | number | boolean | bigint | null)[],
) => void;

/** Submit any entry function by full id (e.g. Decibel's); resolves to the committed txn, or undefined on failure. */
export type SubmitFn = (
  label: string,
  functionId: `${string}::${string}::${string}`,
  args: (string | number | boolean | bigint | null)[],
) => Promise<CommittedTransactionResponse | undefined>;

export interface TxState {
  pending?: string;
  last?: { ok: boolean; msg: string; hash?: string; url?: string };
}

/**
 * Submit through the connected wallet and wait (aptos.dev/build/sdks/wallet-adapter/dapp, signAndSubmitTransaction):
 * useWallet().signAndSubmitTransaction, then aptos.waitForTransaction.
 */
export class SponsorUnavailable extends Error {}

/** POST to /api/sponsor; on 429 (shared node limit or our burst limit) retry with backoff + jitter (lib/retry). */
async function postSponsor(txBytes: Uint8Array, authBytes: Uint8Array) {
  const body = JSON.stringify({ transaction: Hex.fromHexInput(txBytes).toString(), senderAuthenticator: Hex.fromHexInput(authBytes).toString() });
  return retry429(
    async () => {
      const r = await fetch("/api/sponsor", { method: "POST", headers: { "content-type": "application/json" }, body });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) throw Object.assign(new Error(j.error ?? "sponsor 429"), { status: 429 });
      return { r, j };
    },
    { attempts: 3, budgetMs: 3000 },
  );
}

type SignTx = ReturnType<typeof useWallet>["signTransaction"];
async function submitSponsored(sender: string, functionId: string, functionArguments: unknown[], signTransaction: SignTx): Promise<{ hash: string }> {
  if (process.env.NEXT_PUBLIC_SPONSOR !== "1") throw new SponsorUnavailable("off");
  const transaction = await aptos.transaction.build.simple({
    sender,
    withFeePayer: true,
    data: { function: functionId as `${string}::${string}::${string}`, functionArguments: functionArguments as never[] },
    // Decibel's one-shot onboarding (create + deposit + delegate) uses ~30k gas units.
    options: { maxGasAmount: functionId.endsWith("::add_delegated_trader_and_deposit_to_subaccount") ? 60_000 : 20_000 },
  });
  const { authenticator } = await signTransaction({ transactionOrPayload: transaction });
  const { r, j } = await postSponsor(transaction.bcsToBytes(), authenticator.bcsToBytes());
  if (r.status === 503) throw new SponsorUnavailable("disabled");
  if (!r.ok || !j.hash) throw new Error(j.error ?? `sponsor ${r.status}`);
  return { hash: j.hash };
}

/** Delegate-signed (no wallet popup) submit for open/close when 1-click trading is enabled. */
const DELEGATE_MAP: Record<string, string> = {
  [ENTRY.openPosition]: ENTRY.openPositionAsDelegatePx,
  [ENTRY.closePosition]: ENTRY.closePositionAsDelegatePx,
  [ENTRY.openFromQueue]: ENTRY.openFromQueueAsDelegatePx,
  [ENTRY.openPositionHedged]: ENTRY.openPositionHedgedAsDelegatePx,
};
/** Owner-signed signed-price variants (V4: every open/close carries a fresh signed price). */
const PX_MAP: Record<string, string> = {
  [ENTRY.openPosition]: ENTRY.openPositionPx,
  [ENTRY.closePosition]: ENTRY.closePositionPx,
  [ENTRY.openFromQueue]: ENTRY.openFromQueuePx,
  [ENTRY.openPositionHedged]: ENTRY.openPositionHedgedPx,
};
/** Fetch a fresh signed price; returns the three extra entry args. */
async function signedPriceArgs(entry: string, args: unknown[]): Promise<unknown[]> {
  let market: number;
  if (entry === ENTRY.closePosition) {
    const pos = await aptos.view({ payload: { function: fn(VIEW.getPosition), functionArguments: [String(args[0])] } });
    market = Number(pos[1]);
  } else market = Number(args[0]);
  const r = await fetch(`/api/price-sig?market=${market}`, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.signature) throw new Error(j.error ?? `price ${r.status}`);
  // vector<u8>: pass bytes (a hex string would be encoded as UTF-8).
  return [j.price, j.publishTime, Hex.fromHexInput(j.signature).toUint8Array()];
}
/**
 * Session keys created before scoped delegation (or with "Allow hedged opens" unticked) cannot open
 * hedged / queue-funded positions: the chain aborts with E_SCOPE_DENIED after the tx is committed.
 * Check the on-chain scope first and use the wallet-signed path when the key lacks it.
 */
async function sessionHasScope(s: Session, entry: string): Promise<boolean> {
  const need = entry === ENTRY.openPositionHedged ? 1 : entry === ENTRY.openFromQueue ? 2 : 0;
  if (!need) return true;
  try {
    const r = await view("exchange::scope_of", [s.owner, s.address]);
    return r[need] === true;
  } catch { return true; } // transient read error: let the delegate path try
}
const PRICE_RETRY = /E_PRICE_TOO_OLD|E_FUTURE_TIMESTAMP|E_PRICE_MOVE_TOO_LARGE|oracle: 0x(11|12|6)\b|sub_status: Some\((17|18|6)\)/;
async function submitAsDelegate(s: Session, entry: string, args: unknown[]): Promise<{ hash: string }> {
  const signer = sessionAccount(s);
  const transaction = await aptos.transaction.build.simple({
    sender: signer.accountAddress,
    withFeePayer: true,
    data: { function: fn(DELEGATE_MAP[entry]), functionArguments: [s.owner, ...args] as never[] },
    options: { maxGasAmount: 20_000 },
  });
  const authenticator = aptos.transaction.sign({ signer, transaction });
  const { r, j } = await postSponsor(transaction.bcsToBytes(), authenticator.bcsToBytes());
  if (!r.ok || !j.hash) throw new Error(j.error ?? `sponsor ${r.status}`);
  return { hash: j.hash };
}

export function useTx(onDone?: () => void) {
  const { signAndSubmitTransaction, signTransaction, account } = useWallet();
  const [state, setState] = useState<TxState>({});

  const submitFn = useCallback<SubmitFn>(
    async (label, functionId, args) => {
      if (!account) return undefined;
      setState((s) => ({ ...s, pending: label }));
      try {
        const fa = args.map((a) => (typeof a === "bigint" ? a.toString() : a));
        let res: { hash: string } | undefined;
        const entry = Object.keys(DELEGATE_MAP).find((e) => fn(e) === functionId);
        const session = entry ? loadSession(account.address.toString()) : null;
        if (entry && session && (await sessionHasScope(session, entry))) {
          try {
            try {
              res = await submitAsDelegate(session, entry, [...fa, ...(await signedPriceArgs(entry, fa))]);
            } catch (e) {
              if (!PRICE_RETRY.test(e instanceof Error ? e.message : String(e))) throw e;
              res = await submitAsDelegate(session, entry, [...fa, ...(await signedPriceArgs(entry, fa))]);
            }
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            // Delegation revoked/expired on-chain (E_NOT_DELEGATE=17 / E_DELEGATION_EXPIRED=18): drop the key and fall back to the wallet.
            if (/E_NOT_DELEGATE|E_DELEGATION_EXPIRED|exchange: 0x1[12]\b|abort_code: 1[78]\b|sub_status: Some\(1[78]\)/.test(m)) clearSession(session.owner);
            else throw e;
          }
        }
        const send = async (fid: string, a: unknown[]) => {
          try {
            // Gas-sponsored path: user signs, our /api/sponsor adds the fee-payer signature.
            // Required for derived Phantom/MetaMask accounts, which start with 0 APT.
            return await submitSponsored(account.address.toString(), fid, a, signTransaction);
          } catch (e) {
            if (!(e instanceof SponsorUnavailable)) throw e;
            // u64s go over as decimal strings: not every wallet can JSON-encode bigint.
            return await signAndSubmitTransaction({ data: { function: fid as `${string}::${string}::${string}`, functionArguments: a as never[] } });
          }
        };
        if (!res) {
          if (entry) {
            const pxFid = fn(PX_MAP[entry]);
            try {
              res = await send(pxFid, [...fa, ...(await signedPriceArgs(entry, fa))]);
            } catch (e) {
              if (!PRICE_RETRY.test(e instanceof Error ? e.message : String(e))) throw e;
              res = await send(pxFid, [...fa, ...(await signedPriceArgs(entry, fa))]);
            }
          } else res = await send(functionId, fa);
        }
        const tx = await aptos.waitForTransaction({ transactionHash: res.hash });
        const ok = "success" in tx ? tx.success : true;
        const vmStatus = "vm_status" in tx ? String(tx.vm_status) : "";
        setState({
          last: { ok, msg: ok ? `${label} confirmed` : `${label} failed: ${vmStatus}`, hash: res.hash, url: explorerTx(res.hash) },
        });
        // Push the confirmed tx's own events to activity views right away (indexer + caches lag by seconds).
        if (ok && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(TX_EVENT, { detail: tx }));
        return ok ? tx : undefined;
      } catch (e) {
        const msg = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
        setState({ last: { ok: false, msg: `${label}: ${msg}` } });
        return undefined;
      } finally {
        onDone?.();
      }
    },
    [account, signAndSubmitTransaction, signTransaction, onDone],
  );

  const submit = useCallback<Submit>((label, entry, args) => void submitFn(label, fn(entry), args), [submitFn]);

  return { ...state, submit, submitFn };
}
