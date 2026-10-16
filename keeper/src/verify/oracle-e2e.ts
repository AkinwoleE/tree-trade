// ORACLE_RISK fixes 1/2/4 live check: fresh sponsored account opens + closes with /api/price-sig;
// simulates a keeper push 1% off (must abort E_PRICE_MOVE_TOO_LARGE under the tightened guard).
import "../env";
import { Account, Aptos, AptosConfig, Hex, Network } from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "../../../web/scripts/lib/test-accounts.mjs";
trackTestAccounts(Account);
import { loadKeeperAccount } from "../signer";
const M = "0xadb693b4ae831f1cfcb9b1eb10e5ca8e7875c013e9cd1ed5c587720c4f84d3e9";
const SITE = "https://tree-trade-murex.vercel.app";
const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, fullnode: "https://fullnode.testnet.aptoslabs.com/v1" }));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));
async function send(acct: Account, f: string, args: any[]) {
  const tx = await aptos.transaction.build.simple({ sender: acct.accountAddress, withFeePayer: true, data: { function: `${M}::${f}` as any, functionArguments: args }, options: { maxGasAmount: 20000, gasUnitPrice: 100 } });
  const auth = aptos.transaction.sign({ signer: acct, transaction: tx });
  const r = await fetch(`${SITE}/api/sponsor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction: tx.bcsToHex().toString(), senderAuthenticator: auth.bcsToHex().toString() }) });
  const j: any = await r.json();
  if (!j.hash) throw new Error(`${f}: sponsor ${JSON.stringify(j)}`);
  return (await aptos.waitForTransaction({ transactionHash: j.hash, options: { checkSuccess: false } })) as any;
}
async function sig(market: number) {
  const j: any = await (await fetch(`${SITE}/api/price-sig?market=${market}`)).json();
  if (!j.signature) throw new Error(`price-sig: ${JSON.stringify(j)}`);
  return j;
}
const U = 1e6;
const a = Account.generate();
log(`trader ${a.accountAddress}`);
let r = await send(a, "test_usdc::faucet", []); log(`faucet ${r.success}`);
r = await send(a, "exchange::deposit", [1_000 * U]); log(`deposit ${r.success} ${r.vm_status}`);
let s = await sig(0);
r = await send(a, "exchange::open_position_px", [0, true, 10 * U, 100, s.price, s.publishTime, Hex.fromHexInput(s.signature).toUint8Array()]);
const ev = r.events?.find((e: any) => e.type.endsWith("PositionOpened"))?.data;
log(`open BTC long $1,000 @ ${Number(s.price) / 1e8}: success=${r.success} ${r.vm_status} id=${ev?.id} tx=${r.hash}`);
await sleep(3000);
s = await sig(0);
r = await send(a, "exchange::close_position_px", [ev.id, s.price, s.publishTime, Hex.fromHexInput(s.signature).toUint8Array()]);
log(`close @ ${Number(s.price) / 1e8}: success=${r.success} ${r.vm_status} tx=${r.hash}`);
// Simulated far-off keeper push (no state change)
const keeper = loadKeeperAccount().account!;
const [p0] = await aptos.view({ payload: { function: `${M}::oracle::price_info`, functionArguments: [0] } });
const off = BigInt(String(p0)) * 101n / 100n;
const now = BigInt(Math.floor(Date.now() / 1000) - 2);
const tx = await aptos.transaction.build.simple({ sender: keeper.accountAddress, data: { function: `${M}::oracle::push_price`, functionArguments: [0, off, now] } });
const [sim] = await aptos.transaction.simulate.simple({ signerPublicKey: keeper.publicKey, transaction: tx });
log(`simulated keeper push +1%: success=${sim.success} ${sim.vm_status}`);
