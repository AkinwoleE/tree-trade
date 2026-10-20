"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useChainData, usePrices, useTx } from "@/lib/hooks";
import { useDecibelAccount, useHedgerStatus } from "@/lib/hedge-hooks";
import { useLive } from "@/lib/live";
import type { PriceQuote } from "@/lib/prices";
import { setAnchor } from "@/lib/price-anchor";
import type { MarketSymbol } from "@/config/contract";

/** One shared poller for every page (prices, chain state, Decibel account, hedger status, tx submit). */
function useAppStateValue() {
  const { account, connected } = useWallet();
  const address = account?.address.toString();
  // Prices come from the live stream (browser WebSockets, SSE fallback); the HTTP poll runs only while it has no fresh tick.
  const live = useLive();
  const fresh = Object.fromEntries(Object.entries(live.last).filter(([, t]) => t && Date.now() - t.t < 15_000).map(([s, t]) => [s, t!.p]));
  // Give the browser feeds 5 s to connect before the server poll kicks in (saves a call per page load).
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGraceOver(true), 5_000);
    return () => clearTimeout(t);
  }, []);
  const { quote: polled, error: priceError } = usePrices(15_000, graceOver && (!live.connected || Object.keys(fresh).length === 0));
  const quote: PriceQuote | undefined = polled || Object.keys(fresh).length
    ? { source: live.source ?? polled?.source ?? "", prices: { ...(polled?.prices ?? {}), ...fresh }, ts: Date.now() }
    : undefined;
  const { account: data, pool, errors, refresh } = useChainData(address);
  // The keeper's on-chain price anchors the live display (0.3% guard); no extra calls, it is already polled.
  useEffect(() => {
    for (const [s, o] of Object.entries(pool.oracle)) if (o) setAnchor(s as MarketSymbol, o.price, o.publishTime * 1000, "chain");
  }, [pool.oracle]);
  const { data: decibel, setSelected, refresh: refreshDecibel } = useDecibelAccount(address);
  const hedger = useHedgerStatus();
  const tx = useTx(() => {
    refresh();
    refreshDecibel();
  });
  const busy = !!tx.pending || !connected;
  return { address, connected, quote, priceError, data, pool, errors, refresh, decibel, setSelected, refreshDecibel, hedger, tx, busy };
}

export type AppState = ReturnType<typeof useAppStateValue>;
const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const v = useAppStateValue();
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppStateProvider");
  return v;
}
