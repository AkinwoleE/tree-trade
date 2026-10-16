import { Account, Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "./lib/test-accounts.mjs";
trackTestAccounts(Account);
const BASE = process.env.BASE || "https://tree-trade-murex.vercel.app";
const M = process.env.MOD;
const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, clientConfig: { API_KEY: process.env.GEOMI_TESTNET_API_KEY } }));
const u = Account.generate(); console.log("fresh", u.accountAddress.toString());
const V = async (f, a = []) => aptos.view({ payload: { function: `${M}::${f}`, functionArguments: a } });
async function run(label, fn, args) {
  const tx = await aptos.transaction.build.simple({ sender: u.accountAddress, withFeePayer: true, data: { function: fn, functionArguments: args }, options: { maxGasAmount: 20000 } });
  const auth = aptos.transaction.sign({ signer: u, transaction: tx });
  const r = await fetch(BASE + "/api/sponsor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction: tx.bcsToHex().toString(), senderAuthenticator: auth.bcsToHex().toString() }) });
  const j = await r.json(); if (!j.hash) { console.log(label, "FAIL", r.status, j.error); return; }
  const t = await aptos.waitForTransaction({ transactionHash: j.hash }); console.log(label, t.success ? "OK" : "FAIL " + t.vm_status, j.hash); return t;
}
await run("faucet", `${M}::test_usdc::faucet`, []);
await run("deposit", `${M}::exchange::deposit`, ["100000000"]);
for (let i = 0; i < 6; i++) {
  const [lp, neg, rate] = await V("exchange::seeds_rate"); const [, , , hwm] = await V("tokenomics::params");
  const isLong = i % 2 === 0;
  await run("open " + (isLong ? "long" : "short"), `${M}::exchange::open_position`, [0, isLong, "10000000", "100"]);
  const ids = (await V("exchange::user_positions", [u.accountAddress.toString()]))[0];
  await new Promise((r) => setTimeout(r, 8000));
  const t = await run("close", `${M}::exchange::close_position`, [ids[ids.length - 1]]);
  const ev = t.events.find((e) => e.type.endsWith("::exchange::PositionClosed"));
  console.log(JSON.stringify(ev.data), "rate_before", rate, "lp", lp, neg, "hwm", hwm);
  if (!ev.data.is_profit && Number(ev.data.paper_minted) > 0) {
    const d = ev.data; const loss = BigInt(d.pnl ?? d.loss ?? 0);
    console.log("LOSS CLOSE: loss", loss, "fee", d.fee, "minted", d.paper_minted);
    console.log("seeds balance", (await V("paper::balance_of", [u.accountAddress.toString()]))[0]);
    break;
  }
}
