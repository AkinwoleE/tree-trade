"use client";
import { useEffect, useRef, useState } from "react";
import { createChart, LineSeries, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { CHART, useTheme } from "@/lib/theme";
import { MARKET_SYMBOLS, type MarketSymbol } from "@/config/contract";
import { liqPrice, type Position } from "@/lib/positions";
import { Card } from "@/components/ui";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
type Tf = (typeof TIMEFRAMES)[number];

/** Live line chart (TradingView lightweight-charts v5) with entry/liquidation lines for open positions. */
export function PriceChart({ prices, positions, initialMarket }: { prices?: Partial<Record<MarketSymbol, number>>; positions: Position[]; initialMarket?: MarketSymbol }) {
  const [market, setMarket] = useState<MarketSymbol>(initialMarket ?? MARKET_SYMBOLS[0]);
  const [tf, setTf] = useState<Tf>("5m");
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Line"> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const lastTime = useRef(0);

  // Create the chart once.
  const theme = useTheme();
  const P = CHART[theme];
  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: P.text },
      grid: { vertLines: { color: P.grid }, horzLines: { color: P.grid } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: P.border },
      rightPriceScale: { borderColor: P.border },
    });
    series.current = c.addSeries(LineSeries, { color: "#34d399", lineWidth: 2 });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      lines.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    chart.current?.applyOptions({ layout: { textColor: P.text }, grid: { vertLines: { color: P.grid }, horzLines: { color: P.grid } }, timeScale: { borderColor: P.border }, rightPriceScale: { borderColor: P.border } });
  }, [P]);

  // Load history on market/timeframe change.
  useEffect(() => {
    let alive = true;
    setError(undefined);
    fetch(`/api/candles?market=${market}&tf=${tf}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { points?: { time: number; value: number }[]; error?: string }) => {
        if (!alive || !series.current) return;
        if (!j.points) throw new Error(j.error || "chart data unavailable");
        series.current.setData(j.points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
        lastTime.current = j.points.at(-1)?.time ?? 0;
        chart.current?.timeScale().fitContent();
      })
      .catch((e: Error) => alive && setError(e.message || "chart data unavailable"));
    return () => {
      alive = false;
    };
  }, [market, tf]);

  // Live tick: update the last point with the current price.
  const px = prices?.[market];
  useEffect(() => {
    if (!px || !series.current || !lastTime.current) return;
    const now = Math.floor(Date.now() / 1000);
    const t = Math.max(lastTime.current, now);
    series.current.update({ time: t as UTCTimestamp, value: px });
    lastTime.current = t;
  }, [px]);

  // Entry / liquidation lines for open positions in this market.
  const key = positions.filter((p) => p.symbol === market).map((p) => `${p.id}:${p.entryPrice}:${p.liqPrice ?? ""}`).join("|");
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    lines.current.forEach((l) => s.removePriceLine(l));
    lines.current = [];
    for (const p of positions.filter((p) => p.symbol === market)) {
      const side = p.isLong ? "LONG" : "SHORT";
      lines.current.push(
        s.createPriceLine({ price: p.entryPrice, color: p.isLong ? "#34d399" : "#fb7185", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: `#${p.id} ${side} entry` }),
      );
      const lp = liqPrice(p);
      if (lp > 0) lines.current.push(s.createPriceLine({ price: lp, color: "#f59e0b", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `#${p.id} liq` }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, market]);

  const btn = (on: boolean) => `rounded px-2 py-0.5 text-xs ${on ? "bg-emerald-500/20 text-emerald-300" : "text-zinc-400 hover:text-zinc-200"}`;
  return (
    <Card
      title="Price"
      right={
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1">
            {MARKET_SYMBOLS.map((m) => (
              <button key={m} className={`${btn(m === market)} whitespace-nowrap`} onClick={() => setMarket(m)}>{m}</button>
            ))}
          </div>
          <div className="flex gap-1">
            {TIMEFRAMES.map((t) => (
              <button key={t} className={btn(t === tf)} onClick={() => setTf(t)}>{t}</button>
            ))}
          </div>
        </div>
      }
    >
      <div ref={box} className="h-80 w-full" />
      {error && <p className="mt-1 text-xs text-rose-400">{error}</p>}
    </Card>
  );
}
