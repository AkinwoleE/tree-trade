import "server-only";
import { unstable_cache } from "next/cache";
import { MODULE_ADDR } from "@/config/contract";
import { decodeTx } from "@/lib/activity-decode";
import type { Activity, Opened, Trade } from "@/lib/activity";
import { countUpstream, siteApiKey } from "@/lib/api-keys";

/**
 * Protocol activity decoded from on-chain events. The indexer's events table is deprecated, so we find
 * our transactions via `user_transactions` (by entry function) and read their events from the fullnode.
 * Cached in memory for 8 s per server instance.
 */

const NODE = "https://fullnode.testnet.aptoslabs.com/v1";
const INDEXER = "https://api.testnet.aptoslabs.com/v1";
// Geomi site key when set (restored 2026-10-16); anonymous otherwise.
const KEY = siteApiKey();
const headers: Record<string, string> = { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) };
const FNS = ["exchange::open_position", "exchange::close_position", "exchange::open_position_as_delegate", "exchange::close_position_as_delegate", "exchange::liquidate", "exchange::deposit", "exchange::withdraw", "hedge::open_position_hedged", "exchange::open_position_from_queue", "exchange::open_position_from_queue_as_delegate", "exchange::open_position_px", "exchange::close_position_px", "exchange::open_position_from_queue_px", "exchange::open_position_as_delegate_px", "exchange::close_position_as_delegate_px", "exchange::open_position_from_queue_as_delegate_px", "hedge::open_position_hedged_px", "hedge::open_position_hedged_as_delegate_px", "hedge::open_position_hedged_as_delegate"];
const LIMIT = 150;
/** Package publish version (testnet); the indexer times out on unbounded scans. Override with ACTIVITY_START_VERSION. */
const START = Number(process.env.ACTIVITY_START_VERSION || process.env.NEXT_PUBLIC_START_VERSION || 75217152);
/** Per-instance snapshot TTL; the route also sets s-maxage=30 so the CDN shares one snapshot across visitors. */
const TTL = 30_000;
/** Indexer pages (100 rows each) of recent non-oracle protocol txs to scan. */
const PAGES = 4;

let cache: { at: number; data: Activity } | undefined;

/** Cached activity snapshot (shared by /api/activity and /api/stats/users). */
export async function getActivity(): Promise<Activity> {
  if (!cache || Date.now() - cache.at > TTL) {
    try {
      cache = { at: Date.now(), data: await sharedSnapshot() };
    } catch (e) {
      if (!cache) throw e;
    }
  }
  return cache.data;
}

/**
 * Whole snapshot in the shared Data Cache: a cold instance serves the last snapshot instantly (stale-while-revalidate)
 * instead of rebuilding it from scratch (was 45-49s after idle). Background refresh at most every 30s.
 */
const sharedSnapshot = unstable_cache(async () => load(), ["activity-snapshot-v1"], { revalidate: 30 });

/**
 * Recent protocol tx versions. One indexer query by contract address (paged, 100 rows/page) instead of one per
 * entry function: with the Geomi key capped, anonymous indexer calls from Vercel share ~100 queries / 5 min per IP,
 * and the 19 per-function queries (every 8 s per instance) exhausted it and timed out. Shared across instances via
 * the Next.js Data Cache; a stale list is served while a background refresh runs (or fails).
 */
const listVersions = unstable_cache(
  async (): Promise<{ versions: number[]; truncated: boolean }> => {
    const wanted = new Set(FNS.map((f) => `${MODULE_ADDR}::${f}`));
    const exclude = [`${MODULE_ADDR}::oracle::push_prices`, `${MODULE_ADDR}::exchange::set_side_caps`];
    const versions: number[] = [];
    let truncated = true;
    for (let page = 0; page < PAGES; page++) {
      countUpstream("indexer");
      const q = await fetch(`${INDEXER}/graphql`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: `query($m:String!,$start:bigint!,$ex:[String!]!,$off:Int!){ user_transactions(where:{entry_function_contract_address:{_eq:$m}, version:{_gte:$start}, entry_function_id_str:{_nin:$ex}}, order_by:{version:desc}, limit:100, offset:$off){ version entry_function_id_str } }`,
          variables: { m: MODULE_ADDR, start: START, ex: exclude, off: page * 100 },
        }),
        cache: "no-store",
      });
      const qj = await q.json().catch(() => ({}));
      if (!q.ok || qj.errors || !qj.data) {
        if (page === 0) throw new Error("indexer unavailable");
        break; // keep what we have; marked truncated
      }
      const rows = qj.data.user_transactions as { version: number; entry_function_id_str: string }[];
      for (const r of rows) if (wanted.has(r.entry_function_id_str)) versions.push(Number(r.version));
      if (rows.length < 100) {
        truncated = false;
        break;
      }
      if (versions.length >= LIMIT * 2) break;
    }
    return { versions: [...new Set(versions)].sort((a, b) => b - a).slice(0, LIMIT * 2), truncated };
  },
  ["tree-trade-activity-versions-v2"],
  { revalidate: 60 },
);

