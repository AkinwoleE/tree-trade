// CCTP V2 relayer: once Circle's Iris attests a burn whose destination is Aptos (domain 9),
// submit Circle's receive_message script (receive_message -> prepare_mint -> handler::mint).
// destinationCaller is 0x0 so any caller may relay; USDC is minted to the mintRecipient in the
// signed burn message, never to us. Gas is paid by the sponsor account.
import { NextRequest, NextResponse } from "next/server";
import { Hex, MoveVector } from "@aptos-labs/ts-sdk";
import { clientIp, rateLimited, sponsorCtx } from "@/lib/server-sponsor";
import { APTOS_DOMAIN, IRIS_SANDBOX } from "@/lib/cctp/config";
import { RECEIVE_MESSAGE_V2_TESTNET_HEX } from "@/lib/cctp/receive-script";

export const runtime = "nodejs";
export const maxDuration = 30;
const SOURCE_DOMAINS = new Set([0, 3, 5, 6]);
/** Burns this instance already relayed: replays must not make the sponsor pay for an aborting tx (REVIEW W-5). */
const relayed = new Set<string>();

type IrisMsg = { message?: string; attestation?: string; status?: string; decodedMessage?: { destinationDomain?: string; decodedMessageBody?: { mintRecipient?: string; amount?: string } } };

export async function POST(req: NextRequest) {
  const { sourceDomain, txHash } = (await req.json().catch(() => ({}))) as { sourceDomain?: number; txHash?: string };
  if (!SOURCE_DOMAINS.has(Number(sourceDomain)) || !txHash || !/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{60,100})$/.test(txHash))
    return NextResponse.json({ error: "bad sourceDomain/txHash" }, { status: 400 });
  if (relayed.has(txHash.toLowerCase())) return NextResponse.json({ status: "already_minted" });
  if (rateLimited(`cctp:${txHash}`, 20, 60_000) || rateLimited(`cctp-ip:${clientIp(req)}`, 30, 60_000)) return NextResponse.json({ error: "rate limited" }, { status: 429 });
  const r = await fetch(`${IRIS_SANDBOX}/v2/messages/${sourceDomain}?transactionHash=${txHash}`, { cache: "no-store" });
  if (r.status === 404) return NextResponse.json({ status: "not_found_yet" });
  if (!r.ok) return NextResponse.json({ status: "iris_error", code: r.status });
  const data = (await r.json()) as { messages?: IrisMsg[] };
  const m = data.messages?.[0];
  if (!m || !m.message || !m.attestation || m.attestation === "PENDING" || m.status !== "complete")
    return NextResponse.json({ status: "pending_attestation", irisStatus: m?.status ?? null });
  const msgBytes = Hex.fromHexInput(m.message).toUint8Array();
  if (msgBytes.length < 12) return NextResponse.json({ error: "malformed message" }, { status: 400 });
  const destDomain = new DataView(msgBytes.buffer, msgBytes.byteOffset).getUint32(8);
  if (destDomain !== APTOS_DOMAIN) return NextResponse.json({ error: "message is not for Aptos" }, { status: 400 });
  const ctx = sponsorCtx();
  if (!ctx) return NextResponse.json({ status: "attested", message: m.message, attestation: m.attestation, relay: "disabled" });
  try {
    const transaction = await ctx.aptos.transaction.build.simple({
      sender: ctx.sponsor.accountAddress,
      data: {
        bytecode: Hex.fromHexInput(RECEIVE_MESSAGE_V2_TESTNET_HEX).toUint8Array(),
        functionArguments: [MoveVector.U8(msgBytes), MoveVector.U8(Hex.fromHexInput(m.attestation).toUint8Array())],
      },
      options: { maxGasAmount: 20_000 },
    });
    const pending = await ctx.aptos.signAndSubmitTransaction({ signer: ctx.sponsor, transaction });
    const done = await ctx.aptos.waitForTransaction({ transactionHash: pending.hash, options: { checkSuccess: false } });
    const ok = "success" in done ? done.success : false;
    const vm = "vm_status" in done ? String(done.vm_status) : "";
    // a reused nonce means someone (maybe us earlier) already relayed it: treat as minted
    if (ok || /nonce|already/i.test(vm)) relayed.add(txHash.toLowerCase());
    if (!ok && /nonce|already/i.test(vm)) return NextResponse.json({ status: "already_minted", vm });
    return NextResponse.json({ status: ok ? "minted" : "relay_failed", hash: pending.hash, vm, recipient: m.decodedMessage?.decodedMessageBody?.mintRecipient, amount: m.decodedMessage?.decodedMessageBody?.amount });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/nonce|already/i.test(msg)) return NextResponse.json({ status: "already_minted" });
    return NextResponse.json({ status: "relay_failed", error: msg.slice(0, 300) }, { status: 502 });
  }
}
