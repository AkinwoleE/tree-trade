// Signed price for one trade (AUDIT decision 2). The chain verifies this ed25519 signature
// (oracle::verified_price) and rejects it after a few seconds, so every open/close executes at a
// fresh price instead of the last keeper push. The signing key is a dedicated price-signer key,
// not the admin or keeper key.
import { NextRequest, NextResponse } from "next/server";
import { Ed25519PrivateKey, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";
import { priceMessage } from "@/lib/price-sig";
import { defaultMedianSource } from "@/lib/prices";
import { sigDeviationOk } from "@/lib/price-guard";
import { view } from "@/lib/chain";
import { decibelApiKey, siteApiKey } from "@/lib/api-keys";
import { MARKETS, MARKET_SYMBOLS, PRICE_DECIMALS, fn } from "@/config/contract";
import { toUnits } from "@/lib/positions";
import { clientIp, rateLimited } from "@/lib/server-sponsor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const key = decibelApiKey() || siteApiKey();
// Deviation-checked median of independent sources, shared with the keeper (ORACLE_RISK.md fix 1).
const source = defaultMedianSource({ decibelKey: key, pythKey: process.env.PYTH_API_KEY, pythBase: process.env.PYTH_HERMES_URL });

// Share one median fetch across concurrent/rapid requests (keeps upstream calls low; still <=1.5s old).
let quoteMemo: { at: number; p: ReturnType<typeof source.fetch> } | undefined;
function medianQuote() {
  if (!quoteMemo || Date.now() - quoteMemo.at > 1_500) {
    const p = source.fetch();
    quoteMemo = { at: Date.now(), p };
    p.catch(() => { if (quoteMemo?.p === p) quoteMemo = undefined; });
  }
  return quoteMemo.p;
}

// Keyed view first; if the key is blocked/rate-limited, the anonymous public fullnode.
async function viewPriceInfo(market: number): Promise<[string, string]> {
  try {
    return (await view("oracle::price_info", [market])) as [string, string];
  } catch {
    const res = await fetch(`${process.env.APTOS_FULLNODE || "https://fullnode.testnet.aptoslabs.com/v1"}/view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ function: fn("oracle::price_info"), type_arguments: [], arguments: [market] }),
    });
    if (!res.ok) throw new Error(`price_info HTTP ${res.status}`);
    return (await res.json()) as [string, string];
  }
}

// On-chain stored price per market, cached briefly to save fullnode calls (fix 2).
const chainCache = new Map<number, { price: number; publishTime: number; at: number }>();
async function onchainPrice(market: number) {
  const c = chainCache.get(market);
  if (c && Date.now() - c.at < 3_000) return c;
  try {
    const [price, publishTime] = await viewPriceInfo(market);
    const v = { price: Number(price) / 10 ** PRICE_DECIMALS, publishTime: Number(publishTime), at: Date.now() };
    chainCache.set(market, v);
    return v;
  } catch (e) {
    if (c && Date.now() - c.at < 30_000) return c; // brief fullnode hiccup: last good read
    throw e;
  }
}
let signer: Ed25519PrivateKey | null = null;
function getSigner() {
  if (!signer && process.env.PRICE_SIGNER_KEY)
    signer = new Ed25519PrivateKey(PrivateKey.formatPrivateKey(process.env.PRICE_SIGNER_KEY.trim(), PrivateKeyVariants.Ed25519));
  return signer;
}

export async function GET(req: NextRequest) {
  const sk = getSigner();
  if (!sk) return NextResponse.json({ error: "price signer not configured" }, { status: 503 });
  const ip = clientIp(req);
  if (rateLimited(`psig:${ip}`, 120, 60_000) || rateLimited("psig:global", 3000, 60_000))
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  const market = Number(req.nextUrl.searchParams.get("market"));
  const sym = MARKET_SYMBOLS.find((s) => MARKETS[s] === market);
  if (!sym) return NextResponse.json({ error: "bad market" }, { status: 400 });
  try {
    const q = await medianQuote();
    const px = q.prices[sym];
    if (!px || !Number.isFinite(px) || px <= 0) throw new Error("no price");
    let chain;
    try {
      chain = await onchainPrice(market);
    } catch {
      return NextResponse.json({ error: "on-chain price unavailable" }, { status: 503 });
    }
    const chk = sigDeviationOk(px, chain.price, Date.now() / 1000 - chain.publishTime);
    if (!chk.ok)
      return NextResponse.json(
        { error: "price deviates from on-chain oracle", devBps: Math.round(chk.devBps), allowedBps: chk.allowedBps },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    const price = toUnits(px, PRICE_DECIMALS);
    // A second behind wall clock so it is never ahead of the ledger clock.
    const publishTime = BigInt(Math.floor(Date.now() / 1000) - 1);
    const sig = sk.sign(priceMessage(market, price, publishTime)).toString();
    return NextResponse.json({ market, price: price.toString(), publishTime: publishTime.toString(), signature: sig }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "price feed unavailable" }, { status: 503 });
  }
}
