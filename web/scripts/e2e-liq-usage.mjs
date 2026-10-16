// Prod check (2026-10-16 usage reduction): keeper still liquidates with local bust detection.
// Fresh sponsored account opens a 1000x BTC long and short; whichever side the price moves against must be liquidated.
import { Account, Aptos, AptosConfig, Network, Hex } from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "./lib/test-accounts.mjs";
trackTestAccounts(Account);
const BASE = process.env.BASE || "https://tree-trade-murex.vercel.app";
const M = process.env.MOD;
const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, fullnode: "https://fullnode.testnet.aptoslabs.com/v1" }));
const u = Account.generate(); const O = u.accountAddress.toStringLong(); console.log("fresh", O);
async function run(label, fn, args) {
  for (let a = 0; ; a++) {
    try { return await run1(label, fn, args); } catch (e) { if (a >= 8 || !/429/.test(String(e))) throw e; console.log(label, "429 from sponsor, retrying"); await new Promise((r) => setTimeout(r, 8000)); }
  }
}
async function run1(label, fn, args) {
  const tx = await aptos.transaction.build.simple({ sender: u.accountAddress, withFeePayer: true, data: { function: `${M}::${fn}`, functionArguments: args }, options: { maxGasAmount: 20000 } });
  const auth = aptos.transaction.sign({ signer: u, transaction: tx });
  const r = await fetch(BASE + "/api/sponsor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction: tx.bcsToHex().toString(), senderAuthenticator: auth.bcsToHex().toString() }) });
  const j = await r.json(); if (!j.hash) throw new Error(`${label}: ${r.status} ${String(j.error).slice(150, 600)}`);
  const t = await aptos.waitForTransaction({ transactionHash: j.hash, options: { checkSuccess: false } }); console.log(label, t.success ? "OK" : "ABORTED " + t.vm_status, j.hash); return t;
}
const psig = async (m) => { const j = await fetch(`${BASE}/api/price-sig?market=${m}`).then((r) => r.json()); return [j.price, j.publishTime, Hex.fromHexInput(j.signature).toUint8Array()]; };
const ids = async () => (await aptos.view({ payload: { function: `${M}::exchange::user_positions`, functionArguments: [O] } }))[0];
await run("faucet", "test_usdc::faucet", []);
await run("deposit 50", "exchange::deposit", ["50000000"]);
await run("open BTC long 10x1000", "exchange::open_position_px", [0, true, "10000000", "1000", ...(await psig(0))]);
await run("open BTC short 10x1000", "exchange::open_position_px", [0, false, "10000000", "1000", ...(await psig(0))]);
const opened = await ids(); console.log("open ids", opened, "at", new Date().toISOString());
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  const now = await ids();
  if (now.length < opened.length) { console.log("LIQUIDATED", opened.filter((x) => !now.includes(x)), "after", (i + 1) * 10, "s; still open", now); break; }
  if (i === 89) console.log("no liquidation within 15 min; open", now);
}
