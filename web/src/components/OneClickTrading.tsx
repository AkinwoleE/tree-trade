"use client";
import { useEffect, useState } from "react";
import { ENTRY, fn } from "@/config/contract";
import { useApp } from "@/lib/app-state";
import { SESSION_EVENT, clearSession, loadSession, newSessionKey, saveSession, sessionActiveOnChain, type Session } from "@/lib/session";

/** "Enable 1-click trading": one wallet signature authorizes a browser session key to open/close positions only. */
export function OneClickTrading() {
  const { address, tx, busy } = useApp();
  const [s, setS] = useState<Session | null>(null);
  const [working, setWorking] = useState(false);
  // Session-key scope (AUDIT decision 7): hedged opens on by default, spending queued winnings off.
  const [allowHedge, setAllowHedge] = useState(true);
  const [allowQueue, setAllowQueue] = useState(false);

  useEffect(() => {
    const sync = () => setS(loadSession(address));
    sync();
    window.addEventListener(SESSION_EVENT, sync);
    return () => window.removeEventListener(SESSION_EVENT, sync);
  }, [address]);
  useEffect(() => {
    if (!s) return;
    sessionActiveOnChain(s).then((ok) => { if (!ok) clearSession(s.owner); });
  }, [s]);

  if (!address) return null;
  const enable = async () => {
    setWorking(true);
    try {
      const sess = newSessionKey(address);
      const r = await tx.submitFn("Enable 1-click trading", fn(ENTRY.delegateTradingWithScope), [sess.address, BigInt(sess.expiresAt), allowHedge, allowQueue]);
      if (r) saveSession(sess);
    } finally { setWorking(false); }
  };
  const revoke = async () => {
    if (!s) return;
    setWorking(true);
    try {
      const r = await tx.submitFn("Revoke 1-click trading", fn(ENTRY.revokeDelegation), [s.address]);
      if (r) clearSession(s.owner);
    } finally { setWorking(false); }
  };

  return (
    <div className="card flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="font-medium">1-click trading {s ? <span className="text-emerald-400">On</span> : <span className="text-zinc-500">Off</span>}</div>
        <div className="text-xs text-zinc-500">
          {s
            ? `Trades open and close without a wallet popup. Expires ${new Date(s.expiresAt * 1000).toLocaleString()}.`
            : "Sign once to trade without popups for up to 7 days. Deposits and withdrawals still need your wallet."}
        </div>
        {!s && (
          <div className="mt-1 flex gap-3 text-xs text-zinc-400">
            <label className="flex items-center gap-1"><input type="checkbox" checked={allowHedge} onChange={(e) => setAllowHedge(e.target.checked)} /> Allow hedged opens</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={allowQueue} onChange={(e) => setAllowQueue(e.target.checked)} /> Allow spending queued winnings</label>
          </div>
        )}
      </div>
      {s ? (
        <button className="btn btn-ghost shrink-0 px-2 py-1 text-xs" disabled={busy || working} onClick={revoke}>Revoke</button>
      ) : (
        <button className="btn shrink-0 bg-emerald-600 px-2 py-1 text-xs hover:bg-emerald-500" disabled={busy || working} onClick={enable}>Enable</button>
      )}
    </div>
  );
}
