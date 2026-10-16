"use client";
import { MARKET_SYMBOLS } from "@/config/contract";
import { useApp } from "@/lib/app-state";
import { useActivity } from "@/lib/use-activity";
import { fmtNum, fmtUsd } from "@/lib/format";
import { PoolPanel } from "@/components/PoolPanel";
import { Card, Stat } from "@/components/ui";

export default function House() {
  const { pool, tx, busy } = useApp();
  const { activity } = useActivity();
  const oi = MARKET_SYMBOLS.map((s) => ({ s, long: pool.openInterest[s]?.long ?? 0, short: pool.openInterest[s]?.short ?? 0 }));
  const tot = oi.reduce((a, r) => ({ long: a.long + r.long, short: a.short + r.short }), { long: 0, short: 0 });
  const [, , margin, poolBal] = pool.accounting ?? [];
  const openCount = (activity?.opens.length ?? 0) - (activity?.trades.length ?? 0);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="User positions">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Open interest" value={fmtUsd(tot.long + tot.short, 0)} />
            <Stat label="Open margin" value={fmtUsd(margin)} />
            <Stat label="Open positions" value={activity && !activity.partial ? Math.max(0, openCount) : "–"} sub={activity?.partial ? "recent activity only" : undefined} />
          </div>
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500"><tr><th>Market</th><th className="text-right">Long</th><th className="text-right">Short</th><th className="text-right">Net</th></tr></thead>
            <tbody className="font-mono">
              {[...oi, { s: "Total", ...tot }].map((r) => (
                <tr key={r.s} className="border-t border-zinc-800"><td className="py-1">{r.s}</td><td className="text-right text-emerald-400">{fmtUsd(r.long, 0)}</td><td className="text-right text-rose-400">{fmtUsd(r.short, 0)}</td><td className="text-right">{fmtUsd(r.long - r.short, 0)}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="SEEDS">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="SEEDS supply" value={fmtNum(pool.paperSupply)} />
            <Stat label="SEEDS staked" value={fmtNum(pool.paperStaked)} />
            <Stat label="Staker rewards" value={fmtUsd(pool.rewards?.[0])} />
            <Stat label="Reward token / fee" value="USDC / 1%" sub="half of the 2% fee" />
          </div>
        </Card>
        <Card title="House LP & payout queue">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="LP cash" value={fmtUsd(poolBal)} sub="only from trader losses, no deposits" />
            <Stat label="Payout queue" value={fmtUsd(pool.queue?.owed)} sub={`${pool.queue ? pool.queue.tail - pool.queue.head : 0} winners waiting`} />
            <Stat label="Tracked LP" value={fmtUsd(pool.trackedLp)} sub="LP cash − queue (sets SEEDS rate)" />
            <Stat label="SEEDS per $1 lost" value={pool.seedsRate !== undefined ? fmtNum(pool.seedsRate, 2) : "–"} />
            <Stat label="Fees to stakers" value={fmtUsd(pool.feeStats?.[0])} sub="USDC, incl. LP above $5M" />
            <Stat label="Fees to dev" value={fmtUsd(pool.feeStats?.[1])} />
          </div>
        </Card>
      </div>
      <Card title="How payouts and fees work">
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-300">
          <li>The house LP starts at $0 and nobody can deposit into it. It only grows from traders&apos; losses.</li>
          <li>Winners are paid from LP cash only. If the LP can&apos;t cover a win, the rest joins a first-in, first-out payout queue. Your margin is always returned right away.</li>
          <li>While anyone is queued, new wins are queued too, and every loss pays the queue (oldest first) before it reaches the LP.</li>
          <li>Wins get an asymmetric-impact haircut that shrinks with how far price moved (BTC keeps ~74% of a 0.1% move, ~88% of a 1% move, never more than 90%), then a 2% win fee. Losses pay nothing extra.</li>
          <li>The 2% fee on wins, losses and liquidations goes half to SEEDS stakers (in USDC) and half to the dev, but only when the queue is empty and the LP can cover it. Queued winners always come first.</li>
          <li>Tracked LP above $5M is swept to SEEDS stakers.</li>
          <li>Queued winnings can be used as margin for new trades.</li>
        </ul>
      </Card>
      <PoolPanel pool={pool} submit={tx.submit} busy={busy} />
    </div>
  );
}
