"use client";
import { useApp } from "@/lib/app-state";
import { AccountPanel } from "@/components/AccountPanel";
import { TradePanel } from "@/components/TradePanel";
import { PositionsTable } from "@/components/PositionsTable";
import { PaperPanel } from "@/components/PaperPanel";
import { PriceChart } from "@/components/PriceChart";
import { PoolPanel } from "@/components/PoolPanel";
import { HedgePanel } from "@/components/HedgePanel";

/** Everything on one screen (the original Tree Trade dashboard). */
export default function Dashboard() {
  const a = useApp();
  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <div className="space-y-4">
        <TradePanel prices={a.quote?.prices} oracle={a.pool.oracle} maxStaleness={a.pool.maxStaleness} collateral={a.data.collateral} decibel={a.decibel} queued={a.data.queued?.total} sideOi={a.pool.sideOi} submit={a.tx.submit} busy={a.busy} />
        <AccountPanel data={a.data} faucetAmount={a.pool.faucetAmount} submit={a.tx.submit} busy={a.busy} />
        <HedgePanel owner={a.address} data={a.decibel} setSelected={a.setSelected} refresh={a.refreshDecibel} hedger={a.hedger} submitFn={a.tx.submitFn} busy={a.busy} />
      </div>
      <div className="space-y-4">
        <PriceChart prices={a.quote?.prices} positions={a.data.positions} />
        <PositionsTable positions={a.data.positions} prices={a.quote?.prices} decibel={a.decibel} hedger={a.hedger} submit={a.tx.submit} busy={a.busy} />
        <div className="grid gap-4 xl:grid-cols-2">
          <PaperPanel data={a.data} pool={a.pool} submit={a.tx.submit} busy={a.busy} />
          <PoolPanel pool={a.pool} submit={a.tx.submit} busy={a.busy} />
        </div>
      </div>
    </div>
  );
}
