import { decibelApiKey } from "@/lib/api-keys";
import { DECIBEL_BASE_URL } from "@/lib/prices";

/**
 * Server-side proxy for the Decibel REST API so the API key never reaches the browser.
 * Only the read-only endpoints the price source needs are allowed.
 */
const ALLOWED = new Set(["prices", "markets"]);

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ path: string }> }) {
  const { path } = await ctx.params;
  if (!ALLOWED.has(path)) return Response.json({ error: "not found" }, { status: 404 });

  const key = decibelApiKey();
  if (!key) return Response.json({ error: "DECIBEL_NODE_API_KEY not configured" }, { status: 503 });

  try {
    const res = await fetch(`${DECIBEL_BASE_URL}/${path}`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
