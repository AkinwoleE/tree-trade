"use client";

import { ENTRY, MARKET_SYMBOLS, MAX_CRANK_STEPS } from "@/config/contract";
import type { PoolData, Submit } from "@/lib/hooks";
import { fmtNum, fmtUsd } from "@/lib/format";
import { shortAddr } from "@/lib/chain";
import { Card, Stat } from "./ui";

export function PoolPanel({ pool, submit, busy }: { pool: PoolData; submit: Submit; busy: boolean }) {
  const [vault, balances, margin, poolBal, devFees] = pool.accounting ?? [];
  const q = pool.queue;
  const queued = q ? q.tail - q.head : 0;

  return (
    <Card
      title="House pool"
      right={pool.paused && <span className="rounded bg-rose-600/30 px-2 py-0.5 text-xs text-rose-300">PAUSED</span>}
    >
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Pool balance" value={fmtUsd(poolBal)} sub="pays winners, cap 5M" />
        <Stat label="Vault total" value={fmtUsd(vault)} />
        <Stat label="Trader balances" value={fmtUsd(balances)} />
        <Stat label="Locked margin" value={fmtUsd(margin)} />
        <Stat label="Fees → stakers" value={fmtUsd(pool.feeStats?.[0])} />
        <Stat label="Fees → dev" value={fmtUsd(pool.feeStats?.[1])} sub={`unwithdrawn ${fmtUsd(devFees)}`} />
        <Stat label="SEEDS supply" value={fmtNum(pool.paperSupply)} />
        <Stat label="SEEDS staked" value={fmtNum(pool.paperStaked)} />
      </div>

      <div>
        <div className="label mb-1">Open interest vs per-side caps (asset units; keeper keeps ~$1B of room per side)</div>
        {MARKET_SYMBOLS.map((s) => {
          const so = pool.sideOi?.[s];
          const big = (x?: number) => (x === undefined ? "–" : x > 1e12 ? "∞" : fmtNum(x, 2));
          return so ? (
            <div key={s} className="flex justify-between font-mono text-sm">
              <span className="text-zinc-400">{s}</span>
              <span>
                long <span className="text-emerald-400">{big(so.long)}</span> / {big(so.longCap)} · short{" "}
                <span className="text-rose-400">{big(so.short)}</span> / {big(so.shortCap)}
              </span>
            </div>
          ) : null;
        })}
        <div className="label mb-1 mt-2">Open interest by notional (long / short)</div>
        {MARKET_SYMBOLS.map((s) => {
          const oi = pool.openInterest[s];
          return (
            <div key={s} className="flex justify-between font-mono text-sm">
              <span className="text-zinc-400">{s}</span>
              <span>
                <span className="text-emerald-400">{fmtUsd(oi?.long, 0)}</span> /{" "}
                <span className="text-rose-400">{fmtUsd(oi?.short, 0)}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="label">
            Payout queue — {queued} entr{queued === 1 ? "y" : "ies"}, owed {fmtUsd(q?.owed)}
          </span>
          <button
            className="btn btn-ghost py-1 text-xs"
            disabled={busy || queued === 0}
            title="Pay queued winners from the pool (permissionless)"
            onClick={() => submit("Process queue", ENTRY.processQueue, [BigInt(Math.min(queued, MAX_CRANK_STEPS))])}
          >
            Crank
          </button>
        </div>
        {!q || q.rows.length === 0 ? (
          <p className="text-sm text-zinc-500">Queue is empty — all winners paid.</p>
        ) : (
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-zinc-500">
                <tr>
                  <th className="py-1">#</th>
                  <th>Owner</th>
                  <th>Position</th>
                  <th className="text-right">Remaining</th>
                  <th className="text-right">Original</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {q.rows.map((r) => (
                  <tr key={r.index} className="border-t border-zinc-800">
                    <td className="py-1 text-zinc-500">{r.index}</td>
                    <td title={r.owner}>{shortAddr(r.owner)}</td>
                    <td>#{r.positionId}</td>
                    <td className="text-right">{fmtUsd(r.remaining)}</td>
                    <td className="text-right text-zinc-500">{fmtUsd(r.original)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {queued > q.rows.length && (
              <p className="mt-1 text-xs text-zinc-500">…and {queued - q.rows.length} more</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
