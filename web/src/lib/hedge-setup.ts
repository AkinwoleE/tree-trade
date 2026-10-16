"use client";
/**
 * One-click hedging setup (see HEDGE_DESIGN.md §10).
 * 1. /api/hedge/fund puts Decibel testnet USDC in the wallet (server-signed, no user prompt).
 * 2. ONE user signature: dex_accounts_entry::add_delegated_trader_and_deposit_to_subaccount on the user's
 *    primary Decibel Trading Account, which creates it, deposits and delegates trading to the hedger (expiring).
 *    Gas is paid by /api/sponsor.
 */
import { aptos } from "@/lib/chain";
import { DECIBEL_ENTRY, DECIBEL_USDC, HEDGER_ADDR, dfn } from "@/config/decibel";
import type { SubmitFn } from "@/lib/hooks";

export const HEDGE_DELEGATION_DAYS = 30;

export async function primarySubaccount(owner: string): Promise<string> {
  const r = await aptos.view({ payload: { function: dfn("dex_accounts::primary_subaccount"), functionArguments: [owner] } });
  return String(r[0]);
}

export async function walletDecibelUsdc(owner: string): Promise<bigint> {
  const r = await aptos
    .view({ payload: { function: "0x1::primary_fungible_store::balance", typeArguments: ["0x1::fungible_asset::Metadata"], functionArguments: [owner, DECIBEL_USDC] } })
    .catch(() => ["0"]);
  return BigInt(String(r[0]));
}

/** Server-side testnet top-up of the wallet's Decibel USDC. Returns an error string or undefined. */
export async function fundWallet(owner: string): Promise<string | undefined> {
  const r = await fetch("/api/hedge/fund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) });
  const j = await r.json().catch(() => ({}));
  return r.ok ? undefined : (j.error ?? `fund ${r.status}`);
}

/** Fund + one signature. Resolves to the Trading Account address on success. */
export async function enableHedging(owner: string, submitFn: SubmitFn): Promise<{ sub?: string; error?: string }> {
  if (!HEDGER_ADDR) return { error: "hedger not configured" };
  const fundErr = await fundWallet(owner);
  const bal = await walletDecibelUsdc(owner);
  if (bal === 0n && fundErr) return { error: `Could not get test USDC for the hedge account: ${fundErr}` };
  const sub = await primarySubaccount(owner);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + HEDGE_DELEGATION_DAYS * 86_400);
  const tx = await submitFn("Enable hedging", dfn(DECIBEL_ENTRY.oneClickSetup), [sub, DECIBEL_USDC, bal, HEDGER_ADDR, expiry]);
  return tx ? { sub } : { error: "setup transaction failed or was rejected" };
}

/** Add funds later: server top-up, then one signature to deposit (deposit_to_subaccount_at is owner-only). */
export async function addHedgeFunds(owner: string, sub: string, submitFn: SubmitFn): Promise<string | undefined> {
  const fundErr = await fundWallet(owner);
  const bal = await walletDecibelUsdc(owner);
  if (bal === 0n) return fundErr ?? "no USDC in wallet";
  const tx = await submitFn("Add funds to hedge account", dfn(DECIBEL_ENTRY.deposit), [sub, DECIBEL_USDC, bal]);
  return tx ? undefined : "deposit failed or was rejected";
}
