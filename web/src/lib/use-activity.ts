"use client";
import { visibleInterval } from "@/lib/visible-interval";
import { useEffect, useRef, useState } from "react";
import type { Activity } from "@/lib/activity";
import { decodeTx, mergeActivity, TX_EVENT } from "@/lib/activity-decode";

type Local = ReturnType<typeof decodeTx>;

export function useActivity(intervalMs = 30_000) {
  const [a, setA] = useState<Activity>();
  const [error, setError] = useState<string>();
  /** Events from txs this tab just confirmed; re-applied over server snapshots until the indexer catches up. */
  const local = useRef<{ at: number; d: Local }[]>([]);
  useEffect(() => {
    let alive = true;
    const apply = (base: Activity | undefined) => {
      local.current = local.current.filter((x) => Date.now() - x.at < 5 * 60_000);
      return local.current.reduce((acc, x) => mergeActivity(acc, x.d), base);
    };
    const tick = async () => {
      try {
        const r = await fetch("/api/activity", { cache: "no-store" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "activity unavailable");
        if (alive) {
          setA(apply(j));
          setError(undefined);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    const onTx = (ev: Event) => {
      const d = decodeTx((ev as CustomEvent).detail ?? {});
      if (!d.opens.length && !d.closes.length && !d.deposits.length) return;
      local.current.push({ at: Date.now(), d });
      setA((prev) => mergeActivity(prev, d));
      setTimeout(tick, 6_000);
    };
    window.addEventListener(TX_EVENT, onTx);
    tick();
    const stop = visibleInterval(tick, intervalMs);
    return () => {
      alive = false;
      stop();
      window.removeEventListener(TX_EVENT, onTx);
    };
  }, [intervalMs]);
  return { activity: a, error };
}
