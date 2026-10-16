"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AreaSeries, CandlestickSeries, createChart, createTextWatermark, CrosshairMode, LastPriceAnimationMode, LineStyle, LineType,
  type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import { MARKET_SYMBOLS, type MarketSymbol } from "@/config/contract";
import { liqPrice, netPnl, type Position } from "@/lib/positions";
import { useLive, type Tick } from "@/lib/live";
import { useSettings } from "@/lib/settings";
import { fmtPx, fmtUsd } from "@/lib/format";
import { CHART, useTheme } from "@/lib/theme";

const TFS = ["Tick", "1m", "5m", "15m", "1h", "4h", "1d"] as const;
type Tf = (typeof TFS)[number];
const TF_SEC: Record<Exclude<Tf, "Tick">, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

const pad = (n: number) => String(n).padStart(2, "0");
const hms = (t: number) => { const d = new Date(t * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const hm = (t: number) => { const d = new Date(t * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export interface MarketStats { change24h?: number; vol24h?: number; longOi?: number; shortOi?: number }

export function LiveChart({ market, positions, stats }: { market: MarketSymbol; positions: Position[]; stats: MarketStats }) {
  const live = useLive();
  const theme = useTheme();
  const C = CHART[theme];
  const cRef = useRef(C);
  cRef.current = C;
  const [settings] = useSettings();
  const [tf, setTf] = useState<Tf>("Tick");
  const [tfOpen, setTfOpen] = useState(false);
  const [mOpen, setMOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Area"> | ISeriesApi<"Candlestick"> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const lastBar = useRef<{ time: number; open: number; high: number; low: number; close: number } | null>(null);
  const lastSec = useRef(0);
  const curLine = useRef<IPriceLine | null>(null);
  const prevPx = useRef<number>(0);
  const tfRef = useRef(tf);
  tfRef.current = tf;

  // Build chart + series for the timeframe.
  useEffect(() => {
    if (!box.current) return;
    const tick = tf === "Tick";
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: C.bg }, textColor: C.text, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: C.grid, style: LineStyle.Dashed }, horzLines: { color: C.grid, style: LineStyle.Dashed } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: C.cross, labelBackgroundColor: C.ink }, horzLine: { color: C.cross, labelBackgroundColor: C.ink } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: tick, rightOffset: tick ? 8 : 4, tickMarkFormatter: (t: number) => (tick ? hms(t) : hm(t)) },
      localization: { timeFormatter: (t: number) => (tick ? hms(t) : new Date(t * 1000).toLocaleString()) },
    });
    createTextWatermark(c.panes()[0], { horzAlign: "center", vertAlign: "center", lines: [{ text: "treetrade_", color: C.mark, fontSize: 96, fontStyle: "600" }] });
    if (tick) {
      series.current = c.addSeries(AreaSeries, {
        lineType: LineType.WithSteps, lineColor: C.ink, lineWidth: 2, topColor: C.fill, bottomColor: C.fill2,
        lastPriceAnimation: LastPriceAnimationMode.Continuous, crosshairMarkerBackgroundColor: C.ink,
        lastValueVisible: false, priceLineVisible: false,
      });
      const now = Math.floor(Date.now() / 1000);
      const byS = new Map<number, number>();
      for (const k of live.history(market)) byS.set(Math.floor(k.t / 1000), k.p);
      const liveData = [...byS.entries()].filter(([t]) => t > now - 1800).map(([t, p]) => ({ time: t as UTCTimestamp, value: p }));
      const ser = series.current;
      ser.setData(liveData);
      lastSec.current = liveData.at(-1)?.time ?? 0;
      c.timeScale().applyOptions({ barSpacing: 5 });
      // Seed the line with recent 1-minute closes so it never starts empty; live ticks continue from there.
      fetch(`/api/candles?market=${market}&tf=1m`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j: { points?: { time: number; value: number }[] }) => {
          if (series.current !== ser || !j.points?.length) return;
          const first = liveData[0]?.time ?? Infinity;
          const seed = j.points.filter((p) => p.time > now - 1800 && p.time < first).map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));
          const merged = [...seed, ...liveData.filter((d) => d.time >= lastSec.current - 1800)];
          const cur = (ser as ISeriesApi<"Area">).data() as { time: UTCTimestamp; value: number }[];
          const tail = cur.filter((d) => d.time > (merged.at(-1)?.time ?? 0));
          ser.setData([...merged, ...tail]);
          lastSec.current = Math.max(lastSec.current, ([...merged, ...tail].at(-1)?.time as number) ?? 0);
          c.timeScale().scrollToRealTime();
        })
        .catch(() => {});
    } else {
      series.current = c.addSeries(CandlestickSeries, {
        upColor: C.bg, downColor: C.ink, borderUpColor: C.ink, borderDownColor: C.ink, wickUpColor: C.ink, wickDownColor: C.ink,
        priceLineStyle: LineStyle.Dashed, priceLineColor: C.pline,
      });
      lastBar.current = null;
      const ser = series.current;
      fetch(`/api/candles?market=${market}&tf=${tf}&ohlc=1`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j: { bars?: { time: number; open: number; high: number; low: number; close: number }[] }) => {
          if (!j.bars || series.current !== ser) return;
          ser.setData(j.bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })));
          lastBar.current = j.bars.at(-1) ?? null;
          c.timeScale().fitContent();
        })
        .catch(() => {});
    }
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      lines.current = [];
      curLine.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf, market, theme]);

  // Stream ticks into the series.
  useEffect(
    () =>
      live.onTick((s, k: Tick) => {
        if (s !== market || !series.current) return;
        const sec = Math.floor(k.t / 1000);
        if (tfRef.current === "Tick") {
          const t = Math.max(sec, lastSec.current);
          (series.current as ISeriesApi<"Area">).update({ time: t as UTCTimestamp, value: k.p });
          lastSec.current = t;
          const C = cRef.current;
          const dir = k.p > prevPx.current ? C.up : k.p < prevPx.current ? C.down : undefined;
          prevPx.current = k.p;
          if (!curLine.current) curLine.current = series.current.createPriceLine({ price: k.p, color: C.up, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, axisLabelColor: C.up, axisLabelTextColor: C.labelText });
          else curLine.current.applyOptions({ price: k.p, ...(dir ? { color: dir, axisLabelColor: dir } : {}) });
        } else {
          const step = TF_SEC[tfRef.current as Exclude<Tf, "Tick">];
          const bucket = Math.floor(sec / step) * step;
          const b = lastBar.current;
          if (!b) return;
          const nb = bucket > b.time ? { time: bucket, open: b.close, high: k.p, low: k.p, close: k.p } : { ...b, high: Math.max(b.high, k.p), low: Math.min(b.low, k.p), close: k.p };
          (series.current as ISeriesApi<"Candlestick">).update({ ...nb, time: nb.time as UTCTimestamp });
          lastBar.current = nb;
        }
      }),
    [live, market],
  );

  // Entry / bust lines with live PnL.
  const px = live.last[market]?.p;
  const mine = useMemo(() => positions.filter((p) => p.symbol === market), [positions, market]);
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    lines.current.forEach((l) => s.removePriceLine(l));
    lines.current = [];
    for (const p of mine) {
      const u = px ? netPnl(p, px) : undefined;
      const tag = u === undefined ? "" : ` ${u >= 0 ? "+" : ""}${fmtUsd(u)}`;
      if (settings.showEntries)
        lines.current.push(s.createPriceLine({ price: p.entryPrice, color: p.isLong ? C.up : C.down, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: `${p.isLong ? "LONG" : "SHORT"} ${p.leverage}x${tag}` }));
      const lp = liqPrice(p);
      if (settings.showBusts && lp > 0)
        lines.current.push(s.createPriceLine({ price: lp, color: C.bust, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `BUST #${p.id}` }));
    }
  }, [mine, px, settings.showEntries, settings.showBusts, tf, theme]);

  const up = (stats.change24h ?? 0) >= 0;
  const pill = "rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5";
  return (
    <section className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 text-zinc-100">
      <div className="flex flex-wrap items-center gap-2 p-2">
        <div className="relative">
          <button className={`${pill} flex items-center gap-3`} onClick={() => setMOpen((o) => !o)}>
            <b>{market}</b>
            <span className="font-mono">{fmtPx(px)}</span>
            {stats.change24h !== undefined && <span className={`font-mono text-xs ${up ? "text-emerald-400" : "text-rose-400"}`}>{up ? "+" : ""}{stats.change24h.toFixed(2)}%</span>}
            <span className="text-xs text-zinc-500">▾</span>
          </button>
          {mOpen && (
            <div className="absolute z-20 mt-1 w-40 rounded-md border border-zinc-800 bg-zinc-900 py-1 shadow">
              {MARKET_SYMBOLS.map((m) => (
                <Link key={m} href={`/trade/${m.toLowerCase()}`} className="block px-3 py-1 text-sm hover:bg-zinc-800" onClick={() => setMOpen(false)}>
                  {m}-PERP <span className="float-right font-mono text-xs">{fmtPx(live.last[m]?.p)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className={`${pill} flex items-center gap-3 text-xs`}>
          <span><span className="text-zinc-500">VOL 24H</span> <b className="font-mono">{fmtUsd(stats.vol24h, 0)}</b></span>
          <span className="text-zinc-700">|</span>
          <span><span className="text-zinc-500">LONG OI</span> <b className="font-mono">{fmtUsd(stats.longOi, 0)}</b></span>
          <span className="text-zinc-700">|</span>
          <span><span className="text-zinc-500">SHORT OI</span> <b className="font-mono">{fmtUsd(stats.shortOi, 0)}</b></span>
        </div>
        <div className="relative">
          <button className={`${pill} text-xs`} onClick={() => setTfOpen((o) => !o)}>{tf} ▾</button>
          {tfOpen && (
            <div className="absolute z-20 mt-1 w-24 rounded-md border border-zinc-800 bg-zinc-900 py-1 shadow">
              {TFS.map((t) => (
                <button key={t} className={`block w-full px-3 py-1 text-left text-xs hover:bg-zinc-800 ${t === tf ? "font-bold" : ""}`} onClick={() => { setTf(t); setTfOpen(false); }}>{t}</button>
              ))}
            </div>
          )}
        </div>
        <span className={`${pill} text-xs font-bold ${live.connected ? "text-emerald-400" : "text-rose-400"}`} title={live.connected ? "Streaming live prices" : "Reconnecting…"}>
          {live.connected ? "LIVE" : "RECONNECTING"}
        </span>
      </div>
      <div ref={box} className="h-[460px] w-full" />
    </section>
  );
}
