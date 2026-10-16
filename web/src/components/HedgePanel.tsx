"use client";

import { useState } from "react";
import { addHedgeFunds, enableHedging } from "@/lib/hedge-setup";
import { MARKET_SYMBOLS } from "@/config/contract";
import { DECIBEL_APP_URL, DECIBEL_ENTRY, DECIBEL_USDC, HEDGER_ADDR, dfn } from "@/config/decibel";
import type { DecibelAccountData, HedgerStatus } from "@/lib/hedge-hooks";
import type { SubmitFn } from "@/lib/hooks";
import { shortAddr } from "@/lib/chain";
import { fmtUsd } from "@/lib/format";
import { AmountForm, Card } from "./ui";

const DAY = 86_400;

/**
 * One-time Decibel setup for hedging. Every step is a transaction the user signs in their own wallet; the
 * hedger never holds user keys. Consent = a market-scoped, expiring perp-trading delegation on a dedicated
 * Trading Account (docs.decibel.trade/developer-hub/on-chain/account-management/delegate-trading).
 */
export function HedgePanel({
  owner,
  data,
  setSelected,
  refresh,
  hedger,
  submitFn,
  busy,
}: {
  owner?: string;
  data: DecibelAccountData;
  setSelected: (s: string | undefined) => void;
  refresh: (forceSubs?: boolean) => void;
  hedger: HedgerStatus;
  submitFn: SubmitFn;
  busy: boolean;
}) {
  const [days, setDays] = useState(7);
  const [leverage, setLeverage] = useState(10);
  const sub = data.selected;
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState<string>();
  const ready = !!sub && MARKET_SYMBOLS.every((s) => data.markets[s]?.delegation?.canTrade);
  const setup = async () => {
    if (!owner) return;
    setWorking(true);
    setMsg(undefined);
    try {
      const r = await enableHedging(owner, submitFn);
      if (r.sub) setSelected(r.sub);
      if (r.error) setMsg(r.error);
      refresh(true);
    } finally {
      setWorking(false);
    }
  };
  const addFunds = async () => {
    if (!owner || !sub) return;
    setWorking(true);
    setMsg(undefined);
    try {
      const e = await addHedgeFunds(owner, sub, submitFn);
      if (e) setMsg(e);
    } finally {
      setWorking(false);
    }
  };
  const hedgerAddr = HEDGER_ADDR || hedger.hedger || "";
  const mismatch = hedger.hedger && HEDGER_ADDR && hedger.hedger.toLowerCase() !== HEDGER_ADDR.toLowerCase();

  const createSub = async () => {
    const tx = await submitFn("Create Trading Account", dfn(DECIBEL_ENTRY.createSubaccount), []);
    const ev = tx && "events" in tx ? tx.events.find((e) => e.type.endsWith("::dex_accounts::SubaccountCreatedEvent")) : undefined;
    const addr = (ev?.data as { subaccount?: string } | undefined)?.subaccount;
    if (addr) setSelected(addr);
    refresh(true);
  };

  return (
    <Card
      title="Hedge on Decibel"
      right={
        <span className={`text-xs ${hedger.available && (hedger.age ?? 999) < 90 ? "text-emerald-400" : hedger.limited ? "text-zinc-400" : "text-rose-400"}`}>
          hedger {hedger.available ? `${hedger.mode} · ${hedger.age}s ago` : hedger.limited ? "status from chain" : "offline"}
        </span>
      }
    >
      <p className="text-xs text-zinc-500">
        Hedged positions get an opposite position on{" "}
        <a className="underline" href={DECIBEL_APP_URL} target="_blank" rel="noreferrer">
          Decibel
        </a>{" "}
        in a Trading Account you own. You allow the hedger ({hedgerAddr ? shortAddr(hedgerAddr) : "not configured"}) to trade BTC/ETH perps on that
        account only. It cannot withdraw, and you can revoke at any time.
      </p>
      {mismatch && <p className="text-xs text-rose-400">NEXT_PUBLIC_HEDGER_ADDR does not match the running hedger ({shortAddr(hedger.hedger!)}).</p>}
      {hedger.mode === "mock" && <p className="text-xs text-amber-400">The hedger runs in mock mode: no real Decibel orders are placed.</p>}

      {!owner ? (
        <p className="text-sm text-zinc-500">Connect a wallet to set up hedging.</p>
      ) : (
        <>
        <div className="rounded-lg border border-zinc-800 p-3 text-sm">
          {!ready ? (
            <>
              <p className="mb-2 text-xs text-zinc-400">
                One signature sets everything up: we add 1,000 test USDC, create your Decibel Trading Account, deposit it and let the hedger trade BTC/ETH
                perps on it for {30} days. Gas is on us.
              </p>
              <button className="btn btn-primary w-full" disabled={busy || working || !hedgerAddr} onClick={setup}>
                {working ? "Setting up…" : "Enable hedging (1 signature)"}
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-emerald-400">Hedging enabled</span>
                <span className="font-mono text-xs text-zinc-500">{shortAddr(sub!)}</span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-y-1 text-xs">
                <dt className="text-zinc-500">Decibel balance</dt>
                <dd className="text-right font-mono">{fmtUsd(data.collateral)}</dd>
                <dt className="text-zinc-500">In your wallet</dt>
                <dd className="text-right font-mono">{fmtUsd(data.walletUsdc)}</dd>
                {MARKET_SYMBOLS.map((s) => {
                  const m = data.markets[s];
                  if (!m?.size) return null;
                  const base = Number(m.size) / 10 ** m.spec.szDecimals;
                  return (
                    <span key={s} className="contents">
                      <dt className="text-zinc-500">{m.spec.name} hedge</dt>
                      <dd className={`text-right font-mono ${base > 0 ? "text-emerald-400" : "text-rose-400"}`}>{base > 0 ? "LONG" : "SHORT"} {Math.abs(base)}</dd>
                    </span>
                  );
                })}
              </dl>
              <div className="mt-2">
                <AmountForm
                  placeholder="USDC to withdraw"
                  max={data.collateral}
                  disabled={busy || working}
                  actions={[
                    {
                      label: "Withdraw back",
                      onClick: (a) => submitFn("Withdraw from hedge account", dfn(DECIBEL_ENTRY.withdraw), [sub!, DECIBEL_USDC, BigInt(Math.floor(a * 1e6))]),
                    },
                  ]}
                />
              </div>
              <button className="btn btn-ghost mt-2 w-full text-xs" disabled={busy || working} onClick={addFunds}>
                Add 1,000 test USDC
              </button>
              <p className="mt-1 text-xs text-zinc-500">Withdrawals go to your wallet. Keep BTC/ETH on this account for hedges only: the hedger holds them at the hedge size.</p>
            </>
          )}
          {msg && <p className="mt-2 text-xs text-amber-400">{msg}</p>}
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-zinc-500">Advanced: manual setup</summary>
        <ol className="mt-3 space-y-3 text-sm">
          <li>
            <div className="label mb-1">1 · Trading Account (dedicated to hedges)</div>
            <div className="flex gap-2">
              <select className="input flex-1 font-mono text-xs" value={sub ?? ""} onChange={(e) => setSelected(e.target.value || undefined)}>
                <option value="">{data.subaccounts.length ? "select…" : "none found"}</option>
                {data.subaccounts.map((s) => (
                  <option key={s} value={s}>
                    {shortAddr(s)}
                  </option>
                ))}
              </select>
              <button className="btn btn-ghost" disabled={busy} onClick={createSub}>
                New
              </button>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Use an account you do not trade manually: the hedger keeps each market at exactly the hedge size.
            </p>
          </li>

          <li>
            <div className="label mb-1">2 · Collateral</div>
            <div className="mb-2 flex justify-between font-mono text-xs">
              <span>wallet {fmtUsd(data.walletUsdc)}</span>
              <span>Trading Account {fmtUsd(data.collateral)}</span>
            </div>
            <div className="flex gap-2">
              <button
                className="btn btn-ghost flex-1"
                disabled={busy || !data.mintAvailable}
                title="Decibel testnet usdc::restricted_mint"
                onClick={() =>
                  submitFn("Mint Decibel test USDC", dfn(DECIBEL_ENTRY.restrictedMint), [BigInt(Math.floor(Math.min(data.mintAvailable ?? 0, 1000) * 1e6))])
                }
              >
                Mint {data.mintAvailable ? Math.min(data.mintAvailable, 1000).toLocaleString() : 0} test USDC
              </button>
            </div>
            <div className="mt-2">
              <AmountForm
                placeholder="USDC to deposit"
                max={data.walletUsdc}
                disabled={busy || !sub}
                actions={[
                  {
                    label: "Deposit",
                    primary: true,
                    onClick: (a) => submitFn("Deposit to Trading Account", dfn(DECIBEL_ENTRY.deposit), [sub!, DECIBEL_USDC, BigInt(Math.floor(a * 1e6))]),
                  },
                ]}
              />
            </div>
          </li>

          <li>
            <div className="label mb-1">3 · Permission and leverage per market</div>
            <div className="mb-2 flex items-center gap-2 text-xs text-zinc-400">
              expires in
              <select className="input w-20 py-1" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[1, 7, 30].map((d) => (
                  <option key={d} value={d}>
                    {d}d
                  </option>
                ))}
              </select>
              leverage
              <input className="input w-16 py-1" inputMode="numeric" value={leverage} onChange={(e) => setLeverage(Number(e.target.value.replace(/\D/g, "")) || 1)} />x
            </div>
            <table className="w-full text-xs">
              <tbody>
                {MARKET_SYMBOLS.map((s) => {
                  const m = data.markets[s];
                  const d = m?.delegation;
                  const lev = Math.min(leverage, m?.spec.maxLeverage ?? leverage);
                  return (
                    <tr key={s} className="border-t border-zinc-800">
                      <td className="py-1.5 font-mono">{m?.spec.name ?? s}</td>
                      <td>
                        {d?.canTrade ? (
                          <span className="text-emerald-400">
                            delegated{d.expiresAt ? ` until ${new Date(d.expiresAt * 1000).toLocaleDateString()}` : ""}
                            {d.scope === "all-perps" && " (all perps)"}
                          </span>
                        ) : (
                          <span className="text-zinc-500">not delegated</span>
                        )}
                        {d?.excessive.length ? <div className="text-zinc-500">also granted: {d.excessive.join(", ")} (unused by the hedger; it cannot withdraw)</div> : null}
                        {m?.userLeverage ? <div className="text-zinc-500">{m.userLeverage}x set</div> : null}
                      </td>
                      <td className="text-right">
                        <button
                          className="btn btn-ghost px-2 py-1"
                          disabled={busy || !sub || !m}
                          title={`configure_user_settings_for_market: cross, ${lev}x (max ${m?.spec.maxLeverage}x)`}
                          onClick={() => submitFn(`Set ${m!.spec.name} ${lev}x cross`, dfn(DECIBEL_ENTRY.configureMarket), [sub!, m!.spec.addr, true, lev])}
                        >
                          {lev}x
                        </button>
                        <button
                          className="btn btn-primary ml-1 px-2 py-1"
                          disabled={busy || !sub || !m || !hedgerAddr}
                          onClick={() =>
                            submitFn(`Allow hedger on ${m!.spec.name}`, dfn(DECIBEL_ENTRY.delegateMarket), [
                              sub!,
                              hedgerAddr,
                              m!.spec.addr,
                              BigInt(Math.floor(Date.now() / 1000) + days * DAY),
                            ])
                          }
                        >
                          Allow
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <button
              className="btn btn-ghost mt-2 w-full text-xs"
              disabled={busy || !sub || !hedgerAddr || !MARKET_SYMBOLS.some((s) => data.markets[s]?.delegation?.canTrade || data.markets[s]?.delegation?.excessive.length)}
              onClick={() => submitFn("Revoke hedger", dfn(DECIBEL_ENTRY.revoke), [sub!, hedgerAddr])}
            >
              Revoke hedger permission
            </button>
          </li>
        </ol>
        </details>
        </>
      )}
    </Card>
  );
}
