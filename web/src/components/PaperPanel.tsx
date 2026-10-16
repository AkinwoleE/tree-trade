"use client";

import { ENTRY, PAPER_DECIMALS } from "@/config/contract";
import type { AccountData, PoolData, Submit } from "@/lib/hooks";
import { toUnits } from "@/lib/positions";
import { fmtNum, fmtUsd } from "@/lib/format";
import { AmountForm, Card, Stat } from "./ui";

export function PaperPanel({
  data,
  pool,
  submit,
  busy,
}: {
  data: AccountData;
  pool: PoolData;
  submit: Submit;
  busy: boolean;
}) {
  const share = data.staked && pool.paperStaked ? (data.staked / pool.paperStaked) * 100 : undefined;
  return (
    <Card
      title="SEEDS staking"
      right={
        <button className="btn btn-primary" disabled={busy || !data.pending} onClick={() => submit("Claim", ENTRY.claim, [])}>
          Claim {data.pending ? fmtUsd(data.pending) : ""}
        </button>
      }
    >
      <div className="grid grid-cols-3 gap-4">
        <Stat label="SEEDS balance" value={fmtNum(data.paper, 4)} />
        <Stat label="Staked" value={fmtNum(data.staked, 4)} sub={share !== undefined ? `${share.toFixed(2)}% of pool` : undefined} />
        <Stat label="Claimable USDC" value={fmtUsd(data.pending)} />
      </div>
      <p className="text-xs text-zinc-500">
        SEEDS is non-transferable and minted on realized losses. Stake it to earn a share of the USDC rewards.
      </p>
      <AmountForm
        placeholder="SEEDS amount"
        max={data.paper}
        disabled={busy}
        actions={[{ label: "Stake", primary: true, onClick: (a) => submit("Stake", ENTRY.stake, [toUnits(a, PAPER_DECIMALS)]) }]}
      />
      <AmountForm
        placeholder="SEEDS amount"
        max={data.staked}
        disabled={busy}
        actions={[{ label: "Unstake", onClick: (a) => submit("Unstake", ENTRY.unstake, [toUnits(a, PAPER_DECIMALS)]) }]}
      />
    </Card>
  );
}
