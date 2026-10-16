// Prod check (2026-10-16 cost cuts 7-9): 3 fresh sponsored accounts in parallel run faucet -> deposit -> open (signed price)
// -> close (after 65 s so SEEDS rules apply), all through /api/sponsor (now retries 429s with backoff + jitter).
import { Account, Aptos, AptosConfig, Network, Hex } from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "./lib/test-accounts.mjs";
trackTestAccounts(Account);
const BASE = process.env.BASE || "https://tree-trade-murex.vercel.app";
const M = process.env.MOD;
const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, fullnode: "https://fullnode.testnet.aptoslabs.com/v1" }));
const stats = { ok: 0, fail: 0, retried: 0, sponsor429: 0 };
async function run(u, label, fn, args) {
  const tx = await aptos.transaction.build.simple({ sender: u.accountAddress, withFeePayer: true, data: { function: `${M}::${fn}`, functionArguments: args }, options: { maxGasAmount: 20000 } });
  const auth = aptos.transaction.sign({ signer: u, transaction: tx });
  const r = await fetch(BASE + "/api/sponsor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction: tx.bcsToHex().toString(), senderAuthenticator: auth.bcsToHex().toString() }) });
  const j = await r.json();
  if (j.retried) stats.retried += j.retried;
  if (r.status === 429) stats.sponsor429++;
  if (!j.hash) { stats.fail++; throw new Error(`${label}: ${r.status} ${j.error}`); }
  const t = await aptos.waitForTransaction({ transactionHash: j.hash, options: { checkSuccess: false } });
  t.success ? stats.ok++ : stats.fail++;
  console.log(u.accountAddress.toString().slice(0, 8), label, t.success ? "OK" : "ABORTED " + t.vm_status, j.hash, j.retried ? `(sponsor retried ${j.retried})` : "");
  return t;
}
const psig = async (m) => { const j = await fetch(`${BASE}/api/price-sig?market=${m}`).then((r) => r.json()); if (!j.signature) throw new Error("price-sig: " + JSON.stringify(j)); return [j.price, j.publishTime, Hex.fromHexInput(j.signature).toUint8Array()]; };
async function flow(i) {
  const u = Account.generate();
  const O = u.accountAddress.toStringLong();
  await run(u, "faucet", "test_usdc::faucet", []);
  await run(u, "deposit 50", "exchange::deposit", ["50000000"]);
  await run(u, "open 100x $1000", "exchange::open_position_px", [i % 2, i % 2 === 0, "10000000", "100", ...(await psig(i % 2))]);
  const [ids] = await aptos.view({ payload: { function: `${M}::exchange::user_positions`, functionArguments: [O] } });
  await new Promise((r) => setTimeout(r, 65_000));
  await run(u, `close #${ids[0]}`, "exchange::close_position_px", [ids[0], ...(await psig(i % 2))]);
  return O;
}
const res = await Promise.allSettled([0, 1, 2].map(flow));
res.forEach((r, i) => console.log("flow", i, r.status, r.status === "fulfilled" ? r.value : r.reason.message));
console.log("stats", JSON.stringify(stats));
