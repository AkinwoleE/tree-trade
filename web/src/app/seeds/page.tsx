"use client";
import { useApp } from "@/lib/app-state";
import { fmtNum, fmtUsd } from "@/lib/format";
import { MODULE_ADDR } from "@/config/contract";
import { shortAddr } from "@/lib/chain";
import { PaperPanel } from "@/components/PaperPanel";
import { SeedsCurve } from "@/components/SeedsCurve";
import { Card, Stat } from "@/components/ui";

export default function Seeds() {
  const { data, pool, tx, busy } = useApp();
  const share = data.staked && pool.paperStaked ? (data.staked / pool.paperStaked) * 100 : undefined;
  const ratio = pool.paperSupply ? ((pool.paperStaked ?? 0) / pool.paperSupply) * 100 : undefined;
  return (
    <div className="space-y-4">
    <SeedsCurve />
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
      <PaperPanel data={data} pool={pool} submit={tx.submit} busy={busy} />
      <div className="space-y-4">
        <Card title="Rewards">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Claimable" value={fmtUsd(data.pending)} />
            <Stat label="Your stake share" value={share !== undefined ? `${fmtNum(share, 2)}%` : "–"} />
            <Stat label="Total staker rewards" value={fmtUsd(pool.rewards?.[0])} />
            <Stat label="Rewards claimed (all)" value={fmtUsd(pool.rewards?.[1])} />
            <Stat label="Reward token" value="USDC" />
          </div>
        </Card>
        <Card title="SEEDS token">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Total supply" value={fmtNum(pool.paperSupply)} />
            <Stat label="Staked supply" value={fmtNum(pool.paperStaked)} />
            <Stat label="Stake ratio" value={ratio !== undefined ? `${fmtNum(ratio, 1)}%` : "–"} />
            <Stat label="Contract" value={shortAddr(MODULE_ADDR)} sub="non-transferable, minted on realized losses" />
          </div>
        </Card>
      </div>
    </div>
    </div>
  );
}
