/**
 * Hedge reconciliation. Each tick, for every (Decibel Trading Account, market) group:
 *
 *   target = -(sum of the Tree Trade exposure of the group's open, hedge-requested positions), rounded to lots
 *   actual = the subaccount's on-chain Decibel position
 *   trade only target - actual (IOC, reduce-only when it is a pure reduction)
 *
 * Because the target is recomputed from chain state and compared with the chain position, the loop is
 * idempotent: restarts, duplicate ticks, partial fills and closes or liquidations all converge without
 * per-event bookkeeping. One in-flight order per group at a time prevents double-hedging while Decibel's
 * asynchronous matching is still working on a previous order.
 */
import { DECIBEL_MARKET_FOR, iocPrice, planTrade, positionHedgeSize, targetSize, type HedgedPosition, type MarketSpec } from "../../../web/src/lib/hedge";
import type { DecibelClient } from "./decibel-client";

export interface HedgeRequestRow {
  positionId: string;
  owner: string;
  subaccount: string;
}

/** An open Tree Trade position as read from exchange::get_position. */
export interface TTPosition extends HedgedPosition {
  owner: string;
  /** "BTC" | "ETH" */
  symbol: string;
}

export interface ChainPort {
  /** hedge::active_requests */
  requests(): Promise<HedgeRequestRow[]>;
  /** optional per-tick prefetch (e.g. one exchange::user_positions view per owner) to save RPC budget */
  prefetch?(requests: HedgeRequestRow[]): Promise<void>;
  /** exchange::get_position, or null when the position no longer exists (closed or liquidated) */
  position(id: string): Promise<TTPosition | null>;
  /** hedge::prune, submitted by the hedger */
  prune(id: string): Promise<string>;
}

export type GroupStatus =
  | "in-sync"
  | "pending" // order submitted, waiting for async matching
  | "failed" // last attempt failed; retrying with backoff
  | "not-delegated" // the subaccount has not delegated (or the delegation expired) to the hedger
  | "orphaned" // hedge must be closed but the hedger lost permission: the user must close it on Decibel
  | "dust" // residual below min_size; cannot be closed with a single order
  | "below-min"; // target differs by less than min_size

export interface GroupState {
  subaccount: string;
  owner: string;
  market: string;
  status: GroupStatus;
  target: string;
  actual: string;
  entryPx: string;
  fundingCost: string;
  positionIds: string[];
  pending?: { orderId?: string; clientOrderId: string; txHash: string; placedAt: number; actualBefore: string };
  failures: number;
  cooldownUntil?: number;
  lastError?: string;
  lastTx?: string;
  updatedAt: number;
  /** when the Decibel position was last read (in-sync groups with an unchanged target skip the read until reconcileMs) */
  lastReadAt?: number;
}

export interface PositionHedgeState {
  group: string;
  subaccount: string;
  market: string;
  /** signed size units attributed to this position */
  hedgeSize: string;
  status: GroupStatus | "closed-awaiting-flatten";
  error?: string;
}

export interface HedgeState {
  version: 1;
  mode: "live" | "mock";
  hedger: string;
  updatedAt: number;
  seq: number;
  groups: Record<string, GroupState>;
  positions: Record<string, PositionHedgeState>;
  pruned: string[];
}

export const emptyState = (mode: "live" | "mock", hedger: string): HedgeState => ({
  version: 1,
  mode,
  hedger,
  updatedAt: 0,
  seq: 0,
  groups: {},
  positions: {},
  pruned: [],
});

export interface SyncOptions {
  slippageBps: number;
  /** give up waiting on an order after this long and re-read the position */
  pendingTimeoutMs: number;
  /** how long to treat an order without an order id as in flight */
  noOrderIdWaitMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  now: () => number;
  log: (msg: string) => void;
  /** Called after an order is placed so the in-flight record survives crashes. */
  persist?: (state: HedgeState) => void;
  /** in-sync group with an unchanged target: re-read the Decibel position at most this often (0 = every tick) */
  reconcileMs?: number;
}

export const DEFAULT_SYNC: Omit<SyncOptions, "log"> = {
  slippageBps: 100,
  pendingTimeoutMs: 60_000,
  noOrderIdWaitMs: 20_000,
  baseBackoffMs: 30_000,
  maxBackoffMs: 600_000,
  reconcileMs: 300_000,
  now: () => Date.now(),
};

