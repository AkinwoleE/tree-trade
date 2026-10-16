"use client";

import { useState } from "react";
import { groupAndSortWallets, truncateAddress, useWallet } from "@aptos-labs/wallet-adapter-react";
import { NETWORK } from "@/lib/chain";

/**
 * Wallet selector built on the adapter's own helpers (aptos.dev/build/sdks/wallet-adapter/dapp):
 * groupAndSortWallets splits social-login (Petra Web / Aptos Connect), installed and installable wallets.
 */
export function WalletButton() {
  const { connected, account, network, wallet, wallets = [], notDetectedWallets = [], connect, disconnect, changeNetwork, isLoading } = useWallet();
  const [open, setOpen] = useState(false);
  const [netError, setNetError] = useState<string>();

  if (connected && account) {
    const wrongNet = network?.name && network.name.toLowerCase() !== NETWORK;
    return (
      <div className="flex items-center gap-2">
        {wrongNet && (
          <button
            className="text-xs text-amber-400 underline"
            title={netError ?? "Ask the wallet to switch (not every wallet supports this)"}
            onClick={() => changeNetwork(NETWORK).catch((e: unknown) => setNetError(`${wallet?.name} cannot switch networks: ${String(e)}`))}
          >
            switch wallet to testnet
          </button>
        )}
        <div className="relative">
          <button className="flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-mono text-sm" title={`${wallet?.name}: ${account.address.toString()}`} onClick={() => setOpen((o) => !o)}>
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {truncateAddress(account.address.toString())}
          </button>
          {open && (
            <div className="absolute right-0 z-30 mt-1 w-44 rounded-lg border border-zinc-800 bg-zinc-900 p-1 text-sm shadow-lg">
              <button className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800" onClick={() => { navigator.clipboard?.writeText(account.address.toString()); setOpen(false); }}>Copy address</button>
              <button className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800" onClick={() => { setOpen(false); disconnect(); }}>Disconnect</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const { petraWebWallets, availableWallets, installableWallets } = groupAndSortWallets([...wallets, ...notDetectedWallets]);
  const item = (w: { name: string; icon: string }, dim = false) => (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={w.icon} alt="" className={`h-5 w-5 ${dim ? "opacity-50" : ""}`} />
      {w.name}
    </>
  );

  return (
    <div className="relative">
      <button className="btn btn-primary" disabled={isLoading} onClick={() => setOpen((o) => !o)}>
        Connect wallet
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 w-64 rounded-xl border border-zinc-800 bg-zinc-900 p-2 shadow-xl">
          {[...petraWebWallets, ...availableWallets].length === 0 && <p className="p-2 text-sm text-zinc-400">No Aptos wallet detected.</p>}
          {[...petraWebWallets, ...availableWallets].map((w) => (
            <button
              key={w.name}
              className="flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-zinc-800"
              onClick={() => {
                connect(w.name);
                setOpen(false);
              }}
            >
              {item(w)}
            </button>
          ))}
          {installableWallets.slice(0, 4).map((w) => (
            <a
              key={w.name}
              href={w.url}
              target="_blank"
              rel="noreferrer"
              className="flex w-full items-center gap-2 rounded-lg p-2 text-sm text-zinc-500 hover:bg-zinc-800"
            >
              {item(w, true)} <span className="ml-auto text-xs">install</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
