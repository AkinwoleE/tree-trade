/**
 * Pure helpers (no SDK imports) for decoding positions and computing PnL.
 * Shared with the keeper. Math mirrors exchange.move.
 */
import {
  BUST_BUFFER,
  FEE_BPS,
  IMPACT,
  MAINT_BPS,
  PRICE_DECIMALS,
  USDC_DECIMALS,
  marketSymbol,
  type MarketSymbol,
} from "../config/contract";

export interface Position {
  id: string;
  owner: string;
  market: number;
  symbol?: MarketSymbol;
  isLong: boolean;
  /** margin in USDC */
  margin: number;
  leverage: number;
  /** margin * leverage in USDC */
  notional: number;
  /** entry price in USD */
  entryPrice: number;
  openedAt: number;
  /** from exchange::liquidation_price when available */
  liqPrice?: number;
}

export const toUnits = (amount: number, decimals: number) => BigInt(Math.round(amount * 10 ** decimals));
export const fromUnits = (v: unknown, decimals: number) => Number(v ?? 0) / 10 ** decimals;

/** Decode the tuple returned by `exchange::get_position(id)`. */
export function decodePosition(id: string | number | bigint, t: unknown[]): Position {
  const [owner, market, isLong, margin, leverage, notional, entry, openedAt] = t;
  return {
    id: String(id),
    owner: String(owner),
    market: Number(market),
    symbol: marketSymbol(Number(market)),
    isLong: isLong === true,
    margin: fromUnits(margin, USDC_DECIMALS),
    leverage: Number(leverage),
    notional: fromUnits(notional, USDC_DECIMALS),
    entryPrice: fromUnits(entry, PRICE_DECIMALS),
    openedAt: Number(openedAt),
  };
}

type PnlInput = Pick<Position, "isLong" | "notional" | "entryPrice">;

/** Gross unrealized PnL in USDC (losses capped at margin happen on settlement). */
export function pnl(p: PnlInput, mark: number): number {
  if (!p.entryPrice || !mark) return 0;
  return p.notional * ((mark - p.entryPrice) / p.entryPrice) * (p.isLong ? 1 : -1);
}

/** PnL as it would settle: profit minus the fee, loss capped at margin. */
export function netPnl(p: PnlInput & Pick<Position, "margin"> & { symbol?: MarketSymbol }, mark: number): number {
  const g = pnl(p, mark);
  return g > 0 ? impactAdjusted(p, mark) * (1 - FEE_BPS / 10_000) : Math.max(g, -p.margin);
}

/** Win after the deadband + asymmetric impact haircut (mirrors exchange::impact_adjusted). */
export function impactAdjusted(p: PnlInput & { symbol?: MarketSymbol }, mark: number): number {
  if (!p.entryPrice || !mark) return 0;
  const gain = Math.abs(mark - p.entryPrice);
  const g = gain - p.entryPrice / 50_000;
  if (g <= 0) return 0;
  const move = g / p.entryPrice;
  const P = IMPACT.posMult[p.symbol ?? "BTC"] ?? IMPACT.posMult.BTC;
  const scale = (1 - IMPACT.baseRate) / (1 + 1 / (move * IMPACT.rateMult) + IMPACT.nref / (1e6 * move * P));
  return p.notional * move * scale;
}

/** Maintenance margin in USDC: 0.5% of notional capped at 50% of margin. */
export const maintenance = (margin: number, notional: number) => Math.min((notional * MAINT_BPS) / 10_000, margin / 2);

/** Liquidation price: chain value if present, else the same formula as exchange::liquidation_price. */
export function liqPrice(p: Pick<Position, "isLong" | "margin" | "notional" | "entryPrice" | "liqPrice"> & { symbol?: MarketSymbol; leverage?: number }): number {
  if (p.liqPrice) return p.liqPrice;
  return bustPrice(p);
}

/** Paper Trade hard-bust price (mirrors exchange::bust_price): ~5 bp before zero equity. */
export function bustPrice(p: Pick<Position, "isLong" | "margin" | "notional" | "entryPrice"> & { symbol?: MarketSymbol; leverage?: number }): number {
  const L = p.leverage || (p.margin ? p.notional / p.margin : 0);
  if (!L || !p.entryPrice) return 0;
  const buf = BUST_BUFFER[p.symbol ?? "BTC"] ?? BUST_BUFFER.BTC;
  return p.isLong ? p.entryPrice * ((L - 1) / L) * (1 + buf) : p.entryPrice * ((L + 1) / L) * (1 - buf);
}

/** equity <= maintenance at `mark` (same rule as exchange::is_liquidatable). */
export function isLiquidatable(p: Position, mark: number): boolean {
  const b = liqPrice(p);
  return !!b && (p.isLong ? mark <= b : mark >= b);
}
