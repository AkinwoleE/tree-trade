import { Account, Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "../../../web/scripts/lib/test-accounts.mjs";
trackTestAccounts(Account);
import { loadKeeperAccount } from "../signer";
const M = "0xadb693b4ae831f1cfcb9b1eb10e5ca8e7875c013e9cd1ed5c587720c4f84d3e9";
const SITE = "https://tree-trade-murex.vercel.app";
const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, clientConfig: { API_KEY: process.env.GEOMI_TESTNET_API_KEY } }));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const view = async (f: string, args: any[] = []) => aptos.view({ payload: { function: `${M}::${f}` as any, functionArguments: args } });
async function send(acct: Account, f: string, args: any[]) {
  const tx = await aptos.transaction.build.simple({ sender: acct.accountAddress, withFeePayer: true, data: { function: `${M}::${f}` as any, functionArguments: args }, options: { maxGasAmount: 20000, gasUnitPrice: 100 } });
  const auth = aptos.transaction.sign({ signer: acct, transaction: tx });
  const r = await fetch(`${SITE}/api/sponsor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction: tx.bcsToHex().toString(), senderAuthenticator: auth.bcsToHex().toString() }) });
  const j: any = await r.json();
  if (!j.hash) return { success: false, vm_status: JSON.stringify(j), hash: "-" } as any;
  return (await aptos.waitForTransaction({ transactionHash: j.hash, options: { checkSuccess: false } })) as any;
}
const U = 1e6;
const a = Account.generate(), b = Account.generate(), c = Account.generate();
for (const x of [a, b, c]) { await send(x, "test_usdc::faucet", []); await send(x, "exchange::deposit", [10_000 * U]); }
// 1) under-$1K
let r = await send(a, "exchange::open_position", [0, true, 10 * U, 99]);
log(`$990 open: success=${r.success} status=${r.vm_status} tx=${r.hash}`);
r = await send(a, "exchange::open_position", [0, true, 10 * U, 100]);
log(`$1,000 open: success=${r.success} tx=${r.hash}`);
r = await send(a, "exchange::open_position", [0, true, 10_001 * U - 10 * U, 1000]);
log(`$10.0M-size check (9,991 x 1000 = $9.991M): success=${r.success} tx=${r.hash}`);
// 2) over-cap: keeper briefly sets ETH short cap = OI + ~$500
const keeper = loadKeeperAccount().account!;
const [, sq, lc] = (await view("exchange::side_oi", [1])).map((x) => BigInt(String(x)));
const px = Number((await view("oracle::price_info", [1]))[0]) / 1e8;
const tiny = sq + BigInt(Math.round((500 / px) * 1e8));
const t = await aptos.signAndSubmitTransaction({ signer: keeper, transaction: await aptos.transaction.build.simple({ sender: keeper.accountAddress, data: { function: `${M}::exchange::set_side_caps`, functionArguments: [1, lc, tiny] } }) });
await aptos.waitForTransaction({ transactionHash: t.hash });
log(`ETH short cap -> ${tiny} (OI ${sq} + ~$500) tx=${t.hash}`);
r = await send(b, "exchange::open_position", [1, false, 10 * U, 100]);
log(`$1,000 ETH short over cap: success=${r.success} status=${r.vm_status} tx=${r.hash}`);
r = await send(b, "exchange::open_position", [1, true, 10 * U, 100]);
log(`$1,000 ETH long (other side unaffected): success=${r.success} tx=${r.hash}`);
// 3) bust near zero equity: 1000x long + short
const ids: string[] = [];
for (const isLong of [true, false]) {
  const o = await send(c, "exchange::open_position", [0, isLong, 10 * U, 1000]);
  const ev = o.events.find((e: any) => e.type.endsWith("PositionOpened")).data; ids.push(ev.id);
  const lp = (await view("exchange::liquidation_price", [ev.id]))[0];
  const e = Number(ev.entry_price);
  log(`1000x ${isLong ? "long" : "short"} #${ev.id} entry=${e / 1e8} bust=${Number(lp) / 1e8} (${((Math.abs(Number(lp) - e) / e) * 100).toFixed(4)}% vs zero-equity 0.1000%) tx=${o.hash}`);
}
for (let i = 0; i < 600; i++) {
  for (const id of ids) {
    if (!(await view("exchange::position_exists", [id]))[0]) { log(`position #${id} liquidated`); process.exit(0); }
  }
  await new Promise((s) => setTimeout(s, 3000));
}
log("no liquidation within 30 min");
