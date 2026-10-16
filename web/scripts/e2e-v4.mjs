// Prod e2e for the 2026-10-15 audit fixes (V4): signed-price trading, session scopes + 7d expiry,
// legacy paths disabled, hedged 1-click with scope, gateway redeem ledger, hedge owner cap view.
import { Account, Aptos, AptosConfig, Network, AccountAddress, createObjectAddress, Hex } from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "./lib/test-accounts.mjs";
trackTestAccounts(Account);
const BASE = process.env.BASE || "https://tree-trade-murex.vercel.app";
const M = process.env.MOD;
const D = "0xd368b820fdfbfe004679cdb0facef4b920c4fc0c2c80bd2fecf3843a93427bd1";
const HEDGER = process.env.HEDGER;
const USDC = createObjectAddress(AccountAddress.from(D), new TextEncoder().encode("USDC")).toStringLong();
const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, clientConfig: { API_KEY: process.env.APTOS_API_KEY } }));
const owner = Account.generate(), sess = Account.generate(), sess2 = Account.generate();
const O = owner.accountAddress.toStringLong(), S = sess.accountAddress.toStringLong();
console.log("owner", O, "\nsession", S, "\nsession2", sess2.accountAddress.toStringLong());
let fails = 0;
async function run(label, who, fn, args, { expectFail = false, gas = 20000 } = {}) {
  const tx = await aptos.transaction.build.simple({ sender: who.accountAddress, withFeePayer: true, data: { function: fn.startsWith("0x") ? fn : `${M}::${fn}`, functionArguments: args }, options: { maxGasAmount: gas } });
  const auth = aptos.transaction.sign({ signer: who, transaction: tx });
  const r = await fetch(BASE + "/api/sponsor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction: tx.bcsToHex().toString(), senderAuthenticator: auth.bcsToHex().toString() }) });
  const j = await r.json();
  if (!j.hash) { const ok = expectFail; if (!ok) fails++; console.log(label, ok ? "REJECTED (expected)" : "FAIL", r.status, (j.error ?? "").slice(0, 200)); return null; }
  const t = await aptos.waitForTransaction({ transactionHash: j.hash, options: { checkSuccess: false } });
  const good = t.success !== expectFail; if (!good) fails++;
  console.log(label, t.success ? "OK" : `ABORTED ${t.vm_status}`, good ? "" : "!!! UNEXPECTED", j.hash);
  return t;
}
const view = (f, a) => aptos.view({ payload: { function: f.startsWith("0x") ? f : `${M}::${f}`, functionArguments: a } });
const psig = async (m) => { const j = await fetch(`${BASE}/api/price-sig?market=${m}`).then((r) => r.json()); return [j.price, j.publishTime, Hex.fromHexInput(j.signature).toUint8Array()]; };
const ids = async () => (await view("exchange::user_positions", [O]))[0];
const last = async () => { const i = await ids(); return i[i.length - 1]; };
const now = () => Math.floor(Date.now() / 1000);

console.log("v4_state", await view("exchange::v4_state", []), "guard", (await view("oracle::guard_params", [])).slice(1));
await run("faucet", owner, "test_usdc::faucet", []);
await run("deposit 200", owner, "exchange::deposit", ["200000000"]);
// legacy open disabled
await run("legacy open_position (must abort 36)", owner, "exchange::open_position", [0, true, "10000000", "100"], { expectFail: true });
// signed owner open/close
await run("open_position_px BTC long", owner, "exchange::open_position_px", [0, true, "10000000", "100", ...(await psig(0))]);
let id = await last();
await run(`close_position_px #${id}`, owner, "exchange::close_position_px", [id, ...(await psig(0))]);
// tampered price rejected
{ const [p, t, s] = await psig(1); await run("open_position_px tampered price (must abort)", owner, "exchange::open_position_px", [1, true, "10000000", "10", (BigInt(p) + 1n).toString(), t, s], { expectFail: true }); }
// 7-day max expiry
await run("delegate 8 days (must abort 20)", owner, "exchange::delegate_trading_with_scope", [S, now() + 8 * 86400, true, false], { expectFail: true });
await run("legacy never-expiring delegate (must abort 20)", owner, "exchange::delegate_trading_to", [S, null], { expectFail: true });
// 1-click with scope: hedge on, queue off
await run("enable 1-click (scope hedge=on queue=off, 7d)", owner, "exchange::delegate_trading_with_scope", [S, now() + 7 * 86400, true, false]);
console.log("scope_of", await view("exchange::scope_of", [O, S]));
await run("session open_position_as_delegate_px ETH short", sess, "exchange::open_position_as_delegate_px", [O, 1, false, "10000000", "100", ...(await psig(1))]);
id = await last();
await run(`session close_position_as_delegate_px #${id}`, sess, "exchange::close_position_as_delegate_px", [O, id, ...(await psig(1))]);
await run("session legacy open_position_as_delegate (must abort)", sess, "exchange::open_position_as_delegate", [O, 0, true, "10000000", "100"], { expectFail: true });
await run("session queue spend without scope (must abort 37)", sess, "exchange::open_position_from_queue_as_delegate_px", [O, 0, true, "10000000", "100", ...(await psig(0))], { expectFail: true });
await run("session withdraw (must fail)", sess, "exchange::withdraw", ["1000000"], { expectFail: true });
// session2 without hedge scope
await run("enable session2 (hedge=off)", owner, "exchange::delegate_trading_with_scope", [sess2.accountAddress.toStringLong(), now() + 3600, false, false]);
// hedging
if (HEDGER) {
  const f = await fetch(BASE + "/api/hedge/fund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: O }) }).then((r) => r.json());
  console.log("hedge fund", JSON.stringify(f));
  const bal = (await aptos.view({ payload: { function: "0x1::primary_fungible_store::balance", typeArguments: ["0x1::fungible_asset::Metadata"], functionArguments: [O, USDC] } }))[0];
  const sub = (await view(`${D}::dex_accounts::primary_subaccount`, [O]))[0];
  await run("ENABLE HEDGING", owner, `${D}::dex_accounts_entry::add_delegated_trader_and_deposit_to_subaccount`, [sub, USDC, bal, HEDGER, now() + 30 * 86400], { gas: 60000 });
  await run("session2 hedged open without scope (must abort 10)", sess2, "hedge::open_position_hedged_as_delegate_px", [O, 0, true, "20000000", "100", sub, ...(await psig(0))], { expectFail: true });
  await run("session hedged open BTC long 20x100 (px)", sess, "hedge::open_position_hedged_as_delegate_px", [O, 0, true, "20000000", "100", sub, ...(await psig(0))]);
  id = await last();
  console.log("request_of", JSON.stringify(await view("hedge::request_of", [id])), "owner_requests", await view("hedge::owner_requests", [O]));
  for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 5000)); const p = (await view(`${D}::perp_engine::view_position`, [sub, "0x0"]).catch(() => [null]))[0]; if (i === 11) break; }
  await new Promise((r) => setTimeout(r, 30000));
  await run(`session close hedged #${id} (px)`, sess, "exchange::close_position_as_delegate_px", [O, id, ...(await psig(0))]);
}
// gateway: faucet balance is not redeemable
console.log("redeemable_of(owner)", await view("usdc_gateway::redeemable_of", [O]), "total", await view("usdc_gateway::total_redeemable", []));
await run("withdraw 50", owner, "exchange::withdraw", ["50000000"]);
await run("unwrap faucet tUSDC (must abort)", owner, "usdc_gateway::unwrap", ["1000000"], { expectFail: true });
await run("revoke session", owner, "exchange::revoke_delegation", [S]);
await run("session open after revoke (must abort)", sess, "exchange::open_position_as_delegate_px", [O, 0, true, "10000000", "100", ...(await psig(0))], { expectFail: true });
console.log("DONE, unexpected results:", fails);
process.exit(fails ? 1 : 0);