const short = (a: string) => a.replace(/^0x/, "").slice(0, 6);
const groupKey = (sub: string, market: string) => `${sub}|${market}`;

export class HedgeSync {
  constructor(
    private readonly client: DecibelClient,
    private readonly chain: ChainPort,
    public state: HedgeState,
    private readonly opt: SyncOptions,
  ) {}

  async tick(): Promise<HedgeState> {
    const now = this.opt.now();
    const requests = await this.chain.requests();
    await this.chain.prefetch?.(requests.filter((r) => !this.state.pruned.includes(r.positionId)));

    // Load positions for every request; group by (subaccount, Decibel market).
    interface Group {
      subaccount: string;
      owner: string;
      market: string;
      open: TTPosition[];
      closedIds: string[];
    }
    const groups = new Map<string, Group>();
    const positions: Record<string, PositionHedgeState> = {};
    const ensure = (sub: string, owner: string, market: string) => {
      const k = groupKey(sub, market);
      const g = groups.get(k) ?? { subaccount: sub, owner, market, open: [], closedIds: [] };
      groups.set(k, g);
      return g;
    };
    for (const r of requests) {
      if (this.state.pruned.includes(r.positionId)) continue;
      const pos = await this.chain.position(r.positionId);
      if (pos && pos.owner !== r.owner) {
        this.opt.log(`request #${r.positionId}: owner mismatch (${r.owner} vs ${pos.owner}); ignored`);
        continue;
      }
      if (pos) {
        const market = DECIBEL_MARKET_FOR[pos.symbol];
        if (!market) {
          this.opt.log(`request #${r.positionId}: no Decibel market for ${pos.symbol}; ignored`);
          continue;
        }
        ensure(r.subaccount, r.owner, market).open.push(pos);
        continue;
      }
      // Closed or liquidated. Its market is known if we saw it open; otherwise (state lost) reconcile every
      // market of the subaccount before pruning, so a hedge placed before a restart is never orphaned.
      const known = this.state.positions[r.positionId]?.market;
      for (const m of known ? [known] : Object.values(DECIBEL_MARKET_FOR)) ensure(r.subaccount, r.owner, m).closedIds.push(r.positionId);
    }
    // Groups we traded before but which have no requests left (cancelled or pruned): flatten them.
    for (const gs of Object.values(this.state.groups)) {
      if (BigInt(gs.actual) !== 0n || gs.pending) ensure(gs.subaccount, gs.owner, gs.market);
    }

    const nextGroups: Record<string, GroupState> = {};
    const unsettled = new Set<string>();
    for (const [k, g] of groups) {
      // One group's RPC failure must not discard another group's freshly placed order (REVIEW_2026-10-15 H-5):
      // keep the last known state (incl. any pending order recorded by syncGroup) and retry next tick.
      let gs: GroupState | undefined, settled = false, spec: MarketSpec;
      try {
        ({ gs, settled } = await this.syncGroup(k, g.subaccount, g.owner, g.market, g.open, now));
        spec = await this.client.marketSpec(g.market);
      } catch (e) {
        this.opt.log(`${k}: sync failed, keeping previous state: ${(e as Error).message.slice(0, 160)}`);
        g.closedIds.forEach((id) => unsettled.add(id));
        if (this.state.groups[k]) nextGroups[k] = this.state.groups[k];
        for (const p of g.open) if (this.state.positions[p.id]) positions[p.id] = this.state.positions[p.id];
        continue;
      }
      if (!settled) g.closedIds.forEach((id) => unsettled.add(id));
      if (gs) nextGroups[k] = gs;
      for (const p of g.open)
        positions[p.id] = {
          group: k,
          subaccount: g.subaccount,
          market: g.market,
          hedgeSize: positionHedgeSize(p, spec).toString(),
          status: gs?.status ?? "in-sync",
          error: gs?.lastError,
        };
      for (const id of g.closedIds)
        if (!this.state.pruned.includes(id))
          positions[id] = { group: k, subaccount: g.subaccount, market: g.market, hedgeSize: "0", status: "closed-awaiting-flatten", error: gs?.lastError };
    }
    // A closed position's request is settled on-chain once no group still carries its exposure.
    for (const g of groups.values()) for (const id of g.closedIds) if (!unsettled.has(id)) await this.tryPrune(id);
    for (const id of Object.keys(positions)) if (this.state.pruned.includes(id)) delete positions[id];
    // Forget flat groups with nothing left to hedge.
    for (const [k, gs] of Object.entries(nextGroups))
      if (gs.positionIds.length === 0 && BigInt(gs.actual) === 0n && !gs.pending && gs.status === "in-sync") delete nextGroups[k];
    this.state = { ...this.state, updatedAt: now, groups: nextGroups, positions, pruned: this.state.pruned.slice(-500) };
    return this.state;
  }

