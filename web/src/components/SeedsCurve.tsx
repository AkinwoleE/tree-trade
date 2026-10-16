"use client";
import { visibleInterval } from "@/lib/visible-interval";
import { useEffect, useState } from "react";
import { VIEW } from "@/config/contract";
import { view } from "@/lib/chain";
import { fmtNum } from "@/lib/format";
import { Card, Stat } from "./ui";

type Curve = { lp: number; neg: boolean; rate: number; flat: number; threshold: number; scale: number; hwm: number; minted: number; basis: number };

const U = 1e6;
const rateAt = (c: Pick<Curve, "flat" | "scale">, h: number) => c.flat * (c.scale / (c.scale + h)) ** 2;
const fmtM = (v: number) => (v >= 1e6 ? `$${fmtNum(v / 1e6, v >= 1e8 ? 0 : 1)}M` : `$${fmtNum(v, 0)}`);

export function useSeedsCurve(intervalMs = 60_000) {
  const [c, setC] = useState<Curve>();
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [r, p] = await Promise.all([view(VIEW.seedsRate), view(VIEW.curveParams)]);
        if (!live) return;
        setC({
          lp: Number(r[0]) / U, neg: Boolean(r[1]), rate: Number(r[2]) / 1e6,
          flat: Number(p[0]), threshold: Number(p[1]) / U, scale: Number(p[2]) / U, hwm: Number(p[3]) / U,
          minted: Number(p[4]) / U, basis: Number(p[5]) / U,
        });
      } catch { /* keep last */ }
    };
    load();
    const stop = visibleInterval(load, intervalMs);
    return () => { live = false; stop(); };
  }, [intervalMs]);
  return c;
}

/** Marginal SEEDS-per-$1 vs tail high-water mark, with the live position marked. */
export function SeedsCurve() {
  const c = useSeedsCurve();
  const W = 520, Hh = 180, P = 32;
  const maxH = c ? Math.max(c.scale * 3, c.hwm * 1.3) : 360e6;
  const pts: string[] = [];
  if (c) for (let i = 0; i <= 100; i++) {
    const h = (maxH * i) / 100;
    pts.push(`${P + ((W - 2 * P) * i) / 100},${P + (Hh - 2 * P) * (1 - rateAt(c, h) / c.flat)}`);
  }
  const inTail = c && !c.neg && c.lp >= c.threshold;
  const mx = c ? P + ((W - 2 * P) * Math.min(c.hwm, maxH)) / maxH : 0;
  const my = c ? P + (Hh - 2 * P) * (1 - rateAt(c, c.hwm) / c.flat) : 0;
  return (
    <Card title="SEEDS mint curve">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Current rate" value={c ? `${fmtNum(c.rate, 2)} / $1` : "–"} sub="SEEDS per $1 of loss" />
        <Stat label="Tracked LP" value={c ? `${c.neg ? "-" : ""}${fmtM(c.lp)}` : "–"} sub={c ? (inTail ? "tail region" : `flat until ${fmtM(c.threshold)}`) : undefined} />
        <Stat label="Tail high-water mark" value={c ? fmtM(c.hwm) : "–"} sub="never decreases" />
        <Stat label="Avg minted" value={c && c.basis ? `${fmtNum(c.minted / c.basis, 2)} / $1` : "–"} sub="since curve launch" />
      </div>
      <svg viewBox={`0 0 ${W} ${Hh}`} className="w-full" role="img" aria-label="SEEDS mint rate curve">
        <line x1={P} y1={Hh - P} x2={W - P} y2={Hh - P} stroke="currentColor" opacity={0.2} />
        <line x1={P} y1={P} x2={P} y2={Hh - P} stroke="currentColor" opacity={0.2} />
        {c && <polyline fill="none" stroke="#22c55e" strokeWidth={2} points={pts.join(" ")} />}
        {c && <circle cx={mx} cy={my} r={5} fill="#f59e0b" />}
        <text x={P} y={P - 8} fontSize={10} fill="currentColor" opacity={0.6}>{c ? `${c.flat} / $1` : ""}</text>
        <text x={W - P} y={Hh - 10} fontSize={10} textAnchor="end" fill="currentColor" opacity={0.6}>tail high-water mark → {c ? fmtM(maxH) : ""}</text>
        <text x={P} y={Hh - 10} fontSize={10} fill="currentColor" opacity={0.6}>$0</text>
      </svg>
      <p className="text-xs text-zinc-500">
        Rate = {c?.flat ?? 100} × (S / (S + H))², with S = {c ? fmtM(c.scale) : "$120M"} and H = the high-water mark of LP gains
        earned while tracked LP (pool minus queued payouts) is at or above {c ? fmtM(c.threshold) : "$2M"}. Below that, or while the
        LP is underwater, every $1 of eligible loss mints the full {c?.flat ?? 100} SEEDS. The mark only moves up: payouts and
        staker sweeps never restore the rate. Example: at H = $100M the rate is ≈ 29.8 / $1; at H = $171M ≈ 17 / $1.
      </p>
    </Card>
  );
}
