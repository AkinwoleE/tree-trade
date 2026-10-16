"use client";
import { visibleInterval } from "@/lib/visible-interval";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MoveValue } from "@aptos-labs/ts-sdk";
import { MARKET_SYMBOLS, VIEW, fn, type MarketSymbol } from "@/config/contract";
import {
  DECIBEL_USDC,
  DECIBEL_VIEW,
  HEDGER_ADDR,
  SUBACCOUNT_RESOURCE,
  decibelMarketAddr,
  dfn,
} from "@/config/decibel";
import { DECIBEL_MARKET_FOR, delegationFor, type DelegationStatus, type MarketSpec } from "@/lib/hedge";
import { aptos } from "@/lib/chain";

/* ------------------------------------------------------------------ */
/* Hedger status (keeper/hedge-state.json via /api/hedge/status)       */
/* ------------------------------------------------------------------ */

export interface HedgerGroup {
  subaccount: string;
  owner: string;
  market: string;
  status: string;
  target: string;
  actual: string;
  entryPx: string;
  fundingCost: string;
  positionIds: string[];
  failures: number;
  lastError?: string;
  lastTx?: string;
  updatedAt: number;
}
export interface HedgerPosition {
  group: string;
  subaccount: string;
  market: string;
  hedgeSize: string;
  status: string;
  error?: string;
}
export interface HedgerStatus {
  available: boolean;
  /** true when this deployment cannot see the hedger's live state; status is derived from chain data */
  limited?: boolean;
  /** seconds since the hedger last wrote its state */
  age?: number;
  mode?: "live" | "mock";
  hedger?: string;
  groups: Record<string, HedgerGroup>;
  positions: Record<string, HedgerPosition>;
  error?: string;
}

export function useHedgerStatus(intervalMs = 15_000): HedgerStatus {
  const [s, setS] = useState<HedgerStatus>({ available: false, groups: {}, positions: {} });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/hedge/status", { cache: "no-store" });
        const j = (await r.json()) as HedgerStatus;
        if (alive) setS(j);
      } catch (e) {
        if (alive) setS({ available: false, groups: {}, positions: {}, error: (e as Error).message });
      }
    };
    tick();
    const stop = visibleInterval(tick, intervalMs);
    return () => {
      alive = false;
      stop();
    };
  }, [intervalMs]);
  return s;
}

/* ------------------------------------------------------------------ */
/* Decibel account state (fullnode views, read from the browser)       */
/* ------------------------------------------------------------------ */

export interface DecibelMarketState {
  spec: MarketSpec;
  /** Decibel mark, USD */
  mark?: number;
  delegation?: DelegationStatus;
  /** signed size units on the selected Trading Account */
  size?: bigint;
  entryPx?: number;
  /** USDC, positive = cost */
  fundingCost?: number;
  userLeverage?: number;
}

export interface DecibelAccountData {
  /** Trading Accounts (Decibel subaccounts) owned by the wallet */
  subaccounts: string[];
  selected?: string;
  /** the wallet's primary Decibel Trading Account (used by one-click hedging), if it exists */
  primary?: string;
  /** cross collateral of the selected Trading Account, USDC */
  collateral?: number;
  /** Decibel test USDC in the wallet */
  walletUsdc?: number;
  mintAvailable?: number;
  markets: Partial<Record<MarketSymbol, DecibelMarketState>>;
  /** hedge::active_requests rows owned by the wallet: position id -> subaccount */
  requests: Record<string, string>;
  errors: string[];
}

const dview = (id: string, args: unknown[] = []) =>
  aptos.view({ payload: { function: dfn(id), functionArguments: args as never[] } });

