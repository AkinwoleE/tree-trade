/**
 * Server-side proxy for browser Aptos testnet calls (fullnode REST + indexer GraphQL).
 * Adds the server-only Geomi key when available, falls back to the public fullnode on
 * MonthlyCredit/429, dedupes identical in-flight requests, caches reads for a few
 * seconds, retries 429/5xx with backoff, and always answers JSON.
 */
import { clientIp, rateLimited } from "@/lib/server-sponsor";
import { countUpstream, siteApiKey } from "@/lib/api-keys";

export const dynamic = "force-dynamic";

const UPSTREAM_GEOMI = "https://api.testnet.aptoslabs.com";
const UPSTREAM_PUBLIC = "https://fullnode.testnet.aptoslabs.com";
const KEY = siteApiKey();
/** Shared read cache (views, GETs, GraphQL). Browser polls every 15-30 s, so 8 s collapses concurrent tabs. */
const TTL_MS = 8000;
const MAX_CACHE = 2000;

type Res = { status: number; body: ArrayBuffer | string; type: string };
const cache = new Map<string, { at: number; res: Res }>();
const inflight = new Map<string, Promise<Res>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ALLOWED = /^v1(\/|$)/;
/** Path must stay under /v1 on the fixed upstream after URL normalization (REVIEW W-3: `..%2F` escaped it). */
const safePath = (path: string) => !/\.\.|%|\\/.test(path) && new URL(`${UPSTREAM_PUBLIC}/${path}`).pathname.startsWith("/v1");
// Reads that are safe to cache briefly (views, GETs, GraphQL queries). Transaction submission is not proxied-cached.
// Never cache the bare account resource (sequence number) or transactions: a 3s-stale sequence number made
// back-to-back 1-click trades fail with SEQUENCE_NUMBER_TOO_OLD (REVIEW W-4).
const cacheable = (method: string, path: string) =>
  (method === "GET" && !/^v1\/accounts\/[^/]+\/?$/.test(path) && !path.startsWith("v1/transactions")) || path === "v1/view" || path === "v1/graphql";

function isMonthlyCredit(buf: ArrayBuffer): boolean {
  try {
    return new TextDecoder().decode(buf).includes("MonthlyCredit");
  } catch {
    return false;
  }
}

async function fetchUpstream(
  base: string,
  method: string,
  path: string,
  search: string,
  body: ArrayBuffer | undefined,
  headers: Record<string, string>,
): Promise<{ status: number; buf: ArrayBuffer; type: string }> {
  countUpstream(path === "v1/graphql" ? "indexer" : path === "v1/view" ? "view" : method === "POST" ? "post" : "get");
  const r = await fetch(`${base}/${path}${search}`, { method, headers, body, cache: "no-store" });
  const buf = await r.arrayBuffer();
  const type = r.headers.get("content-type") || "";
  return { status: r.status, buf, type };
}

async function upstream(method: string, path: string, search: string, body: ArrayBuffer | undefined, ctype: string | null, accept: string | null): Promise<Res> {
  const headers: Record<string, string> = { accept: accept || "application/json" };
  if (ctype) headers["content-type"] = ctype;
  let last: Res = { status: 503, body: JSON.stringify({ message: "upstream unavailable" }), type: "application/json" };
  // Prefer public fullnode while Geomi org MonthlyCredit is exhausted (keyed calls always 429).
  // Keep Geomi as a secondary try so we resume automatically if credits refresh.
  const bases: { base: string; auth: boolean }[] = [
    { base: UPSTREAM_PUBLIC, auth: false },
    ...(KEY ? [{ base: UPSTREAM_GEOMI, auth: true }] : [{ base: UPSTREAM_GEOMI, auth: false }]),
  ];
  for (const { base, auth } of bases) {
    const h = { ...headers };
    if (auth && KEY) h.authorization = `Bearer ${KEY}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetchUpstream(base, method, path, search, body, h);
        if (r.status === 429 || isMonthlyCredit(r.buf) || r.status >= 500) {
          last = {
            status: r.status === 429 || isMonthlyCredit(r.buf) ? 429 : 503,
            body: JSON.stringify({ message: r.status === 429 || isMonthlyCredit(r.buf) ? "rate limited, retry shortly" : "node temporarily unavailable" }),
            type: "application/json",
          };
          // MonthlyCredit on keyed Geomi → try next base immediately
          if (auth && (isMonthlyCredit(r.buf) || r.status === 429)) break;
          await sleep(250 * 3 ** attempt);
          continue;
        }
        if (r.type.startsWith("text/")) {
          return { status: r.status >= 200 && r.status < 300 ? 502 : r.status, body: JSON.stringify({ message: new TextDecoder().decode(r.buf).slice(0, 200) }), type: "application/json" };
        }
        return { status: r.status, body: r.buf, type: r.type };
      } catch {
        await sleep(250 * 3 ** attempt);
      }
    }
  }
  return last;
}

async function handle(req: Request, params: Promise<{ path: string[] }>) {
  const path = (await params).path.join("/");
  if (!ALLOWED.test(path) || !safePath(path)) return Response.json({ message: "not allowed" }, { status: 404 });
  const url = new URL(req.url);
  const body = req.method === "GET" ? undefined : await req.arrayBuffer();
  const ctype = req.headers.get("content-type");
  const accept = req.headers.get("accept");
  const bodyKey = body ? Buffer.from(body).toString("base64") : "";
  const key = `${req.method} ${path}${url.search} ${ctype} ${accept} ${bodyKey}`;
  const useCache = cacheable(req.method, path);

  if (useCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return respond(hit.res, "HIT");
  }
  let p = useCache ? inflight.get(key) : undefined;
  if (!p) {
    // The proxy spends our Geomi quota: cap upstream calls (cache misses only) per IP (REVIEW W-2).
    if (rateLimited(`aptos-ip:${clientIp(req)}`, 1200, 60_000)) return Response.json({ message: "rate limited, retry shortly" }, { status: 429 });
    p = upstream(req.method, path, url.search, body, ctype, accept);
    if (useCache) {
      inflight.set(key, p);
      p.finally(() => inflight.delete(key));
    }
  }
  const res = await p;
  if (useCache && res.status < 400) {
    if (cache.size > MAX_CACHE) cache.clear();
    cache.set(key, { at: Date.now(), res });
  }
  return respond(res, "MISS");
}

function respond(res: Res, c: string) {
  return new Response(res.body, { status: res.status, headers: { "content-type": res.type, "cache-control": "no-store", "x-proxy-cache": c } });
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return handle(req, ctx.params);
}
export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return handle(req, ctx.params);
}
