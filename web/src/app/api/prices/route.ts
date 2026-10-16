import { decibelApiKey, siteApiKey } from "@/lib/api-keys";
import { AutoPriceSource, CircuitBreakerSource, DecibelSource, HyperliquidSource } from "@/lib/prices";

/**
 * Server-side price feed for the UI. Prefers Decibel (when DECIBEL_NODE_API_KEY is set),
 * else a public market-data feed. The upstream feed is never named in the response.
 */
export const dynamic = "force-dynamic";

const key = decibelApiKey() || siteApiKey();
const source = new AutoPriceSource([
  ...(key ? [new CircuitBreakerSource(new DecibelSource({ apiKey: key }))] : []), // paused while the key is capped
  new HyperliquidSource(),
]);

export async function GET() {
  try {
    const q = await source.fetch();
    return Response.json(
      { source: q.source === "decibel" ? "Decibel" : "market feed", prices: q.prices, ts: q.ts },
      { headers: { "cache-control": "s-maxage=3, stale-while-revalidate=10" } },
    );
  } catch {
    return Response.json({ error: "price feed unavailable" }, { status: 503 });
  }
}