/** Static market parameters; cached for the session. */
const specCache = new Map<string, Promise<MarketSpec>>();
function loadSpec(name: string): Promise<MarketSpec> {
  let p = specCache.get(name);
  if (!p) {
    const addr = decibelMarketAddr(name);
    const one = async (id: string) => String((await dview(id, [addr]))[0]);
    p = Promise.all([
      one(DECIBEL_VIEW.marketSzDecimals),
      one(DECIBEL_VIEW.marketLotSize),
      one(DECIBEL_VIEW.marketMinSize),
      one(DECIBEL_VIEW.marketTickSize),
      one(DECIBEL_VIEW.marketMaxLeverage),
      one(DECIBEL_VIEW.marketMinPrice),
      one(DECIBEL_VIEW.marketMaxPrice),
    ]).then(([sz, lot, min, tick, lev, minPx, maxPx]) => ({
      name,
      addr,
      szDecimals: Number(sz),
      lotSize: BigInt(lot),
      minSize: BigInt(min),
      tickSize: BigInt(tick),
      maxLeverage: Number(lev),
      minPrice: BigInt(minPx),
      maxPrice: BigInt(maxPx),
    }));
    p.catch(() => specCache.delete(name));
    specCache.set(name, p);
  }
  return p;
}

const storeKey = (owner: string) => `treetrade.hedgeSubaccount.${owner}`;

/**
 * Trading Accounts are discovered with the documented indexer table `current_objects` (objects owned by the
 * wallet) filtered to those holding `dex_accounts::Subaccount`; everything else is fullnode views.
 */
