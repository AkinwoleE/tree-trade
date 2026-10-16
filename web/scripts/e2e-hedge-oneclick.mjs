// Prod e2e for one-click hedging: fresh 0-APT account, all gas sponsored by /api/sponsor.
// Owner signatures: faucet + deposit (normal Tree Trade onboarding), 1-click trading, then ONE signature for hedging.
// After that the session key opens a hedged trade, the hedger opens the Decibel side, the session key closes,
// the hedger flattens; finally the owner withdraws the Decibel balance back to the wallet.
import { Account, Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "./lib/test-accounts.mjs";
trackTestAccounts(Account);
const BASE = process.env.BASE || "https://tree-trade-murex.vercel.app";
const M = process.env.MOD;
const D = "0xd368b820fdfbfe004679cdb0facef4b920c4fc0c2c80bd2fecf3843a93427bd1";
const HEDGER = process.env.HEDGER;
const USDC = "0x" + (await import("@aptos-labs/ts-sdk")).createObjectAddress((await import("@aptos-labs/ts-sdk")).AccountAddress.from(D), new TextEncoder().encode("USDC")).toStringLong().slice(2);
const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, clientConfig: { API_KEY: process.env.GEOMI_TESTNET_API_KEY } }));
const owner = Account.generate(), sess = Account.generate();
const O = owner.accountAddress.toStringLong();
const t0 = Date.now(); const ts = () => `+${((Date.now() - t0) / 1000).toFixed(0)}s`;
console.log("owner", O, "\nsession", sess.accountAddress.toStringLong());
let ownerSigs = 0;
async function run(label, who, fn, args, gas = 20000) {
  const tx = await aptos.transaction.build.simple({ sender: who.accountAddress, withFeePayer: true, data: { function: fn, functionArguments: args }, options: { maxGasAmount: gas } });
  const auth = aptos.transaction.sign({ signer: who, transaction: tx });
  if (who === owner) ownerSigs++;
  const r = await fetch(BASE + "/api/sponsor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction: tx.bcsToHex().toString(), senderAuthenticator: auth.bcsToHex().toString() }) });
  const j = await r.json();
  if (!j.hash) { console.log(ts(), label, "FAIL", r.status, j.error?.slice(0, 200)); process.exit(1); }
  const t = await aptos.waitForTransaction({ transactionHash: j.hash, options: { checkSuccess: false } });
  console.log(ts(), label, t.success ? "OK" : `ABORTED ${t.vm_status}`, j.hash, "gas", t.gas_used);
  if (!t.success) process.exit(1);
  return t;
}
const v = (f, a) => aptos.view({ payload: { function: f, functionArguments: a, typeArguments: f.startsWith("0x1::primary_fungible_store") ? ["0x1::fungible_asset::Metadata"] : [] } });
await run("owner faucet", owner, `${M}::test_usdc::faucet`, []);
await run("owner deposit", owner, `${M}::exchange::deposit`, ["200000000"]);
await run("owner enable 1-click", owner, `${M}::exchange::delegate_trading_to`, [sess.accountAddress.toStringLong(), Math.floor(Date.now() / 1000) + 3600]);
const before = ownerSigs;
// --- one-click hedging (what the Hedge toggle does) ---
const f = await fetch(BASE + "/api/hedge/fund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: O }) }).then((r) => r.json());
console.log(ts(), "fund (server, no signature)", JSON.stringify(f));
const bal = (await v("0x1::primary_fungible_store::balance", [O, USDC]))[0];
const sub = (await v(`${D}::dex_accounts::primary_subaccount`, [O]))[0];
const setup = await run("ENABLE HEDGING (1 signature)", owner, `${D}::dex_accounts_entry::add_delegated_trader_and_deposit_to_subaccount`, [sub, USDC, bal, HEDGER, Math.floor(Date.now() / 1000) + 30 * 86400], 60000);
console.log("  events:", setup.events.map((e) => e.type.split("::").slice(-1)[0]).join(", "));
console.log("  owner signatures for hedging:", ownerSigs - before, " Trading Account", sub, "collateral", (await v(`${D}::perp_engine::get_cross_total_collateral_value`, [sub]))[0]);
// --- session key opens a hedged trade (no owner signature) ---
await run("session open hedged BTC long 20x100", sess, `${M}::hedge::open_position_hedged_as_delegate`, [O, 0, true, "20000000", "100", sub]);
const ids = (await v(`${M}::exchange::user_positions`, [O]))[0];
const id = ids[ids.length - 1];
console.log("  position", id, "request", JSON.stringify(await v(`${M}::hedge::request_of`, [id])));
const mkt = "0x" + (await import("@aptos-labs/ts-sdk")).createObjectAddress((await import("@aptos-labs/ts-sdk")).createObjectAddress((await import("@aptos-labs/ts-sdk")).AccountAddress.from(D), new TextEncoder().encode("GlobalPerpEngine")), new (await import("@aptos-labs/ts-sdk")).MoveString("BTC/USD").bcsToBytes()).toStringLong().slice(2);
const pos = async () => { const p = (await v(`${D}::perp_engine::view_position`, [sub, mkt]))[0]?.vec?.[0]; return p ? (p.is_long ? "" : "-") + p.size : "0"; };
const waitFor = async (pred, label, ms = 180000) => { const end = Date.now() + ms; let p; while (Date.now() < end) { p = await pos(); if (pred(p)) { console.log(ts(), label, "Decibel BTC size", p); return true; } await new Promise((r) => setTimeout(r, 5000)); } console.log(ts(), label, "TIMEOUT, size", p); return false; };
if (!(await waitFor((p) => p.startsWith("-") && p !== "-0", "hedger opened short"))) process.exit(1);
await run("session close", sess, `${M}::exchange::close_position_as_delegate`, [O, id]);
if (!(await waitFor((p) => p === "0" || p === "-0", "hedger flattened"))) process.exit(1);
const coll = BigInt((await v(`${D}::perp_engine::get_cross_total_collateral_value`, [sub]))[0]);
const amt = (coll * 99n) / 100n / 1_000_000n * 1_000_000n;
await run(`owner withdraw back ${amt / 1_000_000n} USDC`, owner, `${D}::dex_accounts_entry::withdraw_from_cross_collateral`, [sub, USDC, amt.toString()]);
console.log(ts(), "wallet Decibel USDC", (await v("0x1::primary_fungible_store::balance", [O, USDC]))[0], "collateral left", (await v(`${D}::perp_engine::get_cross_total_collateral_value`, [sub]))[0]);
