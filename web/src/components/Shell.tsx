"use client";
import { useEffect, useState, type ReactNode } from "react";
import { MODULE_ADDR } from "@/config/contract";
import { shortAddr } from "@/lib/chain";
import { AppStateProvider, useApp } from "@/lib/app-state";
import { LiveProvider } from "@/lib/live";
import { Nav } from "@/components/Nav";

function Frame({ children }: { children: ReactNode }) {
  const { tx, errors, decibel, connected } = useApp();
  // Raw view-call errors are for debugging only (?debug=1).
  const [debug, setDebug] = useState(false);
  useEffect(() => setDebug(new URLSearchParams(window.location.search).has("debug")), []);
  return (
    <main className="mx-auto max-w-[1600px] space-y-3 p-3 md:px-5">
      <Nav />
      {MODULE_ADDR === "0x0" && (
        <div className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">NEXT_PUBLIC_MODULE_ADDR is not set; on-chain calls will fail.</div>
      )}
      {(tx.pending || tx.last) && (
        <div className={`rounded-lg border p-3 text-sm ${tx.pending ? "border-indigo-700 bg-indigo-950/40" : tx.last?.ok ? "border-emerald-700 bg-emerald-950/40" : "border-rose-700 bg-rose-950/40"}`}>
          {tx.pending ? `${tx.pending}: waiting for wallet / confirmation…` : tx.last?.msg}
          {!tx.pending && tx.last?.url && (
            <a className="ml-2 underline" href={tx.last.url} target="_blank" rel="noreferrer">{shortAddr(tx.last.hash!)}</a>
          )}
        </div>
      )}
      {children}
      {!connected && <p className="text-center text-sm text-zinc-500">Connect a wallet (set to testnet) to trade.</p>}
      {debug && errors.length + decibel.errors.length > 0 && (
        <details className="text-xs text-zinc-500">
          <summary>{errors.length + decibel.errors.length} view call(s) failing (module at {shortAddr(MODULE_ADDR)})</summary>
          <ul className="mt-2 list-disc pl-5">{[...errors, ...decibel.errors].map((e) => <li key={e}>{e}</li>)}</ul>
        </details>
      )}
    </main>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <LiveProvider>
      <AppStateProvider>
        <Frame>{children}</Frame>
      </AppStateProvider>
    </LiveProvider>
  );
}
