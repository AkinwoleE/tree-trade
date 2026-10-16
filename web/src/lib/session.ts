"use client";
/**
 * 1-click trading session keys.
 * Pattern from Decibel (dex_accounts::delegate_trading_to_for_subaccount + API wallets) and the
 * Decibel SDK's guidance to use session keys in browsers: a browser-generated Ed25519 key is
 * authorized once on-chain via exchange::delegate_trading_to (wallet signature). It can only call
 * exchange::open_position_as_delegate / close_position_as_delegate for the owner; deposits and
 * withdrawals still need the wallet. Gas is paid by /api/sponsor.
 */
import { Account, Ed25519PrivateKey, Hex } from "@aptos-labs/ts-sdk";
import { MODULE_ADDR } from "@/config/contract";
import { view } from "@/lib/chain";

export interface Session { owner: string; address: string; key: string; expiresAt: number }
const k = (owner: string) => `treetrade.session.${MODULE_ADDR}.${owner.toLowerCase()}`;
export const SESSION_EVENT = "treetrade:session";
export const SESSION_TTL_SECS = 7 * 24 * 3600;

export function loadSession(owner?: string): Session | null {
  if (!owner || typeof window === "undefined") return null;
  try {
    const s = JSON.parse(localStorage.getItem(k(owner)) ?? "null") as Session | null;
    if (!s || s.expiresAt * 1000 <= Date.now() + 30_000) return null;
    return s;
  } catch { return null; }
}
export function saveSession(s: Session) { localStorage.setItem(k(s.owner), JSON.stringify(s)); window.dispatchEvent(new Event(SESSION_EVENT)); }
export function clearSession(owner: string) { localStorage.removeItem(k(owner)); window.dispatchEvent(new Event(SESSION_EVENT)); }
export function newSessionKey(owner: string): Session {
  const acct = Account.generate();
  return {
    owner,
    address: acct.accountAddress.toStringLong(),
    key: Hex.fromHexInput(acct.privateKey.toUint8Array()).toString(),
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECS,
  };
}
export const sessionAccount = (s: Session) => Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(s.key) });

/** On-chain check: is this session key still an active delegate? */
export async function sessionActiveOnChain(s: Session): Promise<boolean> {
  try {
    const r = await view("exchange::delegation_of", [s.owner, s.address]);
    return r[0] === true;
  } catch { return true; } // don't drop the key on a transient read error
}
