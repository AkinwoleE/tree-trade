import { MODULE_ADDR, PRICE_DECIMALS, USDC_DECIMALS, PAPER_DECIMALS, marketSymbol } from "@/config/contract";
import type { Activity, Opened, Trade } from "@/lib/activity";

const px = (v: unknown) => Number(v) / 10 ** PRICE_DECIMALS;
const usdc = (v: unknown) => Number(v) / 10 ** USDC_DECIMALS;
const mkt = (v: unknown) => marketSymbol(Number(v)) ?? `#${v}`;

/** Decode our module's events from one committed transaction (fullnode JSON / waitForTransaction result). */
export function decodeTx(t: { version: string | number; timestamp: string | number; events?: { type: string; data: any }[] }) {
  const v = Number(t.version);
  const ts = Math.floor(Number(t.timestamp) / 1e6);
  const opens: Opened[] = [];
  const closes: Trade[] = [];
  const deposits: Activity["deposits"] = [];
  for (const e of t.events ?? []) {
    if (!String(e.type).toLowerCase().startsWith(`${MODULE_ADDR.toLowerCase()}::`)) continue;
    const name = String(e.type).split("::").slice(-2).join("::");
    const d = e.data;
    if (name === "exchange::PositionOpened") {
      opens.push({ version: v, ts, id: String(d.id), owner: d.owner, market: mkt(d.market), isLong: d.is_long, margin: usdc(d.margin), leverage: Number(d.leverage), notional: usdc(d.notional), entry: px(d.entry_price) });
    } else if (name === "exchange::PositionClosed") {
      const gross = usdc(d.pnl);
      const fee = usdc(d.fee);
      closes.push({ kind: "close", version: v, ts, id: String(d.id), owner: d.owner, market: mkt(d.market), isLong: d.is_long, margin: usdc(d.margin), entry: px(d.entry_price), exit: px(d.exit_price), pnl: d.is_profit ? gross - fee : -gross, fee, seedsMinted: Number(d.paper_minted) / 10 ** PAPER_DECIMALS });
    } else if (name === "exchange::PositionLiquidated") {
      closes.push({ kind: "liquidation", version: v, ts, id: String(d.id), owner: d.owner, market: mkt(d.market), margin: usdc(d.margin), exit: px(d.exit_price), pnl: -usdc(d.margin), fee: usdc(d.fee), seedsMinted: Number(d.paper_minted) / 10 ** PAPER_DECIMALS });
    } else if (name === "exchange::Deposited" || name === "exchange::Withdrawn") {
      deposits.push({ version: v, ts, user: d.user, amount: usdc(d.amount), kind: name.endsWith("Deposited") ? "deposit" : "withdraw" });
    }
  }
  return { opens, closes, deposits };
}

/** Merge locally-confirmed tx activity into a server snapshot (dedupe by version+id). */
export function mergeActivity(base: Activity | undefined, extra: { opens: Opened[]; closes: Trade[]; deposits: Activity["deposits"] }): Activity {
  const a: Activity = base ?? { trades: [], opens: [], deposits: [], updatedAt: Date.now() };
  const key = (x: { version: number; id?: string; user?: string }) => `${x.version}:${x.id ?? x.user}`;
  const add = <T extends { version: number }>(list: T[], more: T[]) => {
    const seen = new Set(list.map((x) => key(x as never)));
    return [...more.filter((x) => !seen.has(key(x as never))), ...list].sort((p, q) => q.version - p.version);
  };
  const opens = add(a.opens, extra.opens);
  const trades = add(a.trades, extra.closes).map((c) => {
    const o = opens.find((x) => x.id === c.id);
    return o ? { ...c, isLong: c.isLong ?? o.isLong, leverage: c.leverage ?? o.leverage, notional: c.notional ?? o.notional, entry: c.entry ?? o.entry } : c;
  });
  return { ...a, opens, trades, deposits: add(a.deposits, extra.deposits) };
}

export const TX_EVENT = "treetrade:tx";