  private async syncGroup(
    k: string,
    subaccount: string,
    owner: string,
    market: string,
    open: TTPosition[],
    now: number,
  ): Promise<{ gs: GroupState; settled: boolean }> {
    const spec = await this.client.marketSpec(market);
    const prev = this.state.groups[k];
    const gs: GroupState = {
      subaccount,
      owner,
      market,
      status: prev?.status ?? "in-sync",
      target: "0",
      actual: prev?.actual ?? "0",
      entryPx: prev?.entryPx ?? "0",
      fundingCost: prev?.fundingCost ?? "0",
      positionIds: open.map((p) => p.id),
      pending: prev?.pending,
      failures: prev?.failures ?? 0,
      cooldownUntil: prev?.cooldownUntil,
      lastError: prev?.lastError,
      lastTx: prev?.lastTx,
      updatedAt: now,
    };
    const target = targetSize(open, spec);
    gs.target = target.toString();

    // 1. One order in flight per group: wait for Decibel's async matching to finish with it.
    if (gs.pending) {
      const age = now - gs.pending.placedAt;
      // Without an order id (the SDK can return success without one) we cannot ask the book, so wait a fixed
      // window for async matching before trusting the position again; otherwise we could double-hedge.
      const stillPending = gs.pending.orderId
        ? await this.client.orderPending(spec, gs.pending.orderId).catch(() => true)
        : age < this.opt.noOrderIdWaitMs;
      if (stillPending && age < this.opt.pendingTimeoutMs) {
        gs.status = "pending";
        return { gs, settled: false };
      }
      if (stillPending) this.opt.log(`${k}: order ${gs.pending.orderId} still pending after ${age} ms; re-reading position`);
    }

    // Nothing changed since the last read (no order in flight, still in sync, same target): skip the Decibel reads.
    // A full reconcile every reconcileMs still catches changes made outside the hedger (manual close, Decibel liquidation).
    if (
      !gs.pending && prev && prev.status === "in-sync" && prev.target === gs.target && BigInt(prev.actual) === target &&
      prev.lastReadAt !== undefined && now - prev.lastReadAt < (this.opt.reconcileMs ?? 0)
    ) {
      gs.lastReadAt = prev.lastReadAt;
      return { gs, settled: true };
    }
    const pos = await this.client.position(subaccount, spec);
    gs.lastReadAt = now;
    const actual = pos.size;
    gs.actual = actual.toString();
    gs.entryPx = pos.entryPx.toString();
    gs.fundingCost = pos.fundingCost.toString();

    if (gs.pending) {
      // IOC finished. No movement at all means nothing filled within the slippage band.
      if (actual === BigInt(gs.pending.actualBefore) && actual !== target)
        this.fail(gs, gs.pending.orderId ? "IOC order did not fill within slippage" : gs.lastError ?? "order outcome unknown and position unchanged", now);
      gs.pending = undefined;
    }

    const plan = planTrade(target, actual, spec);
    if (plan.kind !== "order") {
      gs.status = plan.kind === "dust" ? "dust" : plan.reason === "below-min-size" ? "below-min" : "in-sync";
      if (plan.kind === "dust") gs.lastError = plan.reason;
      else if (plan.reason === "in-sync") {
        gs.failures = 0;
        gs.lastError = undefined;
        gs.cooldownUntil = undefined;
      }
      // "none" means the Decibel side matches the open positions only, i.e. closed ones are flattened.
      return { gs, settled: plan.kind === "none" };
    }

    if (gs.cooldownUntil && now < gs.cooldownUntil) return { gs, settled: false };

    // 2. Consent check before spending gas: the subaccount must delegate perp trading on this market to us.
    const del = await this.client.delegation(subaccount, spec).catch((e) => {
      this.opt.log(`${k}: delegation view failed: ${(e as Error).message.slice(0, 120)}`);
      return undefined;
    });
    if (!del) {
      // Unknown consent: don't spend gas on an order that may revert (REVIEW L-1); retry next tick.
      gs.lastError = "delegation view failed";
      return { gs, settled: false };
    }
    if (!del.canTrade) {
      gs.status = target === 0n ? "orphaned" : "not-delegated";
      gs.lastError =
        target === 0n
          ? `hedge of ${actual} must be closed but delegation to ${this.client.hedgerAddress} is missing or expired; close it on Decibel`
          : `Trading Account ${subaccount} has not delegated ${market} perp trading to the hedger`;
      gs.cooldownUntil = now + this.opt.baseBackoffMs;
      return { gs, settled: false };
    }

    // 3. Trade the difference.
    const mark = await this.client.markPrice(spec);
    const price = iocPrice(mark, plan.isBuy, this.opt.slippageBps, spec);
    const seq = ++this.state.seq;
    const clientOrderId = `tt${seq}-${short(subaccount)}`; // <= 32 bytes
    const res = await this.client.placeOrder({ subaccount, market: spec, isBuy: plan.isBuy, size: plan.size, price, reduceOnly: plan.reduceOnly, clientOrderId });
    if (!res.ok && res.unknown) {
      // Possibly submitted (SDK docs: an unknown outcome does not authorize another submission). Treat it as
      // in flight without an order id: wait, then re-read the position before deciding again.
      gs.pending = { clientOrderId, txHash: "", placedAt: now, actualBefore: actual.toString() };
      gs.lastError = res.error;
      gs.status = "pending";
      this.recordInFlight(k, gs);
      this.opt.log(`${k}: ${res.error} (client order ${clientOrderId}); waiting before re-reading`);
      return { gs, settled: false };
    }
    if (!res.ok) {
      this.fail(gs, res.error, now);
      this.opt.log(`${k}: order failed (${gs.failures}): ${res.error}`);
      return { gs, settled: false };
    }
    gs.pending = { orderId: res.orderId, clientOrderId, txHash: res.txHash, placedAt: now, actualBefore: actual.toString() };
    gs.lastTx = res.txHash;
    gs.status = "pending";
    this.recordInFlight(k, gs);
    this.opt.log(
      `${k}: ${plan.isBuy ? "BUY" : "SELL"} ${plan.size}${plan.reduceOnly ? " reduce-only" : ""} @ ${price} (target ${target}, actual ${actual}) order=${res.orderId} tx=${res.txHash}`,
    );
    return { gs, settled: false };
  }

