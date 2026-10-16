// Prod e2e for 1-click trading: owner signs once (delegate), session key trades, delegate withdraw fails, revoke works.
import { Account, Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "./lib/test-accounts.mjs";
trackTestAccounts(Account);
const BASE = process.env.BASE || "https://tree-trade-murex.vercel.app";
const M = process.env.MOD;
const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, clientConfig: { API_KEY: process.env.GEOMI_TESTNET_API_KEY } }));
const owner = Account.generate(), sess = Account.generate();
const O = owner.accountAddress.toStringLong();
console.log("owner", O, "\nsession", sess.accountAddress.toStringLong());
async function run(label, who, fn, args, expectFail = false) {
  const tx = await aptos.transaction.build.simple({ sender: who.accountAddress, withFeePayer: true, data: { function: `${M}::${fn}`, functionArguments: args }, options: { maxGasAmount: 20000 } });
  const auth = aptos.transaction.sign({ signer: who, transaction: tx });
  const r = await fetch(BASE + "/api/sponsor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction: tx.bcsToHex().toString(), senderAuthenticator: auth.bcsToHex().toString() }) });
  const j = await r.json();
  if (!j.hash) { console.log(label, expectFail ? "REJECTED (expected)" : "FAIL", r.status, j.error?.slice(0, 160)); return null; }
  const t = await aptos.waitForTransaction({ transactionHash: j.hash, options: { checkSuccess: false } });
  console.log(label, t.success ? "OK" : `ABORTED ${t.vm_status}`, expectFail ? (t.success ? "!!! UNEXPECTED" : "(expected)") : "", j.hash);
  return t;
}
const view = (f, a) => aptos.view({ payload: { function: `${M}::${f}`, functionArguments: a } });
const ids = async () => (await view("exchange::user_positions", [O]))[0];
const bal = async () => (await view("exchange::balance_of", [O]))[0];
await run("owner faucet", owner, "test_usdc::faucet", []);
await run("owner deposit", owner, "exchange::deposit", ["200000000"]);
await run("owner enable 1-click (delegate)", owner, "exchange::delegate_trading_to", [sess.accountAddress.toStringLong(), Math.floor(Date.now() / 1000) + 3600]);
console.log("delegation_of", await view("exchange::delegation_of", [O, sess.accountAddress.toStringLong()]));
for (const [m, long] of [[0, true], [1, false], [0, false]]) await run(`session open m${m} ${long ? "long" : "short"}`, sess, "exchange::open_position_as_delegate", [O, m, long, "10000000", "50"]);
console.log("owner positions", await ids(), "balance", await bal());
for (const id of await ids()) await run(`session close #${id}`, sess, "exchange::close_position_as_delegate", [O, id]);
console.log("owner positions", await ids(), "balance", await bal());
await run("session withdraw", sess, "exchange::withdraw", ["1000000"], true);
console.log("session's own balance", (await view("exchange::balance_of", [sess.accountAddress.toStringLong()]))[0]);
await run("owner revoke", owner, "exchange::revoke_delegation", [sess.accountAddress.toStringLong()]);
await run("session open after revoke", sess, "exchange::open_position_as_delegate", [O, 0, true, "10000000", "50"], true);
await run("owner withdraw", owner, "exchange::withdraw", ["1000000"]);