/**
 * Incremental refresh: once an instance has a version list, each refresh is ONE indexer query for
 * protocol txs newer than the newest known version (usually 0-2 rows) instead of re-paging the list.
 */
let known: { versions: number[]; truncated: boolean } | undefined;
async function versionsNow(): Promise<{ versions: number[]; truncated: boolean }> {
  if (!known) {
    known = await listVersions();
    return known;
  }
  const after = known.versions[0] ?? START - 1;
  const wanted = new Set(FNS.map((f) => `${MODULE_ADDR}::${f}`));
  countUpstream("indexer");
  const q = await fetch(`${INDEXER}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: `query($m:String!,$after:bigint!,$ex:[String!]!){ user_transactions(where:{entry_function_contract_address:{_eq:$m}, version:{_gt:$after}, entry_function_id_str:{_nin:$ex}}, order_by:{version:desc}, limit:100){ version entry_function_id_str } }`,
      variables: { m: MODULE_ADDR, after, ex: [`${MODULE_ADDR}::oracle::push_prices`, `${MODULE_ADDR}::exchange::set_side_caps`] },
    }),
    cache: "no-store",
  });
  const qj = await q.json().catch(() => ({}));
  if (!q.ok || qj.errors || !qj.data) return known; // serve the last list
  const rows = qj.data.user_transactions as { version: number; entry_function_id_str: string }[];
  if (rows.length >= 100) {
    known = await listVersions(); // big gap: fall back to the full (shared) list
    return known;
  }
  const fresh = rows.filter((x) => wanted.has(x.entry_function_id_str)).map((x) => Number(x.version));
  known = { versions: [...new Set([...fresh, ...known.versions])].sort((a, b) => b - a).slice(0, LIMIT * 2), truncated: known.truncated };
  return known;
}

/** Committed txs are immutable: keep them in memory and in the shared Data Cache (200s only) so each is fetched once. */
const txMem = new Map<number, unknown>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getTx(v: number): Promise<any | undefined> {
  if (txMem.has(v)) return txMem.get(v);
  for (let attempt = 0; attempt < 3; attempt++) {
    countUpstream("get_tx");
    const r = await fetch(`${NODE}/transactions/by_version/${v}`, { headers, cache: "force-cache" });
    if (r.ok) {
      const t = await r.json();
      if (txMem.size > 2000) txMem.clear();
      txMem.set(v, t);
      return t;
    }
    if (r.status !== 429 && r.status < 500) return undefined;
    await sleep(300 * 3 ** attempt); // anonymous per-IP limits: back off instead of failing the snapshot
  }
  return undefined;
}

async function load(): Promise<Activity> {
  const { versions, truncated } = await versionsNow();
  const out: Activity = { trades: [], opens: [], deposits: [], updatedAt: Date.now() };
  const openById = new Map<string, Opened>();
  const closes: Trade[] = [];
  let i = 0;
  const worker = async () => {
    while (i < versions.length) {
      const v = versions[i++];
      try {
        const t = await getTx(v);
        if (!t) {
          out.partial = true;
          continue;
        }
        if (!t.success) continue;
        const d = decodeTx(t);
        for (const o of d.opens) {
          openById.set(o.id, o);
          out.opens.push(o);
        }
        closes.push(...d.closes);
        out.deposits.push(...d.deposits);
      } catch {
        out.partial = true;
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  for (const c of closes) {
    const o = openById.get(c.id);
    if (o) {
      c.isLong ??= o.isLong;
      c.leverage = o.leverage;
      c.notional = o.notional;
      c.entry ??= o.entry;
    } else c.notional ??= undefined;
  }
  out.trades = closes.sort((a, b) => b.version - a.version);
  out.opens.sort((a, b) => b.version - a.version);
  out.deposits.sort((a, b) => b.version - a.version);
  if (truncated) out.partial = true;
  return out;
}