  /** Persist an in-flight order right away so a later throw or watchdog restart cannot forget it (double hedge). */
  private recordInFlight(k: string, gs: GroupState) {
    this.state.groups[k] = gs;
    try { this.opt.persist?.(this.state); } catch (e) { this.opt.log(`persist failed: ${(e as Error).message.slice(0, 120)}`); }
  }

  private fail(gs: GroupState, error: string, now: number) {
    gs.failures += 1;
    gs.lastError = error;
    gs.status = "failed";
    gs.cooldownUntil = now + Math.min(this.opt.baseBackoffMs * 2 ** (gs.failures - 1), this.opt.maxBackoffMs);
  }

  private async tryPrune(id: string) {
    if (this.state.pruned.includes(id)) return;
    try {
      const tx = await this.chain.prune(id);
      this.state.pruned.push(id);
      this.opt.log(`pruned hedge request #${id} tx=${tx}`);
    } catch (e) {
      const msg = (e as Error).message;
      // Already pruned by someone else (it is permissionless): treat as done.
      if (/hedge.*(E_NO_REQUEST|0x4\b|abort_code: 4)|E_NO_REQUEST|NO_REQUEST/.test(msg)) this.state.pruned.push(id);
      else this.opt.log(`prune #${id} failed: ${msg.slice(0, 160)}`);
    }
  }
}

export { groupKey };
export type { MarketSpec };
