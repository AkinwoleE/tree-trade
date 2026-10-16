import type { MarketSymbol } from "@/config/contract";
import { netPnl, type Position } from "@/lib/positions";
export const netPnlOf = (ps: Position[], prices?: Partial<Record<MarketSymbol, number>>) =>
  ps.reduce((acc, p) => acc + (p.symbol && prices?.[p.symbol] ? netPnl(p, prices[p.symbol]!) : 0), 0);