export function useDecibelAccount(owner: string | undefined, intervalMs = 20_000) {
  const [data, setData] = useState<DecibelAccountData>({ subaccounts: [], markets: {}, requests: {}, errors: [] });
  const [selected, setSelectedState] = useState<string>();
  const reqId = useRef(0);
  const subsCache = useRef<{ owner?: string; at: number; subs: string[] }>({ at: 0, subs: [] });

  useEffect(() => {
    setSelectedState(owner ? (localStorage.getItem(storeKey(owner)) ?? undefined) : undefined);
    subsCache.current = { at: 0, subs: [] };
  }, [owner]);

  const setSelected = useCallback(
    (sub: string | undefined) => {
      if (owner) {
        if (sub) localStorage.setItem(storeKey(owner), sub);
        else localStorage.removeItem(storeKey(owner));
      }
      setSelectedState(sub);
    },
    [owner],
  );

  const load = useCallback(
    async (forceSubs = false) => {
      const id = ++reqId.current;
      const errors: string[] = [];
      const safe = async <T,>(label: string, f: () => Promise<T>): Promise<T | undefined> => {
        try {
          return await f();
        } catch (e) {
          errors.push(`${label}: ${(e as Error).message.split("\n")[0].slice(0, 140)}`);
          return undefined;
        }
      };

      const markets: DecibelAccountData["markets"] = {};
      await Promise.all(
        MARKET_SYMBOLS.map(async (s) => {
          const name = DECIBEL_MARKET_FOR[s];
          const spec = await safe(`Decibel ${name} params`, () => loadSpec(name));
          if (!spec) return;
          const mark = await safe(`Decibel ${name} mark`, async () => Number((await dview(DECIBEL_VIEW.markPrice, [spec.addr]))[0]) / 1e6);
          markets[s] = { spec, mark };
        }),
      );

      let subaccounts = subsCache.current.subs;
      let requests: Record<string, string> = {};
      let collateral: number | undefined;
      let walletUsdc: number | undefined;
      let mintAvailable: number | undefined;
      let sel = selected;
      let primaryFound: string | undefined;

      if (owner) {
        const [reqs] = await Promise.all([
          safe("hedge::active_requests", () => aptos.view({ payload: { function: fn(VIEW.hedgeRequests), functionArguments: [] } })),
        ]);
        if (reqs) {
          const [ids, owners, subs] = reqs as [string[], string[], string[]];
          const norm = (a: string) => a.toLowerCase().replace(/^0x0*/, "");
          ids.forEach((pid, i) => {
            if (norm(owners[i]) === norm(owner)) requests[String(pid)] = subs[i];
          });
        }
        // Owned objects change rarely: refresh at most every 60 s unless forced (e.g. after creating one).
        if (forceSubs || subsCache.current.owner !== owner || Date.now() - subsCache.current.at > 60_000) {
          const found = await safe("Trading Accounts (indexer current_objects)", async () => {
            const res = await aptos.queryIndexer<{ current_objects: { object_address: string }[] }>({
              query: {
                query: `query($owner: String!) { current_objects(where: { owner_address: { _eq: $owner }, is_deleted: { _eq: false } }, limit: 50) { object_address } }`,
                variables: { owner },
              },
            });
            const isSub = await Promise.all(
              res.current_objects.map((o) =>
                aptos
                  .getAccountResource({ accountAddress: o.object_address, resourceType: SUBACCOUNT_RESOURCE() as `${string}::${string}::${string}` })
                  .then(() => true)
                  .catch(() => false),
              ),
            );
            return res.current_objects.filter((_, i) => isSub[i]).map((o) => o.object_address);
          });
          if (found) {
            // Keep subaccounts referenced by hedge requests even if the indexer lags.
            subaccounts = [...new Set([...found, ...Object.values(requests)])];
            subsCache.current = { owner, at: Date.now(), subs: subaccounts };
          }
        }
        // One-click hedging uses the primary Trading Account (deterministic address; created by the setup tx).
        let primary: string | undefined;
        const pAddr = await safe("primary Trading Account", async () => String((await dview(DECIBEL_VIEW.primarySubaccount, [owner]))[0]));
        if (pAddr) {
          const exists = subaccounts.some((x) => x.toLowerCase() === pAddr.toLowerCase()) ||
            (await aptos.getAccountResource({ accountAddress: pAddr, resourceType: SUBACCOUNT_RESOURCE() as `${string}::${string}::${string}` }).then(() => true).catch(() => false));
          if (exists) {
            primary = pAddr;
            if (!subaccounts.some((x) => x.toLowerCase() === pAddr.toLowerCase())) subaccounts = [pAddr, ...subaccounts];
          }
        }
        primaryFound = primary;
        if (!sel && primary) sel = primary;
        if (!sel && subaccounts.length === 1) sel = subaccounts[0];

        const [bal, avail] = await Promise.all([
          safe("Decibel USDC balance", () =>
            aptos.view({ payload: { function: "0x1::primary_fungible_store::balance", typeArguments: ["0x1::fungible_asset::Metadata"], functionArguments: [owner, DECIBEL_USDC] } }),
          ),
          safe("restricted mint", () => dview(DECIBEL_VIEW.mintAvailable, [owner])),
        ]);
        walletUsdc = bal ? Number(bal[0]) / 1e6 : undefined;
        mintAvailable = avail ? Number(avail[0]) / 1e6 : undefined;

        if (sel) {
          const s = sel;
          const [coll, perms] = await Promise.all([
            safe("Trading Account collateral", () => dview(DECIBEL_VIEW.collateral, [s])),
            safe("delegations", () => dview(DECIBEL_VIEW.delegations, [s])),
          ]);
          collateral = coll ? Number(coll[0]) / 1e6 : undefined;
          await Promise.all(
            MARKET_SYMBOLS.map(async (sym) => {
              const m = markets[sym];
              if (!m) return;
              if (perms) m.delegation = delegationFor(perms[0], HEDGER_ADDR, m.spec.addr, Math.floor(Date.now() / 1000));
              const pv = await safe(`Decibel ${m.spec.name} position`, () => dview(DECIBEL_VIEW.viewPosition, [s, m.spec.addr]));
              const p = (pv?.[0] as { vec?: { size: string; is_long: boolean; avg_acquire_entry_px: string; user_leverage: number }[] } | undefined)?.vec?.[0];
              if (p) {
                const size = BigInt(p.size);
                m.size = p.is_long ? size : -size;
                m.entryPx = Number(p.avg_acquire_entry_px) / 1e6;
                m.userLeverage = Number(p.user_leverage);
                if (size !== 0n) {
                  const f = await safe("funding", () => dview(DECIBEL_VIEW.fundingCost, [s, m.spec.addr]));
                  m.fundingCost = f ? Number(f[0] as MoveValue as string) / 1e6 : undefined;
                }
              } else m.size = 0n;
            }),
          );
        }
      }

      if (id !== reqId.current) return;
      setData({ subaccounts, selected: sel, primary: primaryFound, collateral, walletUsdc, mintAvailable, markets, requests, errors });
    },
    [owner, selected],
  );

  useEffect(() => {
    load();
    return visibleInterval(load, intervalMs);
  }, [load, intervalMs]);

  return { data, setSelected, refresh: load };
}
