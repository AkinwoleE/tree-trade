"use client";
import { useState } from "react";
import { shortAddr } from "@/lib/chain";
import { fmtNum, fmtPx, fmtUsd } from "@/lib/format";
import { leaderboard, since, WINDOWS, type Trade, type Window } from "@/lib/activity";

const ago = (ts: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const pnlCls = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-rose-400" : "");

export function TradeHistory({ trades, empty = "No closed trades yet." }: { trades: Trade[]; empty?: string }) {
  if (!trades.length) return <p className="text-sm text-zinc-500">{empty}</p>;
  return (
    <div className="max-h-[28rem] overflow-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-zinc-500">
          <tr><th className="py-1">Trader</th><th>Asset</th><th>Notional</th><th>Entry → Exit</th><th className="text-right">PnL</th><th className="text-right">SEEDS</th><th className="text-right">When</th></tr>
        </thead>
        <tbody className="font-mono">
          {trades.map((t) => (
            <tr key={`${t.version}-${t.id}`} className="border-t border-zinc-800">
              <td className="py-1" title={t.owner}>{shortAddr(t.owner)}</td>
              <td>
                {t.market} {t.leverage ? `${t.leverage}×` : ""}{" "}
                {t.isLong !== undefined && <span className={t.isLong ? "text-emerald-400" : "text-rose-400"}>{t.isLong ? "LONG" : "SHORT"}</span>}
                {t.kind === "liquidation" && <span className="ml-1 rounded bg-rose-600/30 px-1 text-xs text-rose-300">LIQ</span>}
              </td>
              <td>{fmtUsd(t.notional, 0)}</td>
              <td>{t.entry ? fmtPx(t.entry) : "?"} → {fmtPx(t.exit)}</td>
              <td className={`text-right ${pnlCls(t.pnl)}`}>{t.pnl >= 0 ? "+" : ""}{fmtUsd(t.pnl)}</td>
              <td className="text-right">{t.seedsMinted ? fmtNum(t.seedsMinted, 0) : "–"}</td>
              <td className="text-right text-zinc-500">
                <a className="hover:underline" href={`https://explorer.aptoslabs.com/txn/${t.version}?network=testnet`} target="_blank" rel="noreferrer">{ago(t.ts)}</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Leaderboard({ trades, mode: initialMode = "accounts" }: { trades: Trade[]; mode?: "accounts" | "positions" }) {
  const [w, setW] = useState<Window>("All");
  const [mode, setMode] = useState(initialMode);
  const s = since(w);
  const btn = (on: boolean) => `rounded px-2 py-0.5 text-xs ${on ? "bg-emerald-500/20 text-emerald-300" : "text-zinc-400 hover:text-zinc-200"}`;
  const rows = leaderboard(trades, s);
  const best = trades.filter((t) => t.ts >= s).sort((a, b) => b.pnl - a.pnl).slice(0, 50);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <div className="flex gap-1">
          <button className={btn(mode === "positions")} onClick={() => setMode("positions")}>Positions</button>
          <button className={btn(mode === "accounts")} onClick={() => setMode("accounts")}>Accounts</button>
        </div>
        <div className="flex gap-1">
          {(Object.keys(WINDOWS) as Window[]).map((k) => <button key={k} className={btn(k === w)} onClick={() => setW(k)}>{k}</button>)}
        </div>
      </div>
      {mode === "positions" ? (
        <TradeHistory trades={best} empty="No trades in this window." />
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No trades in this window.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-zinc-500">
            <tr><th className="py-1">#</th><th>Trader</th><th className="text-right">PnL</th><th className="text-right">Volume</th><th className="text-right">Trades</th><th className="text-right">Win rate</th></tr>
          </thead>
          <tbody className="font-mono">
            {rows.slice(0, 100).map((r, i) => (
              <tr key={r.owner} className="border-t border-zinc-800">
                <td className="py-1 text-zinc-500">{i + 1}</td>
                <td title={r.owner}>{shortAddr(r.owner)}</td>
                <td className={`text-right ${pnlCls(r.pnl)}`}>{r.pnl >= 0 ? "+" : ""}{fmtUsd(r.pnl)}</td>
                <td className="text-right">{fmtUsd(r.volume, 0)}</td>
                <td className="text-right">{r.trades}</td>
                <td className="text-right">{fmtNum((r.wins / r.trades) * 100, 0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
