/**
 * Pluggable price sources. Pure `fetch`-based so it runs in the browser,
 * in Next route handlers and in the keeper (Node 18+).
 */
import { MARKET_SYMBOLS, type MarketSymbol } from "../../config/contract";

export type Prices = Partial<Record<MarketSymbol, number>>;

export interface PriceSource {
  readonly name: string;
  fetchPrices(): Promise<Prices>;
}

export interface PriceQuote {
  source: string;
  prices: Prices;
  ts: number;
}

const hasAll = (p: Prices) => MARKET_SYMBOLS.every((s) => Number.isFinite(p[s]) && (p[s] as number) > 0);

/* ------------------------------------------------------------------ */
/* Decibel                                                             */
/* ------------------------------------------------------------------ */

export const DECIBEL_BASE_URL = "https://api.testnet.aptoslabs.com/decibel/api/v1";

export interface DecibelOptions {
  /** Base URL that serves `/prices` and `/markets`. In the browser this is our proxy route. */
  baseUrl?: string;
  /** Bearer key. Omit when going through the proxy (the server adds it). */
  apiKey?: string;
  /** Reuse the last good quote for this long (ms) to save keyed calls; 0 = always fetch. */
  minIntervalMs?: number;
}

type Obj = Record<string, unknown>;

/** Map a market name like "BTC/USD", "BTC-PERP" or "BTCUSD" to our symbol. */
export function symbolFromName(name: unknown): MarketSymbol | undefined {
  if (typeof name !== "string") return undefined;
  const base = name.toUpperCase().split(/[\/\-_:]/)[0].replace(/USDC?$|PERP$/, "");
  return MARKET_SYMBOLS.find((s) => s === base);
}

function scalePrice(v: unknown, decimals?: unknown): number {
  const n = Number(v);
  const d = Number(decimals);
  // Integer-encoded prices come with px_decimals in the market config.
  if (Number.isFinite(d) && d > 0 && Number.isInteger(n)) return n / 10 ** d;
  return n;
}

const arrayOf = (j: unknown): Obj[] => {
  if (Array.isArray(j)) return j as Obj[];
  if (j && typeof j === "object") {
    const o = j as Obj;
    for (const k of ["data", "items", "prices", "markets"]) if (Array.isArray(o[k])) return o[k] as Obj[];
  }
  return [];
};

export class DecibelSource implements PriceSource {
  readonly name = "decibel";
  private marketNames?: Map<string, { symbol?: MarketSymbol; pxDecimals?: unknown }>;

  constructor(private opts: DecibelOptions = {}) {}

  private async get(path: string): Promise<unknown> {
    const base = this.opts.baseUrl ?? DECIBEL_BASE_URL;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const res = await fetch(`${base}/${path}`, { headers });
    if (!res.ok) throw new Error(`decibel ${path}: HTTP ${res.status}`);
    return res.json();
  }

  private async markets() {
    if (this.marketNames) return this.marketNames;
    const map = new Map<string, { symbol?: MarketSymbol; pxDecimals?: unknown }>();
    for (const m of arrayOf(await this.get("markets"))) {
      const addr = String(m.market_addr ?? m.market ?? m.address ?? "").toLowerCase();
      if (addr) map.set(addr, { symbol: symbolFromName(m.market_name ?? m.name ?? m.symbol), pxDecimals: m.px_decimals });
    }
    this.marketNames = map;
    return map;
  }

  private last?: { at: number; px: Prices };
  async fetchPrices(): Promise<Prices> {
    const ttl = this.opts.minIntervalMs ?? 0;
    if (ttl > 0 && this.last && Date.now() - this.last.at < ttl) return this.last.px;
    const px = await this.fetchFresh();
    this.last = { at: Date.now(), px };
    return px;
  }

