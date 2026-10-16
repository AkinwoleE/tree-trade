"use client";
import { useState } from "react";
import { useApp } from "@/lib/app-state";
import { useActivity } from "@/lib/use-activity";
import { fmtNum, fmtUsd } from "@/lib/format";
import { shortAddr } from "@/lib/chain";
import { netPnlOf } from "@/lib/portfolio";
import { PositionsTable } from "@/components/PositionsTable";
import { PaperPanel } from "@/components/PaperPanel";
import { TradeHistory } from "@/components/ActivityTables";
import { Card, Stat } from "@/components/ui";

const TABS = ["Open Positions", "Trade History", "Deposits / Withdrawals", "Staking", "Open Queue"] as const;

export default function Portfolio() {
  const a = useApp();
  const { activity } = useActivity();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Open Positions");
  const me = a.address?.toLowerCase();
  const trades = (activity?.trades ?? []).filter((t) => t.owner.toLowerCase() === me);
  const flows = (activity?.deposits ?? []).filter((d) => d.user.toLowerCase() === me);
  const queue = (a.pool.queue?.rows ?? []).filter((r) => r.owner.toLowerCase() === me);
  const openPnl = netPnlOf(a.data.positions, a.quote?.prices);
  const openNotional = a.data.positions.reduce((s, p) => s + p.notional, 0);
  const margin = a.data.positions.reduce((s, p) => s + p.margin, 0);
  const hist = trades.reduce((s, t) => s + t.pnl, 0);
  const vol = trades.reduce((s, t) => s + (t.notional ?? 0), 0);
  const btn = (on: boolean) => `rounded px-3 py-1 text-sm ${on ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-400 hover:text-zinc-100"}`;
  if (!a.address) return <Card title="Portfolio"><p className="text-sm text-zinc-500">Connect a wallet to view your portfolio.</p></Card>;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Open positions">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Open PnL" value={fmtUsd(openPnl)} />
            <Stat label="Open notional" value={fmtUsd(openNotional, 0)} />
            <Stat label="Margin in use" value={fmtUsd(margin)} />
            <Stat label="Positions" value={a.data.positions.length} />
          </div>
        </Card>
        <Card title="SEEDS">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="SEEDS balance" value={fmtNum(a.data.paper, 2)} />
            <Stat label="SEEDS staked" value={fmtNum(a.data.staked, 2)} />
            <Stat label="Claimable rewards" value={fmtUsd(a.data.pending)} />
            <Stat label="Queued winnings" value={fmtUsd(a.data.queued?.total ?? 0)} sub={a.data.queued?.firstIndex !== undefined ? `${fmtUsd(a.data.queued.ahead)} ahead of you` : "nothing owed"} />
          </div>
        </Card>
        <Card title="Stats">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Available to trade" value={fmtUsd(a.data.collateral)} />
            <Stat label="Historical PnL" value={fmtUsd(hist)} />
            <Stat label="Volume" value={fmtUsd(vol, 0)} />
            <Stat label="Account" value={shortAddr(a.address)} />
          </div>
        </Card>
      </div>
      <div className="flex flex-wrap gap-1">{TABS.map((t) => <button key={t} className={btn(t === tab)} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === "Open Positions" && <PositionsTable positions={a.data.positions} prices={a.quote?.prices} decibel={a.decibel} hedger={a.hedger} submit={a.tx.submit} busy={a.busy} />}
      {tab === "Trade History" && <Card title="Trade history"><TradeHistory trades={trades} /></Card>}
      {tab === "Deposits / Withdrawals" && (
        <Card title="Deposits / withdrawals">
          {flows.length === 0 ? <p className="text-sm text-zinc-500">None yet.</p> : (
            <table className="w-full text-sm"><tbody className="font-mono">
              {flows.map((f) => (
                <tr key={f.version} className="border-t border-zinc-800">
                  <td className="py-1">{f.kind}</td><td className="text-right">{fmtUsd(f.amount)}</td>
                  <td className="text-right text-zinc-500">{new Date(f.ts * 1000).toLocaleString()}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Card>
      )}
      {tab === "Staking" && <PaperPanel data={a.data} pool={a.pool} submit={a.tx.submit} busy={a.busy} />}
      {tab === "Open Queue" && (
        <Card title="Your queued payouts">
          <div className="mb-3 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="You are owed" value={fmtUsd(a.data.queued?.total ?? 0)} />
            <Stat label="Queue position" value={a.data.queued?.firstIndex !== undefined && a.pool.queue ? `#${a.data.queued.firstIndex - a.pool.queue.head + 1} of ${a.pool.queue.tail - a.pool.queue.head}` : "–"} />
            <Stat label="Owed ahead of you" value={fmtUsd(a.data.queued?.ahead ?? 0)} />
            <Stat label="LP cash now" value={fmtUsd(a.pool.accounting?.[3])} />
          </div>
          <p className="mb-2 text-xs text-zinc-500">Paid oldest-first from future trader losses. You can also use queued winnings as margin on the trade page.</p>
          {queue.length === 0 ? <p className="text-sm text-zinc-500">Nothing queued for you.</p> : (
            <table className="w-full text-sm"><tbody className="font-mono">
              {queue.map((r) => (
                <tr key={r.index} className="border-t border-zinc-800"><td className="py-1">#{r.positionId}</td><td className="text-right">{fmtUsd(r.remaining)} of {fmtUsd(r.original)}</td></tr>
              ))}
            </tbody></table>
          )}
        </Card>
      )}
    </div>
  );
}
