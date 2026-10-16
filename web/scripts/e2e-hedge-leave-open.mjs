// Open a hedged BTC long (10x / $10k) and leave it open for UI screenshots.
import { Account, Aptos, AptosConfig, Network, createObjectAddress, AccountAddress, MoveString, Hex } from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "./lib/test-accounts.mjs";
trackTestAccounts(Account);
const BASE = process.env.BASE || "https://tree-trade-murex.vercel.app";
const M = process.env.MOD || process.env.NEXT_PUBLIC_MODULE_ADDR || process.env.MODULE_ADDR;
const HEDGER = process.env.HEDGER || process.env.NEXT_PUBLIC_HEDGER_ADDR;
const D = "0xd368b820fdfbfe004679cdb0facef4b920c4fc0c2c80bd2fecf3843a93427bd1";
const USDC = createObjectAddress(AccountAddress.from(D), new TextEncoder().encode("USDC")).toStringLong();
const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, clientConfig: { API_KEY: process.env.GEOMI_TESTNET_API_KEY || process.env.APTOS_API_KEY } }));
const owner = Account.generate(), sess = Account.generate();
const O = owner.accountAddress.toStringLong();
const t0 = Date.now(); const ts = () => `+${((Date.now() - t0) / 1000).toFixed(0)}s`;
console.log("owner", O);
console.log("session", sess.accountAddress.toStringLong());
async function run(label, who, fn, args, gas = 20000) {
  const full = fn.startsWith("0x") ? fn : `${M}::${fn}`;
  const tx = await aptos.transaction.build.simple({ sender: who.accountAddress, withFeePayer: true, data: { function: full, functionArguments: args }, options: { maxGasAmount: gas } });
  const auth = aptos.transaction.sign({ signer: who, transaction: tx });
  const r = await fetch(BASE + "/api/sponsor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction: tx.bcsToHex().toString(), senderAuthenticator: auth.bcsToHex().toString() }) });
  const j = await r.json();
  if (!j.hash) { console.log(ts(), label, "FAIL", r.status, (j.error ?? JSON.stringify(j)).slice(0, 300)); process.exit(1); }
  const t = await aptos.waitForTransaction({ transactionHash: j.hash, options: { checkSuccess: false } });
  console.log(ts(), label, t.success ? "OK" : `ABORTED ${t.vm_status}`, j.hash);
  if (!t.success) process.exit(1);
  return t;
}
const view = (f, a) => aptos.view({ payload: { function: f.startsWith("0x") ? f : `${M}::${f}`, functionArguments: a } });
const psig = async (m) => {
  const j = await fetch(`${BASE}/api/price-sig?market=${m}`).then((r) => r.json());
  if (!j.signature) throw new Error("price-sig failed: " + JSON.stringify(j));
  return [j.price, j.publishTime, Hex.fromHexInput(j.signature).toUint8Array()];
};
await run("faucet", owner, "test_usdc::faucet", []);
await run("deposit 2000", owner, "exchange::deposit", ["2000000000"]);
await run("1-click scoped", owner, "exchange::delegate_trading_with_scope", [sess.accountAddress.toStringLong(), Math.floor(Date.now() / 1000) + 7 * 86400, true, false]);
const f = await fetch(BASE + "/api/hedge/fund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: O }) }).then((r) => r.json());
console.log(ts(), "fund", JSON.stringify(f));
const bal = (await aptos.view({ payload: { function: "0x1::primary_fungible_store::balance", typeArguments: ["0x1::fungible_asset::Metadata"], functionArguments: [O, USDC] } }))[0];
const sub = (await view(`${D}::dex_accounts::primary_subaccount`, [O]))[0];
await run("enable hedging", owner, `${D}::dex_accounts_entry::add_delegated_trader_and_deposit_to_subaccount`, [sub, USDC, bal, HEDGER, Math.floor(Date.now() / 1000) + 30 * 86400], 60000);
await run("open hedged BTC 10x $10k", sess, "hedge::open_position_hedged_as_delegate_px", [O, 0, true, "1000000000", "10", sub, ...(await psig(0))]);
const ids = (await view("exchange::user_positions", [O]))[0];
const id = ids[ids.length - 1];
console.log("position", id, "request", JSON.stringify(await view("hedge::request_of", [id])));
const mkt = createObjectAddress(createObjectAddress(AccountAddress.from(D), new TextEncoder().encode("GlobalPerpEngine")), new MoveString("BTC/USD").bcsToBytes()).toStringLong();
const pos = async () => {
  const p = (await view(`${D}::perp_engine::view_position`, [sub, mkt]))[0]?.vec?.[0];
  return p ? (p.is_long ? "" : "-") + p.size : "0";
};
let p = "0";
const end = Date.now() + 180000;
while (Date.now() < end) {
  p = await pos();
  if (typeof p === "string" && p.startsWith("-") && p !== "-0") { console.log(ts(), "hedged", p); break; }
  console.log(ts(), "waiting hedge…", p);
  await new Promise((r) => setTimeout(r, 5000));
}
console.log("FINAL_OWNER", O);
console.log("FINAL_POSITION", id);
console.log("FINAL_DECIBEL_SIZE", p);
console.log("FINAL_SUB", sub);
