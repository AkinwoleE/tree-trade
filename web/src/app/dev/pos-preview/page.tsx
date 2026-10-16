"use client";
/**
 * Temporary preview: render PositionsTable for any address (no wallet).
 * Used for design QA screenshots. Not linked from nav.
 */
import { useEffect, useMemo, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PositionsTable } from "@/components/PositionsTable";
import { useChainData, usePrices } from "@/lib/hooks";
import { useDecibelAccount, useHedgerStatus } from "@/lib/hedge-hooks";
import { setTheme } from "@/lib/theme";
import { useLive } from "@/lib/live";
import type { PriceQuote } from "@/lib/prices";

function Preview() {
  const sp = useSearchParams();
  const addr = sp.get("addr") || undefined;
  const theme = sp.get("theme") || "dark";
  useEffect(() => {
    setTheme(theme === "light" ? "light" : "dark");
  }, [theme]);

  const { account: data } = useChainData(addr);
  const { data: decibel } = useDecibelAccount(addr);
  const hedger = useHedgerStatus();
  const { quote: polled } = usePrices();
  const live = useLive();
  const fresh = Object.fromEntries(
    Object.entries(live.last)
      .filter(([, t]) => t && Date.now() - t.t < 15_000)
      .map(([s, t]) => [s, t!.p]),
  );
  const quote: PriceQuote | undefined =
    polled || Object.keys(fresh).length
      ? { source: live.source ?? polled?.source ?? "", prices: { ...(polled?.prices ?? {}), ...fresh }, ts: Date.now() }
      : undefined;

  const noop = useMemo(
    () =>
      (async () => {
        /* preview is read-only */
      }) as never,
    [],
  );

  if (!addr) return <p className="p-8 text-sm text-zinc-500">Pass ?addr=0x…&amp;theme=dark</p>;

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-4">
      <div className="text-xs text-zinc-500">Positions preview (read-only)</div>
      <section className="card ticker-watermark p-0">
        <div className="relative flex border-b border-zinc-800 px-2">
          <button className="border-b-2 border-zinc-100 px-3 py-2 text-sm font-semibold">
            Positions
            {data.positions.length > 0 && (
              <span className="ml-1 rounded-full bg-zinc-100 px-1.5 text-[10px] text-zinc-950">{data.positions.length}</span>
            )}
          </button>
          <span className="px-3 py-2 text-sm text-zinc-500">History</span>
          <span className="px-3 py-2 text-sm text-zinc-500">Leaderboard</span>
          <span className="px-3 py-2 text-sm text-zinc-500">Status</span>
        </div>
        <div className="relative p-3">
          {data.positions.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">No Open Positions</p>
          ) : (
            <PositionsTable
              positions={data.positions}
              prices={quote?.prices}
              decibel={decibel}
              hedger={hedger}
              submit={noop}
              busy={false}
            />
          )}
        </div>
      </section>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-zinc-500">Loading…</p>}>
      <Preview />
    </Suspense>
  );
}
