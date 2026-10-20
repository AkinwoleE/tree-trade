"use client";
/**
 * Browser-direct public market-data WebSockets for the live price display (no key, no server hop,
 * so no Vercel function time and no Geomi calls). Display only: trades never use these prices.
 *
 * Native streams, per each venue's official docs:
 *  - Binance market-data-only mirror  wss://data-stream.binance.vision  combined `<sym>@bookTicker` (real-time BBO),
 *    USDT pairs converted to USD with `usdcusdt@bookTicker`
 *  - Coinbase Exchange                wss://ws-feed.exchange.coinbase.com  `ticker` channel (per match, carries BBO)
 *  - Kraken WS v2                     wss://ws.kraken.com/v2  `ticker` channel, event_trigger "bbo"
 * Each feed reports the top-of-book mid. The hub takes the median of the fresh feeds, drops any feed more
 * than INLIER_BPS from that median, and emits the average of the rest (a median-filtered mean: one bad
 * feed can't move it, and it moves on every feed's update instead of only the middle one's), throttled
 * to EMIT_MS. Each socket reconnects with exponential backoff + jitter. Feed names never reach the UI.
 */
import { MARKET_SYMBOLS, type MarketSymbol } from "@/config/contract";

type Emit = (s: MarketSymbol, p: number) => void;
interface FeedSpec {
  id: string;
  url: string;
  subscribe?: unknown;
  parse: (j: any, emit: Emit) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const mid = (b: unknown, a: unknown) => {
  const bid = Number(b), ask = Number(a);
  return bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : NaN;
};
const bySuffix = (raw: string, sep: string) => {
  const base = raw.split(sep)[0]?.toUpperCase() as MarketSymbol;
  return MARKET_SYMBOLS.includes(base) ? base : undefined;
};

export const FEEDS: FeedSpec[] = [
  {
    // USDT-quoted (deepest books), converted to USD with the live USDC/USDT mid (USDC ~ USD).
    id: "a",
    url: `wss://data-stream.binance.vision/stream?streams=${[...MARKET_SYMBOLS.map((s) => `${s.toLowerCase()}usdt`), "usdcusdt"].map((x) => `${x}@bookTicker`).join("/")}`,
    parse: (() => {
      let usdcUsdt = 0;
      return (j: any, emit: Emit) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const d = j?.data;
        if (!d?.s) return;
        const m = mid(d.b, d.a);
        if (d.s === "USDCUSDT") {
          if (m > 0.98 && m < 1.02) usdcUsdt = m;
          return;
        }
        if (!usdcUsdt || !String(d.s).endsWith("USDT")) return;
        const s = bySuffix(String(d.s).slice(0, -4), "/");
        if (s) emit(s, m / usdcUsdt);
      };
    })(),
  },
  {
    id: "b",
    url: "wss://ws-feed.exchange.coinbase.com",
    subscribe: { type: "subscribe", product_ids: MARKET_SYMBOLS.map((s) => `${s}-USD`), channels: ["ticker"] },
    parse: (j, emit) => {
      if (j?.type !== "ticker" || !j.product_id) return;
      const s = bySuffix(String(j.product_id), "-");
      if (!s) return;
      const m = mid(j.best_bid, j.best_ask);
      emit(s, Number.isFinite(m) ? m : Number(j.price));
    },
  },
  {
    id: "c",
    url: "wss://ws.kraken.com/v2",
    subscribe: { method: "subscribe", params: { channel: "ticker", symbol: MARKET_SYMBOLS.map((s) => `${s}/USD`), event_trigger: "bbo" } },
    parse: (j, emit) => {
      if (j?.channel !== "ticker" || !Array.isArray(j.data)) return;
      for (const d of j.data) {
        const s = bySuffix(String(d.symbol ?? ""), "/");
        if (!s) continue;
        const m = mid(d.bid, d.ask);
        emit(s, Number.isFinite(m) ? m : Number(d.last));
      }
    },
  },
];

/** A feed's price counts toward the median while it is this fresh. */
const FRESH_MS = 10_000;
/** A connected socket that sends nothing for this long is treated as dead and reconnected. */
const SILENT_MS = 20_000;
const BACKOFF_MIN = 1_000;
const BACKOFF_MAX = 30_000;
/** Emit at most this often per market (still well under a second). */
const EMIT_MS = 200;

/** Feeds further than this from the median are ignored for that tick. */
const INLIER_BPS = 15;

