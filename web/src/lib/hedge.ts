/**
 * Hedge sizing and reconciliation math, shared by the web preview and the keeper's hedger.
 * Pure functions, no I/O. All Decibel quantities are integer chain units (bigint):
 *   size  = base * 10^sz_decimals, multiple of lot_size, >= min_size
 *   price = USD * 10^6 (perp px_decimals), multiple of tick_size
 * docs.decibel.trade/developer-hub/on-chain/overview/formatting-prices-sizes
 */

/** Decibel perp market parameters, read from perp_engine views (market_sz_decimals, market_lot_size, ...). */
export interface MarketSpec {
  name: string;
  addr: string;
  szDecimals: number;
  lotSize: bigint;
  minSize: bigint;
  tickSize: bigint;
  minPrice?: bigint;
  maxPrice?: bigint;
  maxLeverage: number;
}

/** Perp prices on Decibel always use 6 decimals. */
export const DECIBEL_PX_DECIMALS = 6;
/** Tree Trade oracle prices use 8 decimals, USDC 6. */
const TT_PRICE_DECIMALS = 8n;
const USDC_DECIMALS = 6n;

/** Tier-0 perps taker fee, 0.045% (docs.decibel.trade/for-traders/fees). */
export const TAKER_FEE_BPS = 4.5;
/** Funding interest-rate baseline, 0.03%/day longs pay shorts (docs.decibel.trade/for-traders/funding-rates). */
export const FUNDING_BASELINE_PER_DAY = 0.0003;

/** Extra precision kept per position before the aggregate is rounded to lots. */
const PREC = 1_000_000n;

export interface HedgedPosition {
  id: string;
  isLong: boolean;
  /** margin * leverage, USDC raw (6 dp) */
  notionalRaw: bigint;
  /** Tree Trade entry price, raw (8 dp) */
  entryPriceRaw: bigint;
}

const absBig = (x: bigint) => (x < 0n ? -x : x);

