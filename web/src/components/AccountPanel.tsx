"use client";

import { ENTRY, USDC_DECIMALS } from "@/config/contract";
import type { AccountData, Submit } from "@/lib/hooks";
import { toUnits } from "@/lib/positions";
import { fmtUsd } from "@/lib/format";
import { AmountForm, Card, Stat } from "./ui";

const fmtCooldown = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.ceil((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};


export function AccountPanel({
  data,
  faucetAmount,
  submit,
  busy,
}: {
  data: AccountData;
  faucetAmount?: number;
  submit: Submit;
  busy: boolean;
}) {
  const cooldown = data.faucetCooldown ?? 0;
  return (
    <Card
      title="Account"
      right={
        <button
          className="btn btn-ghost"
          disabled={busy || cooldown > 0}
          title={cooldown > 0 ? `Faucet available again in ${fmtCooldown(cooldown)}` : undefined}
          onClick={() => submit("Faucet", ENTRY.faucet, [])}
        >
          {cooldown > 0
            ? `Faucet in ${fmtCooldown(cooldown)}`
            : `Faucet ${faucetAmount ? faucetAmount.toLocaleString() + " " : ""}tUSDC`}
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Wallet tUSDC" value={fmtUsd(data.usdc)} />
        <Stat label="Exchange balance" value={fmtUsd(data.collateral)} />
      </div>
      <AmountForm
        placeholder="USDC amount"
        max={data.usdc}
        disabled={busy}
        actions={[{ label: "Deposit", primary: true, onClick: (a) => submit("Deposit", ENTRY.deposit, [toUnits(a, USDC_DECIMALS)]) }]}
      />
      <AmountForm
        placeholder="USDC amount"
        max={data.collateral}
        disabled={busy}
        actions={[{ label: "Withdraw", onClick: (a) => submit("Withdraw", ENTRY.withdraw, [toUnits(a, USDC_DECIMALS)]) }]}
      />
    </Card>
  );
}
