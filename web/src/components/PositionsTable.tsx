"use client";

import { Fragment } from "react";
import { ENTRY, MARKET_SYMBOLS, type MarketSymbol } from "@/config/contract";
import type { Prices } from "@/lib/prices";
import { isLiquidatable, liqPrice, netPnl, type Position } from "@/lib/positions";
import { fmtPx, fmtUsd } from "@/lib/format";
import type { Submit } from "@/lib/hooks";
import type { DecibelAccountData, HedgerStatus } from "@/lib/hedge-hooks";
import { sizeToBase } from "@/lib/hedge";
import { explorerTx, shortAddr } from "@/lib/chain";
import { Card } from "./ui";

/** Hedger statuses that need the user's attention. */
const BAD = new Set(["failed", "not-delegated", "orphaned", "dust"]);

/**
 * Compact hedge pills — style borrowed from popular perps UIs (status chips next to Close).
 * Labels stay short: Hedged / Pending / Failed / Off.
 */
const PILL: Record<string, { label: string; cls: string }> = {
  "in-sync": { label: "Hedged", cls: "bg-emerald-500/20 text-emerald-300" },
  pending: { label: "Pending", cls: "bg-indigo-500/20 text-indigo-300" },
  requested: { label: "Pending", cls: "bg-indigo-500/20 text-indigo-300" },
  "hedging…": { label: "Pending", cls: "bg-indigo-500/20 text-indigo-300" },
  failed: { label: "Failed", cls: "bg-rose-500/20 text-rose-300" },
  "not-delegated": { label: "Failed", cls: "bg-rose-500/20 text-rose-300" },
  orphaned: { label: "Failed", cls: "bg-rose-500/20 text-rose-300" },
  dust: { label: "Dust", cls: "bg-amber-500/20 text-amber-300" },
  "below-min": { label: "Below min", cls: "bg-zinc-500/20 text-zinc-400" },
  "closed-awaiting-flatten": { label: "Closing", cls: "bg-indigo-500/20 text-indigo-300" },
  "hedger offline": { label: "Offline", cls: "bg-amber-500/20 text-amber-300" },
};

const HEDGER_STALE_SECS = 90;

