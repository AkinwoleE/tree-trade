"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { MARKET_SYMBOLS, type MarketSymbol } from "@/config/contract";

export interface Tick { t: number; p: number }
interface Live {
  connected: boolean;
  source?: string;
  last: Partial<Record<MarketSymbol, Tick>>;
  /** subscribe to raw ticks (for the chart); returns unsubscribe */
  onTick: (fn: (s: MarketSymbol, tick: Tick) => void) => () => void;
  /** recent ticks per market (up to ~30 min) */
  history: (s: MarketSymbol) => Tick[];
}
const Ctx = createContext<Live | null>(null);
const KEEP_MS = 30 * 60_000;

/** One EventSource for the whole app; EventSource reconnects on its own (server sends retry: 500). */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [source, setSource] = useState<string>();
  const [last, setLast] = useState<Live["last"]>({});
  const subs = useRef(new Set<(s: MarketSymbol, t: Tick) => void>());
  const hist = useRef<Record<string, Tick[]>>(Object.fromEntries(MARKET_SYMBOLS.map((s) => [s, []])));

  useEffect(() => {
    let es: EventSource | undefined;
    let pending: Live["last"] = {};
    let raf = 0;
    let dead = false;
    let downSince = 0;
    let watchdog: ReturnType<typeof setInterval>;
    const open = () => {
      es?.close();
      es = new EventSource("/api/stream");
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        // Brief gaps between relay connections are normal; only show "reconnecting" after 3 s.
        downSince ||= Date.now();
      };
      es.addEventListener("source", (e) => setSource(JSON.parse((e as MessageEvent).data)));
      es.onmessage = (e) => {
        downSince = 0;
        setConnected(true);
        const { s, p, t } = JSON.parse(e.data) as { s: MarketSymbol; p: number; t: number };
        const tick = { t: Math.max(t, Date.now() - 2000), p };
        const h = hist.current[s];
        if (!h) return;
        if (h.length && tick.t < h[h.length - 1].t) tick.t = h[h.length - 1].t;
        h.push(tick);
        while (h.length && h[0].t < tick.t - KEEP_MS) h.shift();
        subs.current.forEach((fn) => fn(s, tick));
        pending = { ...pending, [s]: tick };
        if (!raf) raf = requestAnimationFrame(() => {
          raf = 0;
          setLast((l) => ({ ...l, ...pending }));
          pending = {};
        });
      };
    };
    // Hidden tabs drop the stream (each connection holds an upstream feed socket) and reconnect when shown.
    const onVis = () => {
      if (document.hidden) {
        es?.close();
        es = undefined;
      } else if (!es) open();
    };
    document.addEventListener("visibilitychange", onVis);
    if (!document.hidden) open();
    watchdog = setInterval(() => {
      if (dead || document.hidden) return;
      if (downSince && Date.now() - downSince > 3000) setConnected(false);
      // If nothing arrives for 10 s, force a fresh connection.
      const latest = Math.max(0, ...MARKET_SYMBOLS.map((s) => hist.current[s].at(-1)?.t ?? 0));
      if (latest && Date.now() - latest > 10_000 && es?.readyState !== EventSource.CONNECTING) open();
      else if (!es) open();
    }, 1000);
    return () => {
      dead = true;
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(watchdog);
      cancelAnimationFrame(raf);
      es?.close();
    };
  }, []);

  const v: Live = {
    connected,
    source,
    last,
    onTick: (fn) => {
      subs.current.add(fn);
      return () => subs.current.delete(fn);
    },
    history: (s) => hist.current[s] ?? [],
  };
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useLive(): Live {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLive outside LiveProvider");
  return v;
}
