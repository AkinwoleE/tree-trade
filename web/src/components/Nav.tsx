"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useApp } from "@/lib/app-state";
import { useSettings } from "@/lib/settings";
import { WalletButton } from "@/components/WalletButton";
import { AccountPanel } from "@/components/AccountPanel";
import { CrossChainPanel } from "@/components/CrossChainPanel";
import { ThemeToggle } from "@/components/ThemeToggle";

const MAIN = [
  ["/trade/btc", "Trade", "/trade"],
  ["/portfolio", "Portfolio"],
  ["/house", "House"],
  ["/seeds", "SEEDS"],
  ["/leaderboard", "Leaderboard"],
] as const;
const MORE = [
  ["/dashboard", "Dashboard"],
  ["/stats", "Stats"],
  ["/docs", "Docs"],
] as const;

export function Nav() {
  const path = usePathname() || "/";
  const a = useApp();
  const [settings, setSettings] = useSettings();
  const [more, setMore] = useState(false);
  const [gear, setGear] = useState(false);
  const [modal, setModal] = useState<null | "Deposit" | "Withdraw">(null);
  const link = (href: string, label: string, prefix?: string) => {
    const on = path.startsWith(prefix ?? href);
    return (
      <Link key={href} href={href} className={`px-1 py-1 text-sm ${on ? "border-b-2 border-zinc-100 font-semibold text-zinc-100" : "text-zinc-400 hover:text-zinc-100"}`}>
        {label}
      </Link>
    );
  };
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-2">
      <div className="flex flex-wrap items-center gap-5">
        <Link href="/trade/btc" className="text-lg font-semibold tracking-tight">
          tree<span className="text-emerald-400">trade</span>
          <span className="ml-2 align-middle text-[10px] font-normal text-zinc-500">by APTree</span>
          <span className="ml-2 rounded bg-amber-950 px-1.5 py-0.5 align-middle text-[10px] font-normal text-amber-300">testnet</span>
        </Link>
        <nav className="flex items-center gap-4">
          {MAIN.map(([h, l, p]) => link(h, l, p))}
          <div className="relative">
            <button className={`px-1 py-1 text-sm ${MORE.some(([h]) => path.startsWith(h)) ? "font-semibold text-zinc-100" : "text-zinc-400 hover:text-zinc-100"}`} onClick={() => setMore((o) => !o)}>
              More ▾
            </button>
            {more && (
              <div className="absolute z-30 mt-1 w-36 rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-lg" onMouseLeave={() => setMore(false)}>
                {MORE.map(([h, l]) => (
                  <Link key={h} href={h} className="block rounded px-2 py-1 text-sm hover:bg-zinc-800" onClick={() => setMore(false)}>{l}</Link>
                ))}
              </div>
            )}
          </div>
        </nav>
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <div className="relative">
          <button className="rounded-lg px-2 py-1.5 text-zinc-400 hover:text-zinc-100" title="Settings" onClick={() => setGear((o) => !o)}>⚙</button>
          {gear && (
            <div className="absolute right-0 z-30 mt-1 w-56 space-y-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm shadow-lg">
              <label className="flex items-center justify-between">Display entries on chart <input type="checkbox" checked={settings.showEntries} onChange={(e) => setSettings({ showEntries: e.target.checked })} /></label>
              <label className="flex items-center justify-between">Display busts on chart <input type="checkbox" checked={settings.showBusts} onChange={(e) => setSettings({ showBusts: e.target.checked })} /></label>
            </div>
          )}
        </div>
        <button className="btn btn-ghost py-1.5" onClick={() => setModal("Deposit")}>Deposit</button>
        <button className="btn btn-ghost py-1.5" onClick={() => setModal("Withdraw")}>Withdraw</button>
        <WalletButton />
      </div>
      {modal && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/20 pt-16 overflow-y-auto" onClick={() => setModal(null)}>
          <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <AccountPanel data={a.data} faucetAmount={a.pool.faucetAmount} submit={a.tx.submit} busy={a.busy} />
            {modal === "Deposit" && <CrossChainPanel submit={a.tx.submit} busy={a.busy} />}
            <button className="mt-2 w-full text-center text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setModal(null)}>Close</button>
          </div>
        </div>
      )}
    </header>
  );
}