function HedgePill({ status }: { status: string }) {
  const p = PILL[status] ?? { label: status, cls: "bg-zinc-500/20 text-zinc-400" };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${p.cls}`}>{p.label}</span>;
}

function fmtDelta(n: number, digits = 2) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const s = abs >= 1 ? abs.toFixed(digits) : abs.toFixed(Math.min(5, digits + 2));
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

export function PositionsTable({
  positions,
  prices,
  decibel,
  hedger,
  submit,
  busy,
}: {
  positions: Position[];
  prices?: Prices;
  decibel: DecibelAccountData;
  hedger: HedgerStatus;
  submit: Submit;
  busy: boolean;
}) {
  const totalPnl = positions.reduce((acc, p) => acc + (p.symbol && prices?.[p.symbol] ? netPnl(p, prices[p.symbol]!) : 0), 0);
  const hedgerUp = hedger.available && (hedger.age ?? Infinity) < HEDGER_STALE_SECS;
  const sub = decibel.selected;
  const canRequest = (s?: MarketSymbol) => !!sub && !!s && !!decibel.markets[s]?.delegation?.canTrade;

  // Net exposure per market: Tree Trade delta (base units) + Decibel hedge size on the selected account.
  const summary = MARKET_SYMBOLS.map((s) => {
    const mine = positions.filter((p) => p.symbol === s);
    const dm = decibel.markets[s];
    const ttDelta = mine.reduce((a, p) => a + (p.entryPrice ? (p.isLong ? 1 : -1) * (p.notional / p.entryPrice) : 0), 0);
    const ttPnl = mine.reduce((a, p) => a + (prices?.[s] ? netPnl(p, prices[s]!) : 0), 0);
    const dSize = dm?.size !== undefined && dm.spec ? sizeToBase(dm.size, dm.spec) : 0;
    const dPnl = dm?.mark && dm.entryPx && dSize ? dSize * (dm.mark - dm.entryPx) - (dm.fundingCost ?? 0) : 0;
    return { s, n: mine.length, ttDelta, ttPnl, dSize, dPnl };
  }).filter((r) => r.n > 0 || r.dSize !== 0);

  const settling = Object.entries(hedger.positions).filter(
    ([id, h]) => h.status === "closed-awaiting-flatten" && !positions.some((p) => p.id === id) && decibel.requests[id],
  );
  const orphans = Object.values(hedger.groups).filter((g) => g.status === "orphaned" && Object.values(decibel.requests).includes(g.subaccount));

  return (
    <Card
      title={`Positions (${positions.length})`}
      right={
        positions.length > 0 && (
          <span className={`font-mono text-sm ${totalPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            uPnL {fmtUsd(totalPnl)}
          </span>
        )
      }
    >
      {positions.length === 0 ? (
        <p className="text-sm text-zinc-500">No open positions.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="py-1.5 pr-3">Market</th>
                <th className="pr-3">Size</th>
                <th className="pr-3">Margin</th>
                <th className="pr-3">Entry</th>
                <th className="pr-3">Mark</th>
                <th className="pr-3">Liq.</th>
                <th className="pr-3" title="Unrealized PnL at live mark">uPnL</th>
                <th className="pr-3">Hedge</th>
                <th />
              </tr>
            </thead>
            <tbody className="font-mono">
              {positions.map((p) => {
                const mark = p.symbol ? prices?.[p.symbol] : undefined;
                const u = mark ? netPnl(p, mark) : undefined;
                const roe = u !== undefined && p.margin ? (u / p.margin) * 100 : undefined;
                const danger = mark !== undefined && isLiquidatable(p, mark);
                const reqSub = decibel.requests[p.id];
                const h = hedger.positions[p.id];
                const dm = p.symbol ? decibel.markets[p.symbol] : undefined;
                // Prefer live hedger status; if the status feed is limited, infer Hedged from an
                // offsetting Decibel size (same signal as Net Δ flat).
                const ttBase = p.entryPrice ? (p.isLong ? 1 : -1) * (p.notional / p.entryPrice) : 0;
                const dBase = dm?.size !== undefined && dm.spec ? sizeToBase(dm.size, dm.spec) : 0;
                const offsetting = reqSub && Math.abs(ttBase) > 0 && Math.abs(ttBase + dBase) < Math.abs(ttBase) * 0.15;
                const status = reqSub
                  ? hedgerUp
                    ? (h?.status ?? (offsetting ? "in-sync" : "pending"))
                    : hedger.limited
                      ? offsetting
                        ? "in-sync"
                        : "requested"
                      : "hedger offline"
                  : undefined;
                const err =
                  reqSub && h && BAD.has(h.status)
                    ? h.error
                    : reqSub && !hedgerUp && !hedger.limited
                      ? "Hedger offline — opposite side not managed."
                      : undefined;
                return (
                  <Fragment key={p.id}>
                    <tr className="border-t border-zinc-800/80">
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        <span className={`font-sans text-xs font-semibold ${p.isLong ? "text-emerald-400" : "text-rose-400"}`}>
                          {p.isLong ? "Long" : "Short"}
                        </span>{" "}
                        <span className="text-zinc-100">{p.symbol ?? `#${p.market}`}</span>
                        <span className="ml-1.5 text-[11px] text-zinc-500">{p.leverage}×</span>
                      </td>
                      <td className="pr-3 whitespace-nowrap">{fmtUsd(p.notional)}</td>
                      <td className="pr-3 whitespace-nowrap">{fmtUsd(p.margin)}</td>
                      <td className="pr-3 whitespace-nowrap">{fmtPx(p.entryPrice)}</td>
                      <td className="pr-3 whitespace-nowrap">{fmtPx(mark)}</td>
                      <td className={`pr-3 whitespace-nowrap ${danger ? "text-rose-400" : "text-amber-400"}`}>
                        {fmtPx(liqPrice(p))}
                        {danger && <span className="ml-1 font-sans text-[10px]">!</span>}
                      </td>
                      <td className={`pr-3 whitespace-nowrap ${u === undefined ? "" : u >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {fmtUsd(u)}
                        {roe !== undefined && <span className="ml-1 text-[11px] opacity-60">({roe.toFixed(1)}%)</span>}
                      </td>
                      <td className="pr-3 whitespace-nowrap">
                        {status ? (
                          <span className="inline-flex items-center gap-1.5">
                            <HedgePill status={status} />
                            <button
                              className="font-sans text-[11px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
                              disabled={busy}
                              title="Remove hedge — closes the opposite side"
                              onClick={() => submit(`Remove hedge #${p.id}`, ENTRY.cancelHedge, [BigInt(p.id)])}
                            >
                              ×
                            </button>
                          </span>
                        ) : (
                          <button
                            className="rounded-full border border-zinc-700 px-2 py-0.5 font-sans text-[11px] text-zinc-400 hover:border-indigo-500 hover:text-indigo-300 disabled:opacity-40"
                            disabled={busy || !canRequest(p.symbol)}
                            title={
                              canRequest(p.symbol)
                                ? "Request hedge on opposite side"
                                : "Enable hedging first (one-click setup in the Hedge panel)"
                            }
                            onClick={() => submit(`Hedge #${p.id}`, ENTRY.requestHedge, [BigInt(p.id), sub!])}
                          >
                            Off
                          </button>
                        )}
                      </td>
                      <td className="text-right">
                        <button
                          className="btn btn-ghost py-1 px-2 text-xs"
                          disabled={busy}
                          onClick={() => submit(`Close #${p.id}`, ENTRY.closePosition, [BigInt(p.id)])}
                        >
                          Close
                        </button>
                      </td>
                    </tr>
                    {err && (
                      <tr>
                        <td colSpan={9} className="pb-2 font-sans text-xs text-rose-400">
                          {err}
                          {h && hedger.groups[h.group]?.lastTx && (
                            <a className="ml-2 underline" href={explorerTx(hedger.groups[h.group].lastTx!)} target="_blank" rel="noreferrer">
                              tx
                            </a>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Quiet net-exposure line — HL/cross-DEX style: Net Δ · Tree · Hedge, no wallet in the header */}
      {summary.length > 0 && (
        <div className="space-y-1.5 border-t border-zinc-800/80 pt-3" title={sub ? `Hedge account ${shortAddr(sub)}` : undefined}>
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">Net exposure</div>
          {summary.map((r) => {
            const net = r.ttDelta + r.dSize;
            const combined = r.ttPnl + r.dPnl;
            const flat = Math.abs(net) < Math.max(1e-8, Math.abs(r.ttDelta) / 20);
            return (
              <div key={r.s} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-xs text-zinc-400">
                <span className="w-8 font-sans font-medium text-zinc-200">{r.s}</span>
                <span>
                  Net Δ{" "}
                  <span className={flat ? "text-emerald-400" : "text-amber-400"}>{fmtDelta(net)}</span>
                </span>
                <span className="text-zinc-600">·</span>
                <span>
                  Tree <span className={r.ttPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>{fmtUsd(r.ttPnl)}</span>
                </span>
                <span className="text-zinc-600">·</span>
                <span>
                  Hedge <span className={r.dPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>{fmtUsd(r.dPnl)}</span>
                </span>
                <span className="text-zinc-600">·</span>
                <span>
                  Combined{" "}
                  <span className={combined >= 0 ? "text-emerald-400" : "text-rose-400"}>{fmtUsd(combined)}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {(settling.length > 0 || orphans.length > 0) && (
        <ul className="space-y-1 text-xs text-zinc-400">
          {settling.map(([id, h]) => (
            <li key={id} className="text-indigo-300">
              #{id} closed — flattening {h.market} hedge
              {h.error ? <span className="text-rose-400"> ({h.error})</span> : null}
            </li>
          ))}
          {orphans.map((g) => (
            <li key={g.subaccount + g.market} className="text-rose-400" title={g.subaccount}>
              Orphaned {g.market} hedge: {g.lastError}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
