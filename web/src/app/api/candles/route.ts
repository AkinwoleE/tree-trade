import { MARKET_SYMBOLS } from "@/config/contract";

/** Server-side candle history (close prices) for the chart. Upstream is not exposed to the client. */
export const dynamic = "force-dynamic";

const TF: Record<string, { interval: string; ms: number; count: number }> = {
  "1m": { interval: "1m", ms: 60_000, count: 180 },
  "5m": { interval: "5m", ms: 300_000, count: 288 },
  "15m": { interval: "15m", ms: 900_000, count: 288 },
  "1h": { interval: "1h", ms: 3_600_000, count: 240 },
  "4h": { interval: "4h", ms: 14_400_000, count: 180 },
  "1d": { interval: "1d", ms: 86_400_000, count: 180 },
};

export async function GET(req: Request) {
  const u = new URL(req.url);
  const coin = (u.searchParams.get("market") || "BTC").toUpperCase();
  const tf = TF[u.searchParams.get("tf") || "5m"];
  if (!tf || !(MARKET_SYMBOLS as readonly string[]).includes(coin)) {
    return Response.json({ error: "bad market or timeframe" }, { status: 400 });
  }
  const endTime = Date.now();
  try {
    const r = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: tf.interval, startTime: endTime - tf.ms * tf.count, endTime } }),
      cache: "no-store",
    });
    if (!r.ok) throw new Error();
    const rows = (await r.json()) as { t: number; o: string; h: string; l: string; c: string }[];
    if (u.searchParams.get("ohlc")) {
      const bars = rows.map((c) => ({ time: Math.floor(c.t / 1000), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c) }));
      return Response.json({ bars }, { headers: { "cache-control": "s-maxage=10" } });
    }
    const points = rows.map((c) => ({ time: Math.floor(c.t / 1000), value: Number(c.c) }));
    return Response.json({ points }, { headers: { "cache-control": "s-maxage=10" } });
  } catch {
    return Response.json({ error: "chart data unavailable" }, { status: 503 });
  }
}
