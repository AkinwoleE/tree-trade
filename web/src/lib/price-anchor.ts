"use client";
/**
 * Display-only sanity anchor for the live price line (browser).
 *
 * The streamed price is for display only; trades always use the server-signed /api/price-sig price and
 * the keeper's on-chain price. If the stream drifts more than ANCHOR_MAX_DEV from the latest trusted
 * price (a signed price this tab fetched, or a fresh on-chain keeper price), the UI shows the trusted
 * price instead. Costs nothing: it only reuses prices the app already has.
 */
import type { MarketSymbol } from "@/config/contract";

export const ANCHOR_MAX_DEV = 0.003; // 0.3%
const MAX_AGE_MS = { signed: 30_000, chain: 90_000 } as const;
type Kind = keyof typeof MAX_AGE_MS;

const anchors: Partial<Record<MarketSymbol, { p: number; t: number; kind: Kind }>> = {};

/** Record a trusted price. `t` is when that price was valid (ms). Keeps the newest one per market. */
export function setAnchor(s: MarketSymbol, p: number, t: number, kind: Kind) {
  if (!(p > 0) || !Number.isFinite(p)) return;
  const cur = anchors[s];
  if (!cur || t >= cur.t) anchors[s] = { p, t, kind };
}

/** The price to display: the streamed price, unless it strays > 0.3% from a recent trusted price. */
export function guardPrice(s: MarketSymbol, p: number, now = Date.now()): { p: number; anchored: boolean } {
  const a = anchors[s];
  if (!a || now - a.t > MAX_AGE_MS[a.kind]) return { p, anchored: false };
  return Math.abs(p / a.p - 1) > ANCHOR_MAX_DEV ? { p: a.p, anchored: true } : { p, anchored: false };
}
