"use client";
import { useEffect, useRef } from "react";
import { createChart, LineSeries, type UTCTimestamp } from "lightweight-charts";
import { CHART, useTheme } from "@/lib/theme";

/** Small line chart for a time series (lightweight-charts v5). */
export function SeriesChart({ points, color = "#34d399" }: { points: { time: number; value: number }[]; color?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  const P = CHART[theme];
  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: P.text },
      grid: { vertLines: { visible: false }, horzLines: { color: P.grid } },
      timeScale: { timeVisible: true, borderColor: P.border },
      rightPriceScale: { borderColor: P.border },
    });
    const s = c.addSeries(LineSeries, { color, lineWidth: 2 });
    // lightweight-charts needs strictly increasing times: merge points in the same second.
    const m = new Map<number, number>();
    for (const p of points) m.set(p.time, p.value);
    s.setData([...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ time: t as UTCTimestamp, value: v })));
    c.timeScale().fitContent();
    return () => c.remove();
  }, [points, color, theme]);
  return <div ref={box} className="h-48 w-full" />;
}
