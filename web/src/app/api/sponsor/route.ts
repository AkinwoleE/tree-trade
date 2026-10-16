// Gas sponsorship for Tree Trade transactions (derived Phantom/MetaMask accounts start with 0 APT).
// The user signs the transaction themselves; we only add a fee-payer signature, and only for
// entry functions in our own package with bounded gas. We never see or hold user keys.
import { NextRequest, NextResponse } from "next/server";
import { AccountAddress, AccountAuthenticator, Deserializer, Hex, SimpleTransaction, TransactionPayloadEntryFunction } from "@aptos-labs/ts-sdk";
import { clientIp, rateLimited, sponsorCtx } from "@/lib/server-sponsor";
import { MODULE_ADDR } from "@/config/contract";
import { DECIBEL_PACKAGE, DECIBEL_ENTRY } from "@/config/decibel";
import { generateUserTransactionHash } from "@aptos-labs/ts-sdk";
import { isRateLimited, retry429 } from "@/lib/retry";

export const runtime = "nodejs";
const norm = (a: string) => { try { return AccountAddress.from(a.trim()).toStringLong(); } catch { return ""; } };
const MODULE = norm(MODULE_ADDR);
const DECIBEL = norm(DECIBEL_PACKAGE);
// Decibel onboarding calls the Hedge panel makes (testnet USDC mint, trading account, deposit, delegation).
// Same pattern as Decibel's documented Geomi Gas Station: sponsor only an allowlist of entry functions.
const DECIBEL_ALLOWED = new Set<string>(Object.values(DECIBEL_ENTRY));
const ALLOWED_MODULES = new Set(["exchange", "test_usdc", "paper", "hedge", "usdc_gateway"]);
const MAX_GAS = 20_000n;
const MAX_PRICE = 200n;

export async function POST(req: NextRequest) {
  const ctx = sponsorCtx();
  if (!ctx) return NextResponse.json({ error: "sponsorship disabled" }, { status: 503 });
  let body: { transaction?: string; senderAuthenticator?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!body.transaction || !body.senderAuthenticator) return NextResponse.json({ error: "missing fields" }, { status: 400 });
  let tx: SimpleTransaction, auth: AccountAuthenticator;
  try {
    tx = SimpleTransaction.deserialize(new Deserializer(Hex.fromHexInput(body.transaction).toUint8Array()));
    auth = AccountAuthenticator.deserialize(new Deserializer(Hex.fromHexInput(body.senderAuthenticator).toUint8Array()));
  } catch { return NextResponse.json({ error: "undecodable transaction" }, { status: 400 }); }
  const raw = tx.rawTransaction;
  if (!tx.feePayerAddress) return NextResponse.json({ error: "not a fee-payer transaction" }, { status: 400 });
  if (!(raw.payload instanceof TransactionPayloadEntryFunction)) return NextResponse.json({ error: "only entry functions are sponsored" }, { status: 403 });
  const ef = raw.payload.entryFunction;
  const addr = ef.module_name.address.toStringLong().toLowerCase();
  const mod = ef.module_name.name.identifier;
  const ok = (addr === MODULE && ALLOWED_MODULES.has(mod)) || (addr === DECIBEL && DECIBEL_ALLOWED.has(`${mod}::${ef.function_name.identifier}`));
  if (!ok) return NextResponse.json({ error: `not sponsored: ${mod}` }, { status: 403 });
  const maxGas = `${mod}::${ef.function_name.identifier}` === DECIBEL_ENTRY.oneClickSetup ? 60_000n : MAX_GAS;
  if (raw.max_gas_amount > maxGas || raw.gas_unit_price > MAX_PRICE) return NextResponse.json({ error: "gas too high" }, { status: 403 });
  const sender = raw.sender.toStringLong();
  // Fresh accounts are free, so a per-sender limit alone does not stop gas draining (REVIEW_2026-10-15 W-1):
  // also limit per client IP and per instance, and refuse long-lived signed transactions.
  if (raw.expiration_timestamp_secs > BigInt(Math.floor(Date.now() / 1000) + 600)) return NextResponse.json({ error: "expiration too far" }, { status: 403 });
  if (rateLimited(sender, 30, 60_000) || rateLimited(`ip:${clientIp(req)}`, 60, 60_000) || rateLimited("global", 600, 60_000))
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  try {
    tx.feePayerAddress = ctx.sponsor.accountAddress;
    const feePayerAuthenticator = ctx.aptos.transaction.signAsFeePayer({ signer: ctx.sponsor, transaction: tx });
    // The anonymous public fullnode limit is shared by every Vercel instance, so a burst can 429. Resubmitting the same
    // signed transaction is idempotent; if an earlier attempt actually landed, the node answers "already in mempool" /
    // "sequence number too old" and we return the transaction's own hash.
    const input = { transaction: tx, senderAuthenticator: auth, feePayerAuthenticator };
    let retried = 0;
    const hash = await retry429(
      async (attempt) => {
        try {
          return (await ctx.aptos.transaction.submit.simple(input)).hash;
        } catch (e) {
          if (attempt > 0 && /already|SEQUENCE_NUMBER_TOO_OLD/i.test(String((e as Error)?.message))) return generateUserTransactionHash(input);
          throw e;
        }
      },
      { onRetry: () => void retried++ },
    );
    return NextResponse.json({ hash, function: `${mod}::${ef.function_name.identifier}`, ...(retried ? { retried } : {}) });
  } catch (e) {
    if (isRateLimited(e)) return NextResponse.json({ error: "network busy (rate limited), please retry" }, { status: 429, headers: { "retry-after": "2" } });
    return NextResponse.json({ error: e instanceof Error ? e.message.slice(0, 300) : "submit failed" }, { status: 502 });
  }
}

export async function GET() {
  const ctx = sponsorCtx();
  return NextResponse.json({ enabled: !!ctx, sponsor: ctx?.sponsor.accountAddress.toString() ?? null });
}
