"use client";

import { OneClickTrading } from "@/components/OneClickTrading";
import { useState } from "react";
import {
  ENTRY,
  fn,
  MARKETS,
  MARKET_SYMBOLS,
  MAX_LEVERAGE,
  MIN_LEVERAGE,
  MIN_MARGIN_USDC,
  MIN_NOTIONAL_USDC,
  MAX_NOTIONAL_USDC,
  USDC_DECIMALS,
  type MarketSymbol,
} from "@/config/contract";
import type { Prices } from "@/lib/prices";
import { liqPrice, netPnl, toUnits, type Position } from "@/lib/positions";
import { fmtPx, fmtUsd } from "@/lib/format";
import type { OracleQuote, Submit, SubmitFn } from "@/lib/hooks";
import type { DecibelAccountData } from "@/lib/hedge-hooks";
import { previewHedge } from "@/lib/hedge";
import { useApp } from "@/lib/app-state";
import { enableHedging } from "@/lib/hedge-setup";
import { shortAddr } from "@/lib/chain";
import { Card } from "./ui";


const PRESETS = [1, 10, 50, 100, 250, 500, 1000];

export function TradePanel({
  prices,
  oracle,
  maxStaleness,
  collateral,
  decibel,
  submit,
  busy,
  initialMarket,
  positions = [],
  submitFn,
  queued = 0,
  sideOi,
}: {
  sideOi?: Partial<Record<MarketSymbol, { long: number; short: number; longCap: number; shortCap: number }>>;
  queued?: number;
  submitFn?: SubmitFn;
  initialMarket?: MarketSymbol;
  positions?: Position[];
  prices?: Prices;
  oracle: Partial<Record<MarketSymbol, OracleQuote>>;
  maxStaleness?: number;
  collateral?: number;
  decibel: DecibelAccountData;
  submit: Submit;
  busy: boolean;
}) {
  const [market, setMarket] = useState<MarketSymbol>(initialMarket ?? "BTC");
  const [isLong, setIsLong] = useState(true);
  const [margin, setMargin] = useState("");
  const [leverage, setLeverage] = useState(10);
  const [hedge, setHedge] = useState(false);
  const [fromQueue, setFromQueue] = useState(false);
  const useQueue = fromQueue && queued > 0;

  const mark = prices?.[market];
  const o = oracle[market];
  // Positions open at the on-chain oracle price; fall back to the live mark for previews.
  const entry = o?.price || mark;
  const age = o ? Math.max(0, Math.floor(Date.now() / 1000) - o.publishTime) : undefined;
  const stale = age !== undefined && maxStaleness !== undefined && age > maxStaleness;
  const m = Number(margin);
  const valid = Number.isFinite(m) && m >= MIN_MARGIN_USDC;
  const notional = valid ? m * leverage : 0;
  const estLiq = entry && valid ? liqPrice({ isLong, margin: m, notional, entryPrice: entry, leverage, symbol: market }) : undefined;
  const tooSmall = valid && notional < MIN_NOTIONAL_USDC;
  const tooLarge = valid && notional > MAX_NOTIONAL_USDC;
  const so = sideOi?.[market];
  const room = so && entry ? ((isLong ? so.longCap - so.long : so.shortCap - so.short) * entry) : undefined;
  const overCap = valid && room !== undefined && notional > room;
  const overCollateral = collateral !== undefined && valid && m > collateral;

  // Hedge preview: sized from the Tree Trade entry (oracle) price, priced at the Decibel mark.
  const dm = decibel.markets[market];
  const sub = decibel.selected;
  const hedgeBlock = !sub
    ? "Hedging is not set up yet"
    : !dm
      ? "Decibel market data unavailable"
      : !dm.delegation?.canTrade
        ? `Hedging is not enabled for ${dm.spec.name}`
        : undefined;
  const app = useApp();
  const [settingUp, setSettingUp] = useState(false);
  const [setupMsg, setSetupMsg] = useState<string>();
  const runSetup = async () => {
    if (!app.address) return;
    setSettingUp(true);
    setSetupMsg(undefined);
    try {
      const r = await enableHedging(app.address, app.tx.submitFn);
      if (r.sub) app.setSelected(r.sub);
      if (r.error) setSetupMsg(r.error);
      app.refreshDecibel(true);
    } finally {
      setSettingUp(false);
    }
  };
  const toggleHedge = (on: boolean) => {
    setHedge(on);
    if (on && app.address && (!sub || !dm?.delegation?.canTrade) && !settingUp) void runSetup();
  };
  const hp =
    dm && valid && entry && (dm.mark ?? mark)
      ? previewHedge({ isLong, notionalUsd: notional, entryUsd: entry, markUsd: dm.mark ?? mark!, spec: dm.spec, leverage: dm.userLeverage || Math.min(10, dm.spec.maxLeverage) })
      : undefined;
  const hedgeOn = hedge && !hedgeBlock && !useQueue;
  const shortCollateral = hp && decibel.collateral !== undefined && hp.marginUsd + hp.feesUsd > decibel.collateral;

  const marginInUse = positions.reduce((a, p) => a + p.margin, 0);
  const openPnl = positions.reduce((a, p) => a + (p.symbol && prices?.[p.symbol] ? netPnl(p, prices[p.symbol]!) : 0), 0);
  const [eqOpen, setEqOpen] = useState(true);
  const setM = (v: number) => setMargin(v > 0 ? String(Math.floor(v * 100) / 100) : "");
  const clampLev = (v: number) => Math.max(MIN_LEVERAGE, Math.min(MAX_LEVERAGE, Math.round(v) || MIN_LEVERAGE));
  const insufficient = useQueue ? valid && m > queued : collateral !== undefined && valid && m > collateral;

  return (
    <div className="space-y-3">
      <section className="card space-y-1 py-3">
        <button className="flex w-full items-center justify-between text-sm font-semibold" onClick={() => setEqOpen((o) => !o)}>
          <span>{eqOpen ? "▾" : "▸"} Account Equity</span>
          <span className="font-mono">{collateral !== undefined ? fmtUsd(collateral + marginInUse + openPnl) : "--"}</span>
        </button>
        {eqOpen && (
          <dl className="grid grid-cols-2 gap-y-0.5 pl-4 text-xs">
            <dt className="text-zinc-500">Available to Trade</dt><dd className="text-right font-mono">{collateral !== undefined ? fmtUsd(collateral) : "--"}</dd>
            <dt className="text-zinc-500">Margin in Use</dt><dd className="text-right font-mono">{fmtUsd(marginInUse)}</dd>
            <dt className="text-zinc-500">Open PnL</dt><dd className={`text-right font-mono ${openPnl > 0 ? "text-emerald-400" : openPnl < 0 ? "text-rose-400" : ""}`}>{fmtUsd(openPnl)}</dd>
          </dl>
        )}
      </section>
    <Card title={initialMarket ? `${market}-PERP` : "Trade"}>
      {!initialMarket && (
      <div className="flex min-w-0 flex-col gap-1">
        {MARKET_SYMBOLS.map((s) => (
          <button key={s} className={`btn flex h-9 w-full min-w-[11rem] items-center justify-between gap-3 whitespace-nowrap ${market === s ? "bg-zinc-800" : "btn-ghost"}`} onClick={() => setMarket(s)}>
            <span className="shrink-0">{s}-PERP</span><span className="truncate text-right font-mono tabular-nums text-zinc-400">{fmtPx(prices?.[s])}</span>
          </button>
        ))}
      </div>
      )}

      <div className="grid grid-cols-2 gap-1 rounded-lg border border-zinc-800 p-1">
        <button className={`rounded-md py-1.5 text-sm font-medium ${isLong ? "bg-emerald-950 text-emerald-300" : "text-zinc-400"}`} onClick={() => setIsLong(true)}>⬈ Long</button>
        <button className={`rounded-md py-1.5 text-sm font-medium ${!isLong ? "bg-rose-950 text-rose-300" : "text-zinc-400"}`} onClick={() => setIsLong(false)}>⬊ Short</button>
      </div>

      <div className="flex justify-between text-xs"><span className="text-zinc-500">Available Collateral</span><span className="font-mono">{collateral !== undefined ? fmtUsd(collateral) : "--"}</span></div>

      <div>
        <div className="label mb-1 text-right">Margin (USDC)</div>
        <div className="flex gap-1">
          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => setM(m / 2)}>½×</button>
          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => setM((m || MIN_MARGIN_USDC / 2) * 2)}>2×</button>
          <button className="btn btn-ghost px-2 py-1 text-xs" disabled={!collateral} onClick={() => setM(collateral ?? 0)}>Max</button>
          <input className="input text-right" inputMode="decimal" placeholder={String(MIN_MARGIN_USDC)} value={margin} onChange={(e) => setMargin(e.target.value.replace(/[^0-9.]/g, ""))} />
        </div>
        {margin !== "" && !valid && <p className="mt-1 text-xs text-amber-400">Minimum margin is {MIN_MARGIN_USDC} USDC</p>}
        {tooSmall && <p className="mt-1 text-xs text-amber-400">Minimum position size is {fmtUsd(MIN_NOTIONAL_USDC, 0)} (margin × leverage). Raise margin or leverage.</p>}
        {tooLarge && <p className="mt-1 text-xs text-amber-400">Maximum position size is {fmtUsd(MAX_NOTIONAL_USDC, 0)} (margin × leverage).</p>}
        {overCap && <p className="mt-1 text-xs text-amber-400">Over the {market} {isLong ? "long" : "short"} open-interest cap: about {fmtUsd(Math.max(0, room!), 0)} of room left on this side.</p>}
      </div>

      <div>
        <div className="label mb-1 text-right">Leverage multiplier</div>
        <div className="flex gap-1">
          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => setLeverage(100)}>100×</button>
          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => setLeverage(1000)}>1000×</button>
          <input className="input text-right" inputMode="numeric" value={leverage} onChange={(e) => setLeverage(clampLev(Number(e.target.value.replace(/[^0-9]/g, ""))))} />
        </div>
        <input type="range" min={MIN_LEVERAGE} max={MAX_LEVERAGE} step={1} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))}
          className="mt-2 w-full" style={{ accentColor: leverage > 500 ? "#a3302a" : leverage > 100 ? "#b7791f" : "#2f7d4f" }} />
        <div className="flex justify-between text-[10px] text-zinc-500"><span>x1 Safe</span><span>Wild x1000</span></div>
        <div className="mt-1 flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button key={p} className={`rounded px-2 py-0.5 text-[11px] ${leverage === p ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 hover:bg-zinc-700"}`} onClick={() => setLeverage(p)}>{p}x</button>
          ))}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-y-1 text-sm">
        <dt className="text-zinc-500">Order Value</dt>
        <dd className="text-right font-mono">{fmtUsd(notional)}</dd>
        <dt className="text-zinc-500">Bust Price</dt>
        <dd className="text-right font-mono font-semibold">{fmtPx(estLiq)}</dd>
      </dl>
      <dl className="grid grid-cols-2 gap-y-1 text-xs">
        <dt className="text-zinc-500">Live mark</dt>
        <dd className="text-right font-mono">{fmtPx(mark)}</dd>
        <dt className="text-zinc-500">Oracle (entry)</dt>
        <dd className={`text-right font-mono ${stale ? "text-rose-400" : ""}`}>
          {fmtPx(o?.price)}
          {age !== undefined && <span className="ml-1 text-xs text-zinc-500">{age}s ago</span>}
        </dd>
      </dl>

      <div className="rounded-lg border border-zinc-800 p-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-indigo-500" checked={hedge} onChange={(e) => toggleHedge(e.target.checked)} />
          Hedge on Decibel
          {sub && <span className="ml-auto font-mono text-xs text-zinc-500">{shortAddr(sub)}</span>}
        </label>
        {hedge && hedgeBlock && (
          <div className="mt-2 text-xs">
            <p className="text-amber-400">{settingUp ? "Setting up hedging: approve the one wallet prompt…" : hedgeBlock}</p>
            {!settingUp && app.address && (
              <button className="btn btn-primary mt-1 w-full py-1 text-xs" disabled={busy} onClick={runSetup}>
                Enable hedging (1 signature)
              </button>
            )}
            {setupMsg && <p className="mt-1 text-rose-400">{setupMsg}</p>}
          </div>
        )}
        {hedge && hp && (
          <dl className="mt-2 grid grid-cols-2 gap-y-1 text-xs">
            <dt className="text-zinc-500">Decibel side</dt>
            <dd className={`text-right font-mono ${hp.side === "LONG" ? "text-emerald-400" : "text-rose-400"}`}>
              {hp.side} {dm!.spec.name}
            </dd>
            <dt className="text-zinc-500">Size</dt>
            <dd className="text-right font-mono">
              {hp.sizeBase} {market} ≈ {fmtUsd(hp.notionalUsd)}
            </dd>
            <dt className="text-zinc-500">Margin at {hp.leverage}x</dt>
            <dd className={`text-right font-mono ${shortCollateral ? "text-rose-400" : ""}`}>
              {fmtUsd(hp.marginUsd)} <span className="text-zinc-500">/ {fmtUsd(decibel.collateral)}</span>
            </dd>
            <dt className="text-zinc-500" title="Tier-0 taker fee 0.045%, open + close">
              Est. fees
            </dt>
            <dd className="text-right font-mono">{fmtUsd(hp.feesUsd)}</dd>
            <dt className="text-zinc-500" title="Baseline interest component 0.03%/day, longs pay shorts; the live rate follows the premium">
              Est. funding / day
            </dt>
            <dd className="text-right font-mono">{hp.fundingPerDayUsd > 0 ? `-${fmtUsd(hp.fundingPerDayUsd)}` : `+${fmtUsd(-hp.fundingPerDayUsd)}`}</dd>
          </dl>
        )}
        {hedge && hp?.belowMin && <p className="mt-1 text-xs text-amber-400">Below Decibel minimum size ({dm!.spec.name}); nothing would be hedged.</p>}
        {hedge && hp?.leverageCapped && (
          <p className="mt-1 text-xs text-zinc-500">
            Decibel caps {dm!.spec.name} at {dm!.spec.maxLeverage}x, so the hedge needs more collateral than this position&apos;s margin.
          </p>
        )}
        {hedge && shortCollateral && <p className="mt-1 text-xs text-rose-400">Not enough Trading Account collateral: the hedge would fail.</p>}
      </div>

      {queued > 0 && (
        <label className="flex items-center justify-between text-xs text-zinc-400" title="Your unpaid winnings in the payout queue can be used as margin. A loss cancels that part of your claim; the surviving claim is paid or re-queued on close.">
          <span>Use queued balance as margin ({fmtUsd(queued)})</span>
          <input type="checkbox" checked={fromQueue} onChange={(e) => { setFromQueue(e.target.checked); if (e.target.checked) setHedge(false); }} />
        </label>
      )}
      {stale && <p className="text-xs text-rose-400">Oracle price is stale — is the keeper running? Opening will fail.</p>}

      <button
        className={`btn w-full py-3 ${isLong ? "bg-emerald-600 hover:bg-emerald-500" : "bg-rose-600 hover:bg-rose-500"}`}
        disabled={busy || !valid || tooSmall || tooLarge || overCap || stale || insufficient || (hedge && !!hedgeBlock)}
        onClick={() =>
          useQueue
            ? submit(`Open ${isLong ? "long" : "short"} ${market} ${leverage}x from queue`, ENTRY.openFromQueue, [
                MARKETS[market],
                isLong,
                toUnits(m, USDC_DECIMALS),
                BigInt(leverage),
              ])
            : hedgeOn
            ? submit(`Open hedged ${isLong ? "long" : "short"} ${market} ${leverage}x`, ENTRY.openPositionHedged, [
                MARKETS[market],
                isLong,
                toUnits(m, USDC_DECIMALS),
                BigInt(leverage),
                sub!,
              ])
            : submit(`Open ${isLong ? "long" : "short"} ${market} ${leverage}x`, ENTRY.openPosition, [
                MARKETS[market],
                isLong,
                toUnits(m, USDC_DECIMALS),
                BigInt(leverage),
              ])
        }
      >
        {insufficient ? "Insufficient collateral" : `${isLong ? "Long" : "Short"} ${market} ${leverage}x${hedgeOn ? " + hedge" : ""}`}
      </button>
    </Card>
      <OneClickTrading />
      <section className="card flex items-center justify-between py-2 text-sm">
        <span>Open Positions <span className="font-mono">{positions.length || "--"}</span></span>
        <button className="btn btn-ghost px-2 py-1 text-xs" disabled={busy || positions.length === 0}
          onClick={async () => { for (const p of positions) { if (submitFn) await submitFn(`Close #${p.id}`, fn(ENTRY.closePosition), [BigInt(p.id)]); else submit(`Close #${p.id}`, ENTRY.closePosition, [BigInt(p.id)]); } }}>
          Close All
        </button>
      </section>
    </div>
  );
}