/** Round a non-negative rational n/d to the nearest integer, halves up. */
function roundDiv(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

/**
 * Base-asset exposure of one Tree Trade position in Decibel size units, times PREC.
 * A position with notional N opened at E has PnL N*(P-E)/E = Q*(P-E), so its delta is Q = N/E base
 * units, fixed at open. Hedging Q (not current notional) offsets it exactly.
 */
export function exposureUnitsScaled(p: HedgedPosition, spec: Pick<MarketSpec, "szDecimals">): bigint {
  if (p.entryPriceRaw <= 0n) throw new Error(`position ${p.id}: bad entry price`);
  // Q * 10^sz = (N / 10^6) / (E / 10^8) * 10^sz
  const num = p.notionalRaw * 10n ** (TT_PRICE_DECIMALS - USDC_DECIMALS) * 10n ** BigInt(spec.szDecimals) * PREC;
  return num / p.entryPriceRaw;
}

/**
 * Signed Decibel target for one Trading Account + market: the opposite of the summed Tree Trade exposure,
 * rounded once (not per position) to the nearest lot. Positive = long.
 */
export function targetSize(positions: HedgedPosition[], spec: MarketSpec): bigint {
  let scaled = 0n;
  for (const p of positions) {
    const q = exposureUnitsScaled(p, spec);
    scaled += p.isLong ? -q : q;
  }
  const lots = roundDiv(absBig(scaled), spec.lotSize * PREC);
  const size = lots * spec.lotSize;
  return scaled < 0n ? -size : size;
}

/** The hedge size attributed to a single position (for display; trading uses the aggregate). */
export function positionHedgeSize(p: HedgedPosition, spec: MarketSpec): bigint {
  return targetSize([p], spec);
}

export type TradePlan =
  | { kind: "none"; reason: "in-sync" | "below-min-size" }
  | { kind: "dust"; reason: string }
  | { kind: "order"; isBuy: boolean; size: bigint; reduceOnly: boolean };

/**
 * What to send to move `actual` to `target` (both signed size units).
 * - Differences smaller than min_size cannot be traded, so they are left alone; a residual below
 *   min_size when the target is flat is reported as dust (Decibel rejects orders below min_size).
 * - Pure reductions use reduce-only, which can never flip the position
 *   (docs.decibel.trade/quickstart/typescript-starter-kit, "Reduce-Only Logic").
 */
export function planTrade(target: bigint, actual: bigint, spec: MarketSpec): TradePlan {
  const delta = target - actual;
  if (delta === 0n) return { kind: "none", reason: "in-sync" };
  const size = absBig(delta);
  if (size < spec.minSize) {
    if (target === 0n) return { kind: "dust", reason: `residual ${actual} below min_size ${spec.minSize}` };
    return { kind: "none", reason: "below-min-size" };
  }
  if (size % spec.lotSize !== 0n) throw new Error(`delta ${delta} not a multiple of lot ${spec.lotSize}`);
  const isBuy = delta > 0n;
  const reducing = actual !== 0n && (actual > 0n) !== isBuy && size <= absBig(actual);
  return { kind: "order", isBuy, size, reduceOnly: reducing };
}

/**
 * IOC limit price at mark ± slippage, rounded to a tick in the side-safe direction (buys down, sells up),
 * the same rule as the SDK's roundToTickSizeForSide, then clamped into the market's price band.
 */
export function iocPrice(mark: bigint, isBuy: boolean, slippageBps: number, spec: MarketSpec): bigint {
  const bps = BigInt(Math.round(slippageBps * 100)); // 1/1_000_000
  const raw = isBuy ? (mark * (1_000_000n + bps)) / 1_000_000n : (mark * (1_000_000n - bps) + 999_999n) / 1_000_000n;
  let px = isBuy ? (raw / spec.tickSize) * spec.tickSize : ((raw + spec.tickSize - 1n) / spec.tickSize) * spec.tickSize;
  if (spec.minPrice !== undefined && px < spec.minPrice) px = ((spec.minPrice + spec.tickSize - 1n) / spec.tickSize) * spec.tickSize;
  if (spec.maxPrice !== undefined && px > spec.maxPrice) px = (spec.maxPrice / spec.tickSize) * spec.tickSize;
  return px;
}

export const sizeToBase = (units: bigint, spec: Pick<MarketSpec, "szDecimals">) => Number(units) / 10 ** spec.szDecimals;
export const pxToUsd = (px: bigint) => Number(px) / 10 ** DECIBEL_PX_DECIMALS;

export interface HedgePreview {
  /** Decibel side: opposite of the Tree Trade side */
  side: "LONG" | "SHORT";
  sizeUnits: bigint;
  sizeBase: number;
  notionalUsd: number;
  /** collateral the Trading Account needs at `leverage` */
  marginUsd: number;
  leverage: number;
  /** taker fee to open and later close */
  feesUsd: number;
  /** baseline funding per day; positive = cost */
  fundingPerDayUsd: number;
  belowMin: boolean;
  /** Decibel max leverage for the market is lower than requested */
  leverageCapped: boolean;
}

/** Preview for the trade panel. `markUsd` prices the Decibel side; `entryUsd` sizes it (Tree Trade entry). */
export function previewHedge(args: {
  isLong: boolean;
  notionalUsd: number;
  entryUsd: number;
  markUsd: number;
  spec: MarketSpec;
  leverage: number;
}): HedgePreview {
  const { spec } = args;
  const notionalRaw = BigInt(Math.round(args.notionalUsd * 1e6));
  const entryPriceRaw = BigInt(Math.round(args.entryUsd * 1e8));
  const units = absBig(targetSize([{ id: "preview", isLong: args.isLong, notionalRaw, entryPriceRaw }], spec));
  const sizeBase = sizeToBase(units, spec);
  const notionalUsd = sizeBase * args.markUsd;
  const leverage = Math.max(1, Math.min(args.leverage, spec.maxLeverage));
  const side = args.isLong ? "SHORT" : "LONG";
  return {
    side,
    sizeUnits: units,
    sizeBase,
    notionalUsd,
    marginUsd: notionalUsd / leverage,
    leverage,
    feesUsd: 2 * notionalUsd * (TAKER_FEE_BPS / 10_000),
    // Baseline: longs pay shorts when the premium is ~0.
    fundingPerDayUsd: (side === "LONG" ? 1 : -1) * notionalUsd * FUNDING_BASELINE_PER_DAY,
    belowMin: units < spec.minSize,
    leverageCapped: args.leverage > spec.maxLeverage,
  };
}

/** Tree Trade market id -> Decibel perp market name. */
export const DECIBEL_MARKET_FOR: Record<string, string> = { BTC: "BTC/USD", ETH: "ETH/USD" };

export interface DelegationStatus {
  /** delegate may trade perps on this market right now */
  canTrade: boolean;
  scope?: "market" | "all-perps";
  /** unix seconds, undefined = no expiry */
  expiresAt?: number;
  /** permissions beyond perp trading (e.g. SubaccountFundsMovement): the hedger never needs these */
  excessive: string[];
}

type Variant = { __variant__: string; [k: string]: unknown };
type MapJson<K, V> = { entries?: { key: K; value: V }[]; data?: { key: K; value: V }[] };
const normAddr = (a: string) => "0x" + a.replace(/^0x/, "").replace(/^0+/, "").toLowerCase();

/**
 * Interpret dex_accounts::view_delegated_permissions(subaccount) JSON for one delegate and market.
 * Enum shapes from the on-chain ABI: PermissionType {TradePerpsAllMarkets, TradePerpsOnMarket{market}, ...},
 * StoredPermission {Unlimited, UnlimitedUntil(u64), UnlimitedVia{..}, UnlimitedUntilVia{.., expiration_time_s}}.
 */
export function delegationFor(perms: unknown, delegate: string, marketAddr: string, nowSecs: number): DelegationStatus {
  const out: DelegationStatus = { canTrade: false, excessive: [] };
  if (!delegate) return out;
  const outer = perms as MapJson<string, Variant>;
  const entry = (outer?.entries ?? outer?.data ?? []).find((e) => normAddr(String(e.key)) === normAddr(delegate));
  if (!entry) return out;
  const inner = (entry.value as Variant & { perms?: MapJson<Variant, Variant> }).perms;
  for (const { key, value } of inner?.entries ?? inner?.data ?? []) {
    const exp =
      value.__variant__ === "UnlimitedUntil"
        ? Number((value as Variant)._0)
        : value.__variant__ === "UnlimitedUntilVia"
          ? Number((value as Variant).expiration_time_s)
          : undefined;
    const live = exp === undefined || exp > nowSecs;
    if (key.__variant__ === "TradePerpsAllMarkets" || key.__variant__ === "TradePerpsOnMarket") {
      const m = (key.market as { inner?: string } | undefined)?.inner;
      const matches = key.__variant__ === "TradePerpsAllMarkets" || (m !== undefined && normAddr(m) === normAddr(marketAddr));
      if (matches && live && !out.canTrade) {
        out.canTrade = true;
        out.scope = key.__variant__ === "TradePerpsAllMarkets" ? "all-perps" : "market";
        out.expiresAt = exp;
      }
    } else if (live) {
      out.excessive.push(key.__variant__);
    }
  }
  return out;
}