/** Median of the inputs, then the mean of the inputs within INLIER_BPS of it. */
export function robustPrice(xs: number[]): number {
  const m = median(xs);
  if (!(m > 0)) return NaN;
  const ok = xs.filter((x) => Math.abs(x / m - 1) * 10_000 <= INLIER_BPS);
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : m;
}

export function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  return n === 0 ? NaN : n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

interface FeedState {
  spec: FeedSpec;
  ws?: WebSocket;
  attempt: number;
  retry?: ReturnType<typeof setTimeout>;
  lastMsg: number;
  px: Partial<Record<MarketSymbol, { p: number; t: number }>>;
}

export class FeedHub {
  private feeds: FeedState[];
  private running = false;
  private watchdog?: ReturnType<typeof setInterval>;
  private lastEmit: Partial<Record<MarketSymbol, number>> = {};
  private pending: Partial<Record<MarketSymbol, ReturnType<typeof setTimeout>>> = {};
  private lastValue: Partial<Record<MarketSymbol, { p: number; t: number }>> = {};

  constructor(private onPrice: (s: MarketSymbol, p: number, sources: number) => void, specs: FeedSpec[] = FEEDS) {
    this.feeds = specs.map((spec) => ({ spec, attempt: 0, lastMsg: 0, px: {} }));
  }

  start() {
    if (this.running || typeof WebSocket === "undefined") return;
    this.running = true;
    for (const f of this.feeds) this.connect(f);
    this.watchdog = setInterval(() => {
      const now = Date.now();
      for (const f of this.feeds)
        if (f.ws?.readyState === WebSocket.OPEN && now - f.lastMsg > SILENT_MS) this.drop(f, true);
    }, 5_000);
  }

  stop() {
    this.running = false;
    clearInterval(this.watchdog);
    for (const s of MARKET_SYMBOLS) clearTimeout(this.pending[s]);
    this.pending = {};
    for (const f of this.feeds) {
      clearTimeout(f.retry);
      f.retry = undefined;
      this.close(f);
      f.px = {};
      f.attempt = 0;
    }
  }

  /** Number of feeds with a fresh price for any market. */
  liveCount(now = Date.now()): number {
    return this.feeds.filter((f) => Object.values(f.px).some((x) => x && now - x.t < FRESH_MS)).length;
  }

  private close(f: FeedState) {
    const ws = f.ws;
    f.ws = undefined;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {}
  }

  private drop(f: FeedState, reconnect: boolean) {
    this.close(f);
    if (reconnect && this.running && !f.retry) {
      const base = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** f.attempt);
      const delay = base / 2 + Math.random() * (base / 2); // jitter
      f.attempt++;
      f.retry = setTimeout(() => {
        f.retry = undefined;
        this.connect(f);
      }, delay);
    }
  }

  private connect(f: FeedState) {
    if (!this.running || f.ws) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(f.spec.url);
    } catch {
      return this.drop(f, true);
    }
    f.ws = ws;
    f.lastMsg = Date.now();
    ws.onopen = () => {
      f.lastMsg = Date.now();
      if (f.spec.subscribe) ws.send(JSON.stringify(f.spec.subscribe));
    };
    ws.onmessage = (ev) => {
      f.lastMsg = Date.now();
      let j: unknown;
      try {
        j = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      f.spec.parse(j, (s, p) => {
        if (!(p > 0) || !Number.isFinite(p)) return;
        f.attempt = 0; // healthy data: reset the backoff
        f.px[s] = { p, t: Date.now() };
        this.schedule(s);
      });
    };
    ws.onerror = () => this.drop(f, true);
    ws.onclose = () => this.drop(f, true);
  }

  private schedule(s: MarketSymbol) {
    if (this.pending[s]) return;
    const wait = Math.max(0, (this.lastEmit[s] ?? 0) + EMIT_MS - Date.now());
    this.pending[s] = setTimeout(() => {
      this.pending[s] = undefined;
      if (!this.running) return;
      const now = Date.now();
      const xs = this.feeds.map((f) => f.px[s]).filter((x): x is { p: number; t: number } => !!x && now - x.t < FRESH_MS).map((x) => x.p);
      if (!xs.length) return;
      const m = robustPrice(xs);
      this.lastEmit[s] = now;
      const prev = this.lastValue[s];
      if (prev && m === prev.p && now - prev.t < 1_000) return; // unchanged: still re-emit once a second
      this.lastValue[s] = { p: m, t: now };
      this.onPrice(s, m, xs.length);
    }, wait);
  }
}
