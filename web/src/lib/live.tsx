"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { MARKET_SYMBOLS, type MarketSymbol } from "@/config/contract";
import { FeedHub } from "@/lib/price-feeds";
import { guardPrice } from "@/lib/price-anchor";

export interface Tick { t: number; p: number }
interface Live {
  connected: boolean;
  /** generic label only ("Live"); never a venue name */
  source?: string;
  last: Partial<Record<MarketSymbol, Tick>>;
  /** subscribe to raw ticks (for the chart); returns unsubscribe */
  onTick: (fn: (s: MarketSymbol, tick: Tick) => void) => () => void;
  /** recent ticks per market (up to ~30 min) */
  history: (s: MarketSymbol) => Tick[];
}
const Ctx = createContext<Live | null>(null);
const KEEP_MS = 30 * 60_000;
/** Use the server SSE stream only when no browser WebSocket feed has ticked for this long. */
const WS_GRACE_MS = 5_000;

/**
 * Live display prices. Primary: the browser connects straight to free public market-data WebSockets
 * (lib/price-feeds.ts) and shows their median, sub-second, at no server cost. Fallback: the existing
 * /api/stream SSE relay, opened only while every WebSocket feed is down. Every tick is display-only
 * and passes the 0.3% sanity guard against the latest signed / on-chain price (lib/price-anchor.ts).
 * Hidden tabs close every socket and reconnect when shown.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [last, setLast] = useState<Live["last"]>({});
  const subs = useRef(new Set<(s: MarketSymbol, t: Tick) => void>());
  const hist = useRef<Record<string, Tick[]>>(Object.fromEntries(MARKET_SYMBOLS.map((s) => [s, []])));

  useEffect(() => {
    let es: EventSource | undefined;
    let pending: Live["last"] = {};
    let raf = 0;
    let lastWsTick = 0;
    let lastSseTick = 0;
    let startedAt = 0;

    const push = (s: MarketSymbol, raw: number, t: number) => {
      const h = hist.current[s];
      if (!h || !(raw > 0)) return;
      const tick = { t, p: guardPrice(s, raw).p };
      if (h.length && tick.t < h[h.length - 1].t) tick.t = h[h.length - 1].t;
      h.push(tick);
      while (h.length && h[0].t < tick.t - KEEP_MS) h.shift();
      subs.current.forEach((fn) => fn(s, tick));
      pending = { ...pending, [s]: tick };
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        // Snapshot first: the updater runs later, after `pending` has been reset.
        const batch = pending;
        pending = {};
        setLast((l) => ({ ...l, ...batch }));
      });
    };

    const hub = new FeedHub((s, p) => {
      lastWsTick = Date.now();
      push(s, p, lastWsTick);
    });

    const closeSse = () => {
      es?.close();
      es = undefined;
    };
    const openSse = () => {
      closeSse();
      es = new EventSource("/api/stream");
      es.onmessage = (e) => {
        if (Date.now() - lastWsTick < WS_GRACE_MS) return; // WebSockets are back: ignore the relay
        try {
          const { s, p, t } = JSON.parse(e.data) as { s: MarketSymbol; p: number; t: number };
          lastSseTick = Date.now();
          push(s, p, Math.max(t, Date.now() - 2000));
        } catch {}
      };
    };

    const start = () => {
      startedAt = Date.now();
      hub.start();
    };
    const stopAll = () => {
      hub.stop();
      closeSse();
    };
    const onVis = () => (document.hidden ? stopAll() : start());
    document.addEventListener("visibilitychange", onVis);
    if (!document.hidden) start();

    const watchdog = setInterval(() => {
      if (document.hidden) return;
      const now = Date.now();
      const wsUp = now - lastWsTick < WS_GRACE_MS;
      if (wsUp) closeSse();
      else if (now - startedAt > WS_GRACE_MS) {
        // All browser feeds down: use the server relay; reopen it if it has gone quiet too.
        if (!es || (now - lastSseTick > 10_000 && es.readyState !== EventSource.CONNECTING && now - startedAt > 15_000)) openSse();
      }
      setConnected(wsUp || now - lastSseTick < WS_GRACE_MS);
    }, 1000);

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(watchdog);
      cancelAnimationFrame(raf);
      stopAll();
    };
  }, []);

  const v: Live = {
    connected,
    source: connected ? "Live" : undefined,
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
