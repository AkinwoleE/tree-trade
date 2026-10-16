/** Shared types + aggregation for protocol activity (decoded from on-chain events by /api/activity). */
export interface Trade {
  kind: "close" | "liquidation";
  version: number;
  ts: number; // unix seconds
  id: string;
  owner: string;
  market: string;
  isLong?: boolean;
  margin: number;
  leverage?: number;
  notional?: number;
  entry?: number;
  exit: number;
  pnl: number; // signed, USDC, after fee
  fee: number;
  seedsMinted: number;
}
export interface Opened {
  version: number;
  ts: number;
  id: string;
  owner: string;
  market: string;
  isLong: boolean;
  margin: number;
  leverage: number;
  notional: number;
  entry: number;
}
export interface Activity {
  trades: Trade[];
  opens: Opened[];
  deposits: { version: number; ts: number; user: string; amount: number; kind: "deposit" | "withdraw" }[];
  updatedAt: number;
  partial?: boolean;
}

export function leaderboard(trades: Trade[], sinceSec: number) {
  const by = new Map<string, { owner: string; pnl: number; volume: number; trades: number; wins: number }>();
  for (const t of trades) {
    if (t.ts < sinceSec) continue;
    const r = by.get(t.owner) ?? { owner: t.owner, pnl: 0, volume: 0, trades: 0, wins: 0 };
    r.pnl += t.pnl;
    r.volume += t.notional ?? 0;
    r.trades += 1;
    if (t.pnl > 0) r.wins += 1;
    by.set(t.owner, r);
  }
  return [...by.values()].sort((a, b) => b.pnl - a.pnl);
}

export const WINDOWS = { "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400, All: Infinity } as const;
export type Window = keyof typeof WINDOWS;
export const since = (w: Window) => (WINDOWS[w] === Infinity ? 0 : Math.floor(Date.now() / 1000) - WINDOWS[w]);
