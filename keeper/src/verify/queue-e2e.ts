// Prod verification of the Paper Trade LP/queue rules with fresh, gas-sponsored accounts.
// 3 longs + 3 shorts at 1000x (10k margin each). When one side's adjusted winnings exceed
// LP cash, close the winners (first paid, then partial+queue, then fully queued), then close
// the losers: their losses must pay the queue FIFO.
import { Account, Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "../../../web/scripts/lib/test-accounts.mjs";
trackTestAccounts(Account);
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
  if (!j.hash) throw new Error(`${f}: ${JSON.stringify(j)}`);
  const res: any = await aptos.waitForTransaction({ transactionHash: j.hash });
  if (!res.success) throw new Error(`${f} failed ${res.vm_status} ${j.hash}`);
  return res;
}
const ev = (res: any, name: string) => res.events.filter((e: any) => e.type.endsWith(`::exchange::${name}`)).map((e: any) => e.data);
const U = 1e6;
function adj(notional: number, e: number, x: number, pk = 814.598) {
  const g = Math.abs(x - e) - e / 50000; if (g <= 0) return 0;
  const mv = g / e; return notional * mv * 0.9 / (1 + 1 / (mv * 15000) + 1e5 / (1e6 * mv * pk));
}
const accts = Array.from({ length: 6 }, () => Account.generate());
const sides = [true, true, true, false, false, false];
const ids: string[] = [];
await Promise.all(accts.map(async (a, i) => {
  await send(a, "test_usdc::faucet", []);
  await send(a, "exchange::deposit", [10_000 * U]);
}));
for (let i = 0; i < 6; i++) {
  const r = await send(accts[i], "exchange::open_position", [0, sides[i], 10_000 * U, 1000]);
  const o = ev(r, "PositionOpened")[0]; ids.push(o.id);
  log(`open ${sides[i] ? "LONG " : "SHORT"} #${o.id} acct=${accts[i].accountAddress} entry=${o.entry_price} tx=${r.hash}`);
}
const entries = await Promise.all(ids.map(async (id) => Number((await view("exchange::get_position", [id]))[6])));
let winners: number[] = [], losers: number[] = [];
for (let t = 0; t < 1800; t++) {
  const px = Number((await view("oracle::price_info", [0]))[0]);
  const lp = Number((await view("exchange::pool_balance"))[0]) / U;
  const longAdj = [0, 1, 2].reduce((s, i) => s + (px > entries[i] ? adj(10_000_000, entries[i] / 1e8, px / 1e8) : 0), 0);
  const shortAdj = [3, 4, 5].reduce((s, i) => s + (px < entries[i] ? adj(10_000_000, entries[i] / 1e8, px / 1e8) : 0), 0);
  if (t % 10 === 0) log(`px=${px / 1e8} lp=${lp.toFixed(2)} longWin=${longAdj.toFixed(0)} shortWin=${shortAdj.toFixed(0)}`);
  if (longAdj * 0.98 > lp * 1.3 && longAdj / 3 > 300) { winners = [0, 1, 2]; losers = [3, 4, 5]; break; }
  if (shortAdj * 0.98 > lp * 1.3 && shortAdj / 3 > 300) { winners = [3, 4, 5]; losers = [0, 1, 2]; break; }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!winners.length) throw new Error("price never moved enough");
const qs = async () => (await view("exchange::queue_state")).map(String);
log("LP before winners", (await view("exchange::pool_balance"))[0], "queue", await qs());
for (const i of [...winners, ...losers]) {
  const r = await send(accts[i], "exchange::close_position", [ids[i]]);
  const c = ev(r, "PositionClosed")[0] ?? {};
  const qa = ev(r, "QueueEntryAdded"), qp = ev(r, "QueuePaid"), wi = ev(r, "WinImpact"), fd = ev(r, "FeesDistributed");
  log(`close #${ids[i]} ${c.is_profit ? "WIN " : "LOSS"} pnl=${c.pnl / U} fee=${c.fee / U} paid_now=${c.paid_now / U} queued=${c.queued / U} seeds=${c.paper_minted / U} impact=${JSON.stringify(wi)} queueAdded=${JSON.stringify(qa)} queuePaid=${JSON.stringify(qp)} fees=${JSON.stringify(fd)} tx=${r.hash}`);
  log("  LP", (await view("exchange::pool_balance"))[0], "queue", await qs(), "queued_balance_of", JSON.stringify(await view("exchange::queued_balance_of", [accts[i].accountAddress.toString()])));
}
for (const i of winners) log("winner", accts[i].accountAddress.toString(), "queued", JSON.stringify(await view("exchange::queued_balance_of", [accts[i].accountAddress.toString()])), "bal", (await view("exchange::balance_of", [accts[i].accountAddress.toString()]))[0]);
const [vault, b, m, pool, dev] = (await view("exchange::accounting")).map(Number);
log("invariant vault==b+m+pool+dev", vault === b + m + pool + dev, vault, b + m + pool + dev);
