"use client";
import { visibleInterval } from "@/lib/visible-interval";
import { useEffect, useMemo, useState } from "react";
import { useActivity } from "@/lib/use-activity";
import { useApp } from "@/lib/app-state";
import { fmtNum, fmtUsd } from "@/lib/format";
import { SeriesChart } from "@/components/SeriesChart";
import { Card, Stat } from "@/components/ui";

function cumulative<T extends { ts: number }>(rows: T[], f: (r: T) => number) {
  let acc = 0;
  return [...rows].sort((a, b) => a.ts - b.ts).map((r) => ({ time: r.ts, value: (acc += f(r)) }));
}

export default function Stats() {
  const { activity, error } = useActivity();
  const { pool } = useApp();
  const s = useMemo(() => {
    const trades = activity?.trades ?? [];
    const opens = activity?.opens ?? [];
    const users = new Set([...opens.map((o) => o.owner), ...(activity?.deposits ?? []).map((d) => d.user)]);
    const liq = trades.filter((t) => t.kind === "liquidation");
    return {
      volume: opens.reduce((a, o) => a + o.notional, 0) + trades.reduce((a, t) => a + (t.notional ?? 0), 0),
      liqVolume: liq.reduce((a, t) => a + (t.notional ?? t.margin), 0),
      trades: opens.length + trades.length,
      users: users.size,
      volSeries: cumulative([...opens.map((o) => ({ ts: o.ts, v: o.notional })), ...trades.map((t) => ({ ts: t.ts, v: t.notional ?? 0 }))], (r) => r.v),
      pnlSeries: cumulative(trades, (t) => t.pnl),
      liqSeries: cumulative(liq, (t) => t.notional ?? t.margin),
      tradeSeries: cumulative([...opens, ...trades], () => 1),
      userSeries: (() => {
        const seen = new Set<string>();
        return [...opens].sort((a, b) => a.ts - b.ts).flatMap((o) => (seen.has(o.owner) ? [] : (seen.add(o.owner), [{ time: o.ts, value: seen.size }])));
      })(),
    };
  }, [activity]);
  const [ru, setRu] = useState<{ openNow: number; active24h: number; allTime: number } | null>(null);
  useEffect(() => {
    let live = true;
    const get = () => fetch("/api/stats/users", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => live && j && !j.error && setRu(j)).catch(() => {});
    get();
    const stop = visibleInterval(get, 60_000);
    return () => { live = false; stop(); };
  }, []);
  const tvl = pool.accounting?.[0];
  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-6">
        <Card title="Volume"><Stat label="" value={fmtUsd(s.volume, 0)} /></Card>
        <Card title="Liq. volume"><Stat label="" value={fmtUsd(s.liqVolume, 0)} /></Card>
        <Card title="Trades"><Stat label="" value={fmtNum(s.trades, 0)} /></Card>
        <Card title="Users"><Stat label="" value={fmtNum(s.users, 0)} /></Card>
        <Card title="Rewards"><Stat label="" value={fmtUsd(pool.rewards?.[0])} /></Card>
        <Card title="TVL"><Stat label="" value={fmtUsd(tvl, 0)} /></Card>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Card title="Trading now"><Stat label="Real traders with an open position" value={ru ? fmtNum(ru.openNow, 0) : "…"} /></Card>
        <Card title="Active 24h"><Stat label="Real traders in the last 24h" value={ru ? fmtNum(ru.active24h, 0) : "…"} /></Card>
        <Card title="Real traders"><Stat label="All-time unique (test accounts excluded)" value={ru ? fmtNum(ru.allTime, 0) : "…"} /></Card>
      </div>
      {activity?.partial && <p className="text-xs text-zinc-500">Charts cover the most recent on-chain activity.</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Total volume"><SeriesChart points={s.volSeries} /></Card>
        <Card title="Total trader PnL"><SeriesChart points={s.pnlSeries} color="#60a5fa" /></Card>
        <Card title="Total liquidation volume"><SeriesChart points={s.liqSeries} color="#fb7185" /></Card>
        <Card title="Total trades"><SeriesChart points={s.tradeSeries} color="#f59e0b" /></Card>
        <Card title="Total users"><SeriesChart points={s.userSeries} color="#a78bfa" /></Card>
      </div>
    </div>
  );
}
