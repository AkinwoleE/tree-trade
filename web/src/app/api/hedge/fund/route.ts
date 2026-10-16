// One-click hedging, testnet funding step: mints Decibel testnet USDC into the user's wallet so their single
// setup signature (dex_accounts_entry::add_delegated_trader_and_deposit_to_subaccount) has collateral to deposit.
// Decibel's testnet `usdc::mint` is public while `is_public_minting_allowed()` is true (checked below).
// Mainnet: this route does not exist; collateral is the user's real USDC (see HEDGE_DESIGN.md §10).
import { NextRequest, NextResponse } from "next/server";
import { AccountAddress } from "@aptos-labs/ts-sdk";
import { clientIp, rateLimited, sponsorCtx } from "@/lib/server-sponsor";
import { DECIBEL_PACKAGE, DECIBEL_USDC } from "@/config/decibel";

export const runtime = "nodejs";
export const maxDuration = 30;
const USDC = 1_000_000n;
/** Per request; the setup deposits this amount. */
const FUND_AMOUNT = 1_000n * USDC;
/** Don't top up wallets / Trading Accounts that already hold plenty. */
const WALLET_CAP = 1_000n * USDC;
const ACCOUNT_CAP = 10_000n * USDC;

export async function POST(req: NextRequest) {
  const ctx = sponsorCtx();
  if (!ctx) return NextResponse.json({ error: "funding disabled" }, { status: 503 });
  let owner: string;
  try {
    owner = AccountAddress.from(String((await req.json()).owner)).toStringLong();
  } catch {
    return NextResponse.json({ error: "bad owner" }, { status: 400 });
  }
  if (rateLimited(`fund:${owner}`, 3, 3_600_000) || rateLimited(`fund-ip:${clientIp(req)}`, 5, 3_600_000) || rateLimited("fund-global", 100, 3_600_000)) return NextResponse.json({ error: "rate limited: try again in an hour" }, { status: 429 });
  // One in-flight mint per owner, so concurrent requests can't each pass the balance cap (REVIEW W-9).
  if (inflight.has(owner)) return NextResponse.json({ error: "funding already in progress" }, { status: 409 });
  inflight.add(owner);
  try { return await fund(ctx, owner); } finally { inflight.delete(owner); }
}

const inflight = new Set<string>();
async function fund(ctx: NonNullable<ReturnType<typeof sponsorCtx>>, owner: string) {
  const { aptos, sponsor } = ctx;
  const v = (f: string, args: unknown[] = []) =>
    aptos.view({
      payload: {
        function: f as `${string}::${string}::${string}`,
        typeArguments: f.startsWith("0x1::primary_fungible_store") ? ["0x1::fungible_asset::Metadata"] : [],
        functionArguments: args as never[],
      },
    });
  try {
    const [[pub], [bal], [primary]] = await Promise.all([
      v(`${DECIBEL_PACKAGE}::usdc::is_public_minting_allowed`),
      v("0x1::primary_fungible_store::balance", [owner, DECIBEL_USDC]).catch(() => ["0"]),
      v(`${DECIBEL_PACKAGE}::dex_accounts::primary_subaccount`, [owner]),
    ]);
    if (pub !== true) return NextResponse.json({ error: "Decibel testnet minting is closed" }, { status: 503 });
    const coll = await v(`${DECIBEL_PACKAGE}::perp_engine::get_cross_total_collateral_value`, [primary]).then((r) => BigInt(String(r[0]))).catch(() => 0n);
    if (BigInt(String(bal)) >= WALLET_CAP) return NextResponse.json({ ok: true, skipped: "wallet already funded", amount: "0" });
    if (coll >= ACCOUNT_CAP) return NextResponse.json({ error: "hedge account already holds 10,000+ USDC" }, { status: 409 });
    const amount = FUND_AMOUNT - BigInt(String(bal));
    const tx = await aptos.transaction.build.simple({
      sender: sponsor.accountAddress,
      data: { function: `${DECIBEL_PACKAGE}::usdc::mint`, functionArguments: [owner, amount] },
      options: { maxGasAmount: 20_000 },
    });
    const pending = await aptos.signAndSubmitTransaction({ signer: sponsor, transaction: tx });
    const done = await aptos.waitForTransaction({ transactionHash: pending.hash });
    if (!("success" in done) || !done.success) return NextResponse.json({ error: `mint failed: ${"vm_status" in done ? done.vm_status : "?"}` }, { status: 502 });
    return NextResponse.json({ ok: true, hash: pending.hash, amount: amount.toString() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message.slice(0, 300) : "fund failed" }, { status: 502 });
  }
}
