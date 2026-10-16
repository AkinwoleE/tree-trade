import { Account, Aptos, AptosConfig, Network, Hex } from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "./lib/test-accounts.mjs";
trackTestAccounts(Account);
import { decodeTx } from "../src/lib/activity-decode";
const SITE = "https://tree-trade-murex.vercel.app";
const M = "0xadb693b4ae831f1cfcb9b1eb10e5ca8e7875c013e9cd1ed5c587720c4f84d3e9";
const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, clientConfig: { API_KEY: process.env.GEOMI_TESTNET_API_KEY } }));
const u = Account.generate();
async function run(f: string, args: any[]) {
  const tx = await aptos.transaction.build.simple({ sender: u.accountAddress, withFeePayer: true, data: { function: `${M}::${f}` as any, functionArguments: args }, options: { maxGasAmount: 20000 } });
  const a = aptos.transaction.sign({ signer: u, transaction: tx });
  const r = await fetch(`${SITE}/api/sponsor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction: Hex.fromHexInput(tx.bcsToBytes()).toString(), senderAuthenticator: Hex.fromHexInput(a.bcsToBytes()).toString() }) });
  const j: any = await r.json(); if (!j.hash) throw new Error(f + " " + JSON.stringify(j));
  const t: any = await aptos.waitForTransaction({ transactionHash: j.hash });
  console.log(f, t.success, j.hash); return t;
}
console.log("account", u.accountAddress.toString());
await run("test_usdc::faucet", []);
await run("exchange::deposit", ["100000000"]);
const o = await run("exchange::open_position", [0, true, "10000000", "10"]);
const id = decodeTx(o).opens[0].id;
const c = await run("exchange::close_position", [id]);
const t0 = Date.now();
const local = decodeTx(c).closes;
console.log("client-side row from confirmed tx (instant):", JSON.stringify(local[0]));
const me = u.accountAddress.toString().toLowerCase();
for (;;) {
  const j: any = await (await fetch(`${SITE}/api/activity`, { cache: "no-store" })).json();
  if (j.trades?.some((t: any) => t.owner.toLowerCase() === me)) { console.log("server /api/activity has it after", (Date.now() - t0) / 1000, "s"); break; }
  if (Date.now() - t0 > 120000) { console.log("server timeout"); break; }
  await new Promise((r) => setTimeout(r, 1000));
}