  private async fetchFresh(): Promise<Prices> {
    const rows = arrayOf(await this.get("prices"));
    const out: Prices = {};
    let needMarkets = false;
    for (const r of rows) {
      const sym = symbolFromName(r.market_name ?? r.symbol ?? r.name ?? r.market);
      const px = r.oracle_px ?? r.mark_px; // never mid_px: a thin book mid is manipulable (ORACLE_RISK.md)
      if (sym && px !== undefined) out[sym] = scalePrice(px);
      else if (r.market) needMarkets = true;
    }
    if (!hasAll(out) && needMarkets) {
      // Prices are keyed by market address; resolve names via /markets.
      const markets = await this.markets();
      for (const r of rows) {
        const meta = markets.get(String(r.market).toLowerCase());
        const px = r.oracle_px ?? r.mark_px; // never mid_px: a thin book mid is manipulable (ORACLE_RISK.md)
        if (meta?.symbol && px !== undefined && out[meta.symbol] === undefined) {
          // /prices values are already decimal (e.g. 81299 or 12.143); px_decimals applies to on-chain integers only.
          out[meta.symbol] = scalePrice(px);
        }
      }
    }
    if (!hasAll(out)) throw new Error("decibel: missing BTC/ETH prices");
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Hyperliquid                                                         */
/* ------------------------------------------------------------------ */

export class HyperliquidSource implements PriceSource {
  readonly name = "hyperliquid";
  constructor(private url = "https://api.hyperliquid.xyz/info") {}

  async fetchPrices(): Promise<Prices> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    if (!res.ok) throw new Error(`hyperliquid: HTTP ${res.status}`);
    const mids = (await res.json()) as Record<string, string>;
    const out: Prices = {};
    for (const s of MARKET_SYMBOLS) if (mids[s] !== undefined) out[s] = Number(mids[s]);
    if (!hasAll(out)) throw new Error("hyperliquid: missing BTC/ETH prices");
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Automatic selection                                                 */
/* ------------------------------------------------------------------ */

/**
 * Tries sources in order and uses the first that answers. A failed preferred
 * source is retried every `retryMs` so we switch back once it recovers.
 */
export class AutoPriceSource {
  private failedAt = new Map<string, number>();

  constructor(private sources: PriceSource[], private retryMs = 60_000) {}

  async fetch(): Promise<PriceQuote> {
    const errors: string[] = [];
    for (const src of this.sources) {
      const failed = this.failedAt.get(src.name);
      const isLast = src === this.sources[this.sources.length - 1];
      if (failed && Date.now() - failed < this.retryMs && !isLast) continue;
      try {
        const prices = await src.fetchPrices();
        this.failedAt.delete(src.name);
        return { source: src.name, prices, ts: Date.now() };
      } catch (e) {
        this.failedAt.set(src.name, Date.now());
        errors.push(`${src.name}: ${(e as Error).message}`);
      }
    }
    throw new Error(`all price sources failed (${errors.join("; ")})`);
  }
}

/* ------------------------------------------------------------------ */
/* More independent sources (ORACLE_RISK.md fix 1)                     */
/* ------------------------------------------------------------------ */

const PYTH_IDS: Record<MarketSymbol, string> = {
  BTC: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
} as Record<MarketSymbol, string>;

/** Pyth Hermes (needs a Pyth API key since Aug 2026). Rejects stale (>maxAgeSec) or wide-confidence prints. */
export class PythHermesSource implements PriceSource {
  readonly name = "pyth";
  constructor(private apiKey: string, private base = "https://hermes.pyth.network", private maxAgeSec = 30) {}
  async fetchPrices(): Promise<Prices> {
    const q = MARKET_SYMBOLS.map((s) => `ids[]=${PYTH_IDS[s]}`).join("&");
    const res = await fetch(`${this.base}/v2/updates/price/latest?${q}&parsed=true`, { headers: { authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) throw new Error(`pyth: HTTP ${res.status}`);
    const j = (await res.json()) as { parsed?: { id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[] };
    const out: Prices = {};
    const now = Date.now() / 1000;
    for (const f of j.parsed ?? []) {
      const sym = MARKET_SYMBOLS.find((s) => PYTH_IDS[s].slice(2) === f.id.replace(/^0x/, ""));
      if (!sym) continue;
      const px = Number(f.price.price) * 10 ** f.price.expo;
      const conf = Number(f.price.conf) * 10 ** f.price.expo;
      if (now - f.price.publish_time > this.maxAgeSec) throw new Error(`pyth: ${sym} stale`);
      if (conf / px > 0.002) throw new Error(`pyth: ${sym} confidence too wide`);
      out[sym] = px;
    }
    if (!hasAll(out)) throw new Error("pyth: missing BTC/ETH prices");
    return out;
  }
}

/** Coinbase spot last trade (public, no key). Backup feed. */
export class CoinbaseSource implements PriceSource {
  readonly name = "coinbase";
  constructor(private maxAgeSec = 60) {}
  async fetchPrices(): Promise<Prices> {
    const out: Prices = {};
    await Promise.all(
      MARKET_SYMBOLS.map(async (s) => {
        const res = await fetch(`https://api.exchange.coinbase.com/products/${s}-USD/ticker`);
        if (!res.ok) throw new Error(`coinbase: HTTP ${res.status}`);
        const j = (await res.json()) as { price?: string; time?: string };
        if (j.time && Date.now() - Date.parse(j.time) > this.maxAgeSec * 1000) throw new Error(`coinbase: ${s} stale`);
        out[s] = Number(j.price);
      }),
    );
    if (!hasAll(out)) throw new Error("coinbase: missing BTC/ETH prices");
    return out;
  }
}

/** Kraken spot last trade (public, no key). Backup feed. */
export class KrakenSource implements PriceSource {
  readonly name = "kraken";
  async fetchPrices(): Promise<Prices> {
    const res = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD");
    if (!res.ok) throw new Error(`kraken: HTTP ${res.status}`);
    const j = (await res.json()) as { error?: string[]; result?: Record<string, { c: [string, string] }> };
    if (j.error?.length) throw new Error(`kraken: ${j.error.join(",")}`);
    const out: Prices = {};
    for (const [k, v] of Object.entries(j.result ?? {})) {
      const sym = k.includes("XBT") ? "BTC" : k.includes("ETH") ? "ETH" : undefined;
      if (sym && MARKET_SYMBOLS.includes(sym as MarketSymbol)) out[sym as MarketSymbol] = Number(v.c[0]);
    }
    if (!hasAll(out)) throw new Error("kraken: missing BTC/ETH prices");
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Median with deviation rejection                                     */
/* ------------------------------------------------------------------ */

export const MAX_SOURCE_DEVIATION = 0.003; // 0.3%
export const MIN_SOURCES = 2;

export interface MedianQuote extends PriceQuote {
  /** Sources that agreed, per market. */
  used: Partial<Record<MarketSymbol, string[]>>;
  /** Sources rejected for deviating >MAX_SOURCE_DEVIATION from the median, per market. */
  rejected: Partial<Record<MarketSymbol, string[]>>;
  /** Sources that failed / timed out. */
  failed: string[];
}

const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * Pure aggregation (unit-tested). Per market: median of all fresh sources; sources more than
 * `maxDev` away are rejected. Succeeds only if at least `minSources` agree AND they are a strict
 * majority of the fresh sources (so a single moved venue is outvoted, and a 1-vs-1 split refuses).
 * The final price is the median of the agreeing sources.
 */
export function aggregatePrices(
  results: { name: string; prices: Prices }[],
  maxDev = MAX_SOURCE_DEVIATION,
  minSources = MIN_SOURCES,
): { prices: Prices; used: MedianQuote["used"]; rejected: MedianQuote["rejected"] } {
  const prices: Prices = {}, used: MedianQuote["used"] = {}, rejected: MedianQuote["rejected"] = {};
  for (const s of MARKET_SYMBOLS) {
    const pts = results.filter((r) => Number.isFinite(r.prices[s]) && (r.prices[s] as number) > 0).map((r) => ({ n: r.name, p: r.prices[s] as number }));
    if (pts.length < minSources) throw new Error(`${s}: only ${pts.length} fresh source(s), need ${minSources}`);
    const m = median(pts.map((x) => x.p));
    const ok = pts.filter((x) => Math.abs(x.p / m - 1) <= maxDev);
    const bad = pts.filter((x) => Math.abs(x.p / m - 1) > maxDev);
    const okPx = ok.map((x) => x.p);
    const spread = okPx.length ? Math.max(...okPx) / Math.min(...okPx) - 1 : Infinity;
    if (ok.length < minSources || ok.length * 2 <= pts.length || spread > maxDev)
      throw new Error(`${s}: sources disagree >${maxDev * 100}% (${pts.map((x) => `${x.n}=${x.p}`).join(" ")})`);
    prices[s] = median(ok.map((x) => x.p));
    used[s] = ok.map((x) => x.n);
    if (bad.length) rejected[s] = bad.map((x) => x.n);
  }
  return { prices, used, rejected };
}

/**
 * Pauses a source while its key is capped / rate limited (HTTP 429, 401, 403 or a "cap"/"credit" message), so the
 * median stops calling it, and re-enables it automatically: after each pause one probe request is let through;
 * success re-enables it, another cap doubles the pause (pauseMs .. maxPauseMs). Other errors pass through unchanged.
 * Used for Decibel while the Geomi key is on its MonthlyCredit cap.
 */
export class CircuitBreakerSource implements PriceSource {
  private pausedUntil = 0;
  private pause: number;
  constructor(private inner: PriceSource, private pauseMs = 10 * 60_000, private maxPauseMs = 60 * 60_000, private now = () => Date.now()) {
    this.pause = pauseMs;
  }
  get name() { return this.inner.name; }
  /** false while paused (the median skips it without a network call) */
  available() { return this.now() >= this.pausedUntil; }
  get state() { return this.now() >= this.pausedUntil ? "on" : `paused until ${new Date(this.pausedUntil).toISOString()}`; }
  static isCapped(e: unknown) { return /HTTP (429|401|403)\b|\b429\b|MonthlyCredit|credit|cap\b|rate.?limit/i.test(String((e as Error)?.message ?? e)); }
  async fetchPrices(): Promise<Prices> {
    if (!this.available()) throw new Error(`${this.name}: paused (key capped)`);
    try {
      const p = await this.inner.fetchPrices();
      this.pause = this.pauseMs;
      this.pausedUntil = 0;
      return p;
    } catch (e) {
      if (CircuitBreakerSource.isCapped(e)) {
        if (this.pausedUntil > 0) this.pause = Math.min(this.pause * 2, this.maxPauseMs); // capped again after a probe
        this.pausedUntil = this.now() + this.pause;
      }
      throw e;
    }
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number, name: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${name}: timeout`)), ms))]);

/** Queries all sources in parallel and returns the deviation-checked median. Drop-in for AutoPriceSource. */
export class MedianPriceSource {
  constructor(private sources: PriceSource[], private timeoutMs = 2500, private maxDev = MAX_SOURCE_DEVIATION, private minSources = MIN_SOURCES) {}
  get names() { return this.sources.map((s) => s.name); }
  async fetch(): Promise<MedianQuote> {
    // Paused sources (key capped, see CircuitBreakerSource) are skipped without a request.
    const active = this.sources.filter((s) => (s as { available?: () => boolean }).available?.() ?? true);
    const settled = await Promise.allSettled(active.map((s) => withTimeout(s.fetchPrices(), this.timeoutMs, s.name)));
    const ok: { name: string; prices: Prices }[] = [], failed: string[] = [];
    settled.forEach((r, i) => (r.status === "fulfilled" ? ok.push({ name: active[i].name, prices: r.value }) : failed.push(`${active[i].name}: ${(r.reason as Error)?.message ?? r.reason}`)));
    for (const s of this.sources) if (!active.includes(s)) failed.push(`${s.name}: paused (key capped)`);
    const agg = aggregatePrices(ok, this.maxDev, this.minSources);
    return { source: `median(${[...new Set(Object.values(agg.used).flat())].join(",")})`, prices: agg.prices, ts: Date.now(), used: agg.used, rejected: agg.rejected, failed };
  }
}

/** Standard source set used by both the keeper and /api/price-sig. Decibel and Pyth join when their keys are set. */
export function defaultMedianSource(env: { decibelKey?: string; pythKey?: string; pythBase?: string; decibelMinIntervalMs?: number } = {}) {
  const src: PriceSource[] = [];
  // Wrapped in a breaker: dropped from the median while the key is capped (429), back automatically once it works.
  if (env.decibelKey) src.push(new CircuitBreakerSource(new DecibelSource({ apiKey: env.decibelKey, minIntervalMs: env.decibelMinIntervalMs })));
  if (env.pythKey) src.push(new PythHermesSource(env.pythKey, env.pythBase));
  src.push(new HyperliquidSource(), new CoinbaseSource(), new KrakenSource());
  return new MedianPriceSource(src);
}
