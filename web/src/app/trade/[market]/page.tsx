"use client";
import { use, useEffect, useState } from "react";
import { notFound } from "next/navigation";
import { MARKET_SYMBOLS, type MarketSymbol } from "@/config/contract";
import { useApp } from "@/lib/app-state";
import { useLive } from "@/lib/live";
import { useActivity } from "@/lib/use-activity";
import { TradePanel } from "@/components/TradePanel";
import { PositionsTable } from "@/components/PositionsTable";
import { LiveChart } from "@/components/LiveChart";
import { PoolPanel } from "@/components/PoolPanel";
import { HedgePanel } from "@/components/HedgePanel";
import { Leaderboard, TradeHistory } from "@/components/ActivityTables";

const TABS = ["Positions", "History", "Leaderboard", "Status"] as const;

function use24h(market: MarketSymbol, px?: number) {
  const [open24, setOpen24] = useState<number>();
  useEffect(() => {
    let alive = true;
    fetch(`/api/candles?market=${market}&tf=1h`).then((r) => r.json()).then((j) => {
      const pts = (j.points ?? []) as { time: number; value: number }[];
      const cut = Date.now() / 1000 - 86400;
      const p = pts.find((x) => x.time >= cut);
      if (alive && p) setOpen24(p.value);
    }).catch(() => {});
    return () => { alive = false; };
  }, [market]);
  return open24 && px ? ((px - open24) / open24) * 100 : undefined;
}

export default function TradePage({ params }: { params: Promise<{ market: string }> }) {
  const { market: raw } = use(params);
  const market = raw.toUpperCase() as MarketSymbol;
  if (!MARKET_SYMBOLS.includes(market)) notFound();
  const a = useApp();
  const live = useLive();
  const { activity } = useActivity();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Positions");
  const px = live.last[market]?.p ?? a.quote?.prices[market];
  const change24h = use24h(market, px);
  const day = Date.now() / 1000 - 86400;
  const vol24h = (activity?.opens ?? []).filter((o) => o.market === market && o.ts >= day).reduce((s, o) => s + o.notional, 0)
    + (activity?.trades ?? []).filter((t) => t.market === market && t.ts >= day).reduce((s, t) => s + (t.notional ?? 0), 0);
  const oi = a.pool.openInterest[market];
  const mine = (activity?.trades ?? []).filter((t) => a.address && t.owner.toLowerCase() === a.address.toLowerCase());
  const tabBtn = (t: (typeof TABS)[number]) => (
    <button key={t} className={`px-3 py-2 text-sm ${t === tab ? "border-b-2 border-zinc-100 font-semibold" : "text-zinc-500 hover:text-zinc-200"}`} onClick={() => setTab(t)}>
      {t}
      {t === "Positions" && a.data.positions.length > 0 && <span className="ml-1 rounded-full bg-zinc-100 px-1.5 text-[10px] text-zinc-950">{a.data.positions.length}</span>}
    </button>
  );
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-3">
        <LiveChart market={market} positions={a.data.positions} stats={{ change24h, vol24h, longOi: oi?.long, shortOi: oi?.short }} />
        <section className="card ticker-watermark p-0">
          <div className="relative flex border-b border-zinc-800 px-2">{TABS.map(tabBtn)}</div>
          <div className="relative p-3">
            {tab === "Positions" && (a.data.positions.length === 0
              ? <p className="py-8 text-center text-sm text-zinc-500">{a.address ? "No Open Positions" : "Connect wallet to view your positions."}</p>
              : <PositionsTable positions={a.data.positions} prices={a.quote?.prices} decibel={a.decibel} hedger={a.hedger} submit={a.tx.submit} busy={a.busy} />)}
            {tab === "History" && <TradeHistory trades={mine} empty={a.address ? "No closed trades yet." : "Connect a wallet to see your history."} />}
            {tab === "Leaderboard" && <Leaderboard trades={activity?.trades ?? []} mode="positions" />}
            {tab === "Status" && <PoolPanel pool={a.pool} submit={a.tx.submit} busy={a.busy} />}
          </div>
        </section>
      </div>
      <div className="space-y-3">
        <TradePanel key={market} initialMarket={market} positions={a.data.positions} submitFn={a.tx.submitFn} prices={a.quote?.prices} oracle={a.pool.oracle} maxStaleness={a.pool.maxStaleness} collateral={a.data.collateral} decibel={a.decibel} queued={a.data.queued?.total} sideOi={a.pool.sideOi} submit={a.tx.submit} busy={a.busy} />
        <HedgePanel owner={a.address} data={a.decibel} setSelected={a.setSelected} refresh={a.refreshDecibel} hedger={a.hedger} submitFn={a.tx.submitFn} busy={a.busy} />
      </div>
    </div>
  );
}
