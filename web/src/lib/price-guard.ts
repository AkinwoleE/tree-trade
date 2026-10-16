/**
 * Off-chain price-sig deviation check (ORACLE_RISK.md fix 2). Mirrors oracle::check_move but
 * tighter: never sign a price further from the on-chain stored price than
 * min(base + perSec * elapsed, max). Pure so it can be unit-tested.
 */
export const SIG_BASE_BPS = Number(process.env.PRICE_SIG_BASE_BPS ?? 20); // 0.2%
export const SIG_BPS_PER_SEC = Number(process.env.PRICE_SIG_BPS_PER_SEC ?? 2); // 0.02%/s
export const SIG_MAX_BPS = Number(process.env.PRICE_SIG_MAX_BPS ?? 200); // the 2% off-chain cap

export function sigDeviationOk(price: number, onchain: number, elapsedSec: number, base = SIG_BASE_BPS, perSec = SIG_BPS_PER_SEC, max = SIG_MAX_BPS) {
  if (!(onchain > 0)) return { ok: false, devBps: Infinity, allowedBps: 0 };
  const allowedBps = Math.min(base + perSec * Math.max(0, elapsedSec), max);
  const devBps = (Math.abs(price / onchain - 1)) * 10_000;
  return { ok: devBps <= allowedBps, devBps, allowedBps };
}
