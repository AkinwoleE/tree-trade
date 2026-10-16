/**
 * Per-role API request counter + per-role API key selection (box bots / site / Decibel).
 *
 * Keys (each falls back to the shared key, so nothing changes until a role key is set):
 *   box bots : APTOS_API_KEY_BOTS  -> APTOS_API_KEY -> (unset = anonymous public node)
 *   Decibel  : DECIBEL_API_KEY     -> DECIBEL_NODE_API_KEY
 * Counts every Aptos SDK request (via a wrapped ts-sdk Client) and every global fetch() to
 * aptoslabs/decibel hosts, and writes one summary line per USAGE_LOG_MINS (default 60) to keeper.log.
 */
import fs from "node:fs";
import path from "node:path";
import aptosClient from "@aptos-labs/aptos-client";
import type { Client, ClientRequest, ClientResponse } from "@aptos-labs/ts-sdk";

export const botsApiKey = () => process.env.APTOS_API_KEY_BOTS || process.env.APTOS_API_KEY || undefined;
export const decibelApiKey = () => process.env.DECIBEL_API_KEY || process.env.DECIBEL_NODE_API_KEY || undefined;

/** Rough Geomi CU weights per request kind (docs give ~250 for a node GET, ~500 for GraphQL; not published per endpoint). */
const CU: Record<string, number> = { view: 300, get: 250, submit: 500, simulate: 500, wait: 250, indexer: 500, decibel: 250 };

const counts = new Map<string, number>();
let rateLimited = 0;
const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);

export function kindOf(url: string, method = "GET"): string {
  if (/decibel/i.test(url)) return "decibel";
  if (/\/graphql/.test(url)) return "indexer";
  if (/\/view(\?|$)/.test(url)) return "view";
  if (/\/transactions\/simulate/.test(url)) return "simulate";
  if (/wait_by_hash|\/transactions\/by_hash/.test(url)) return "wait";
  if (/\/transactions\/?(\?|$)/.test(url) && method === "POST") return "submit";
  return "get";
}

/** ts-sdk Client that counts requests (pass as AptosConfig `client`). */
export function countingClient(): Client {
  return {
    async provider<Req, Res>(req: ClientRequest<Req>): Promise<ClientResponse<Res>> {
      bump(kindOf(req.url, req.method));
      const res = (await aptosClient<Res>(req as never)) as unknown as ClientResponse<Res>;
      if (res.status === 429) rateLimited++;
      return res;
    },
  };
}

let fetchWrapped = false;
/** Count global fetch() calls to Aptos/Decibel hosts (Decibel REST, price-source). SDK traffic is counted by countingClient. */
export function wrapFetch() {
  if (fetchWrapped) return;
  fetchWrapped = true;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const hit = /aptoslabs\.com|decibel/i.test(url);
    if (hit) bump(kindOf(url, init?.method ?? "GET"));
    const res = await orig(input, init);
    if (hit && res.status === 429) rateLimited++;
    return res;
  }) as typeof fetch;
}

export function summary(role: string, mins: number): string {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const cu = [...counts].reduce((a, [k, n]) => a + n * (CU[k] ?? 250), 0);
  const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(" ");
  const perHour = (x: number) => Math.round((x * 60) / mins);
  return `usage[${role}] last ${mins}m: requests=${total} (${perHour(total)}/h) ${parts || "-"} 429=${rateLimited} est_cu=${cu} (~${perHour(cu)}/h, ~${((perHour(cu) * 24 * 30) / 1e6).toFixed(1)}M/month)`;
}

/** Start periodic usage lines. `logFile` set => append there (hedger writes into keeper.log); else console. */
export function startUsageLog(role: string, logFile?: string) {
  wrapFetch();
  const mins = Number(process.env.USAGE_LOG_MINS || 60);
  let windowStart = Date.now();
  const emit = () => {
    const actual = Math.max(1, Math.round((Date.now() - windowStart) / 60_000));
    const line = `${new Date().toISOString()} ${summary(role, actual)}`;
    if (logFile) fs.appendFileSync(logFile, line + "\n");
    else console.log(line);
    counts.clear();
    rateLimited = 0;
    windowStart = Date.now();
    if (role === "keeper") void logSite();
  };
  // First line after 15 min (quick read after a restart), then every `mins`.
  setTimeout(() => {
    emit();
    setInterval(emit, mins * 60_000).unref();
  }, Math.min(15, mins) * 60_000).unref();
}

export const KEEPER_LOG = path.resolve(import.meta.dirname, "../keeper.log");

/** Site role: per-instance counters from the deployed app (approximate: whichever serverless instance answers). */
let lastSite: Record<string, number> | undefined;
async function logSite() {
  const url = process.env.SITE_USAGE_URL || "https://tree-trade-murex.vercel.app/api/usage";
  try {
    const j = (await (await fetch(url)).json()) as { since: number; counts: Record<string, number> };
    const total = Object.values(j.counts).reduce((a, b) => a + b, 0);
    const delta = lastSite ? total - Object.values(lastSite).reduce((a, b) => a + b, 0) : undefined;
    lastSite = j.counts;
    const parts = Object.entries(j.counts).map(([k, n]) => `${k}=${n}`).join(" ");
    console.log(`${new Date().toISOString()} usage[site] one instance since ${new Date(j.since).toISOString()}: requests=${total} ${parts || "-"}${delta !== undefined && delta >= 0 ? ` (+${delta} since last line)` : ""} (approximate)`);
  } catch (e) {
    console.log(`${new Date().toISOString()} usage[site] unavailable: ${(e as Error).message}`);
  }
}
