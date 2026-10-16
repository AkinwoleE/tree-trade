import { Account, Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "./lib/test-accounts.mjs";
trackTestAccounts(Account);
const BASE = process.env.BASE || "https://tree-trade-murex.vercel.app";
const M = process.env.MOD, D = "0xd368b820fdfbfe004679cdb0facef4b920c4fc0c2c80bd2fecf3843a93427bd1";
const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, clientConfig: { API_KEY: process.env.GEOMI_TESTNET_API_KEY } }));
const u = Account.generate(); console.log("fresh", u.accountAddress.toString());
async function run(label, fn, args) {
  const tx = await aptos.transaction.build.simple({ sender: u.accountAddress, withFeePayer: true, data: { function: fn, functionArguments: args }, options: { maxGasAmount: 20000 } });
  const auth = aptos.transaction.sign({ signer: u, transaction: tx });
  const r = await fetch(BASE + "/api/sponsor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction: tx.bcsToHex().toString(), senderAuthenticator: auth.bcsToHex().toString() }) });
  const j = await r.json(); if (!j.hash) { console.log(label, "FAIL", r.status, j.error); return; }
  const t = await aptos.waitForTransaction({ transactionHash: j.hash }); console.log(label, t.success ? "OK" : "FAIL " + t.vm_status, j.hash);
}
await run("faucet", `${M}::test_usdc::faucet`, []);
await run("deposit", `${M}::exchange::deposit`, ["100000000"]);
await run("open", `${M}::exchange::open_position`, [0, true, "10000000", "100"]);
await run("decibel mint", `${D}::usdc::restricted_mint`, ["100000000"]);
await run("decibel subaccount", `${D}::dex_accounts_entry::create_new_subaccount`, []);
