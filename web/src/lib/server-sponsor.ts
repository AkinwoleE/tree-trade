import "server-only";
import { Account, Aptos, AptosConfig, Ed25519PrivateKey, Network, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";

let cached: { aptos: Aptos; sponsor: Account } | null = null;
export function sponsorCtx() {
  if (cached) return cached;
  const raw = process.env.SPONSOR_PRIVATE_KEY;
  if (!raw) return null;
  const sponsor = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(PrivateKey.formatPrivateKey(raw, PrivateKeyVariants.Ed25519)) });
  // Prefer public fullnode: Geomi org MonthlyCredit cap blocks keyed api.testnet (2026-10-15).
  const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, fullnode: "https://fullnode.testnet.aptoslabs.com/v1" }));
  cached = { aptos, sponsor };
  return cached;
}

// Per-instance sliding-window limiter. One map per bucket (the key prefix before ':'), so spraying one
// bucket (e.g. random senders) can never evict another bucket's counters (REVIEW W-1b). Oldest keys are
// evicted first; nothing is ever bulk-cleared. For real multi-instance limits use a shared store (KV).
const buckets = new Map<string, Map<string, number[]>>();
const MAX_KEYS = 20_000;
export function rateLimited(key: string, max: number, windowMs: number) {
  const bucket = key.includes(":") ? key.slice(0, key.indexOf(":")) : key;
  let hits = buckets.get(bucket);
  if (!hits) buckets.set(bucket, (hits = new Map()));
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.delete(key);
  hits.set(key, arr); // re-insert: Map order = least recently used first
  while (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value!);
  return arr.length > max;
}

/** Client IP. On Vercel these headers are set by the edge and client-supplied values are overwritten. */
export function clientIp(req: Request) {
  return (req.headers.get("x-vercel-forwarded-for")?.split(",")[0] || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown").trim();
}
