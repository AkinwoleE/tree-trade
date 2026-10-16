/**
 * Live testnet E2E for hedging. Needs the keeper and the hedger (live mode) running.
 *
 *   npx tsx src/hedge/hedge-e2e.ts                 # all scenarios
 *   npx tsx src/hedge/hedge-e2e.ts --only open     # open|liq|nodelegation
 *
 * The "user" is the box-generated probe owner from keeper/.hedge-probe.json (run probe.ts first): it owns a
 * Decibel Trading Account. The script signs only as that user, exactly as the web app would through a wallet.
 *
 * Scenarios:
 *   open          hedged BTC long -> hedger opens the short on Decibel -> close -> hedger flattens + prunes
 *   liq           hedged BTC 1000x long + 1000x short (hedges net to ~0, no order) -> keeper liquidates one leg
 *                 -> hedger hedges the survivor -> close survivor -> flat + both requests pruned
 *   nodelegation  hedged ETH position without ETH delegation -> hedger reports not-delegated, places nothing
 */
import "../env";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Account, Aptos, AptosConfig, Ed25519PrivateKey, Network, type InputEntryFunctionData } from "@aptos-labs/ts-sdk";
import { getMarketAddr } from "@decibeltrade/sdk";
import { ENTRY, MARKETS, VIEW, fn } from "../../../web/src/config/contract";
import { targetSize } from "../../../web/src/lib/hedge";
import { decibelConfig } from "./decibel-config";
import { loadKeeperAccount } from "../signer";
import type { HedgeState } from "./sync";

const { values: flags } = parseArgs({ options: { only: { type: "string" } } });
const run = (name: string) => !flags.only || flags.only === name;

const cfg = decibelConfig();
const PKG = cfg.deployment.package;
const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, clientConfig: process.env.APTOS_API_KEY ? { API_KEY: process.env.APTOS_API_KEY } : undefined }));
const STATE = path.resolve(import.meta.dirname, "../../hedge-state.json");
/** The running hedger publishes its (public) address in its state file; the E2E never needs its key. */
const HEDGER: string = JSON.parse(fs.readFileSync(STATE, "utf8")).hedger;
const BTC = getMarketAddr("BTC/USD", cfg.deployment.perpEngineGlobal).toString();
const ETH = getMarketAddr("ETH/USD", cfg.deployment.perpEngineGlobal).toString();

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const results: [boolean, string, string][] = [];
const check = (ok: boolean, name: string, detail = "") => {
  results.push([ok, name, detail]);
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const probe = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../.hedge-probe.json"), "utf8"));
const user = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(probe.owner) });
const SUB: string = probe.subaccount;
const USER = user.accountAddress.toString();

const view = async (f: string, args: unknown[], typeArguments: string[] = []) =>
  aptos.view({ payload: { function: f as `${string}::${string}::${string}`, typeArguments: typeArguments as never[], functionArguments: args as never[] } });

async function send(signer: Account, data: InputEntryFunctionData, label: string): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      const txn = await aptos.transaction.build.simple({ sender: signer.accountAddress, data, options: { maxGasAmount: 200_000 } });
      const p = await aptos.signAndSubmitTransaction({ signer, transaction: txn });
      const r = await aptos.waitForTransaction({ transactionHash: p.hash });
      if (!r.success) throw new Error(`${label}: ${r.vm_status}`);
      log(`${label} tx=${p.hash}`);
      return p.hash;
    } catch (e) {
      const m = (e as Error).message;
      if (i >= 3 || !/429|SEQUENCE_NUMBER|mempool/.test(m)) throw e;
      await sleep(5000);
    }
  }
}

const state = (): HedgeState => JSON.parse(fs.readFileSync(STATE, "utf8"));
const decibelSize = async (market: string) => {
  const [opt] = (await view(`${PKG}::perp_engine::view_position`, [SUB, market])) as [{ vec: { size: string; is_long: boolean }[] }];
  const p = opt.vec[0];
  return p ? (p.is_long ? 1n : -1n) * BigInt(p.size) : 0n;
};
const requestExists = async (id: string) => (await view(fn(VIEW.hedgeRequestOf), [id]))[0] === true;
const positionExists = async (id: string) => (await view(fn(VIEW.positionExists), [id]))[0] === true;
const lastPositionId = async () => {
  const [ids] = (await view(fn(VIEW.userPositions), [USER])) as [string[]];
  return String(ids[ids.length - 1]);
};

/** Poll (local state file every 5 s, chain every `chainEvery`-th time) until `f` is truthy. */
async function until<T>(label: string, f: () => Promise<T | undefined | false>, timeoutMs = 180_000): Promise<T | undefined> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await f();
      if (v) return v as T;
    } catch (e) {
      log(`${label}: ${(e as Error).message.slice(0, 120)}`);
    }
    await sleep(10_000);
  }
  log(`timeout: ${label}`);
  return undefined;
}

async function setup() {
  log(`user ${USER}  trading account ${SUB}  hedger ${HEDGER}`);
  const apt = await aptos.getAccountAPTAmount({ accountAddress: USER });
  if (apt < 40_000_000) {
    const { account: deployer } = loadKeeperAccount();
    const txn = await aptos.transferCoinTransaction({ sender: deployer!.accountAddress, recipient: USER, amount: 40_000_000, options: { maxGasAmount: 20_000 } });
    const p = await aptos.signAndSubmitTransaction({ signer: deployer!, transaction: txn });
    await aptos.waitForTransaction({ transactionHash: p.hash });
    log(`funded user 0.4 APT tx=${p.hash}`);
  }
  // Tree Trade collateral.
  const [bal] = await view(fn(VIEW.tradingBalance), [USER]);
  if (Number(bal) < 100_000_000) {
    const [cool] = await view(fn(VIEW.faucetCooldown), [USER]);
    if (Number(cool) === 0) await send(user, { function: fn(ENTRY.faucet), functionArguments: [] }, "Tree Trade faucet");
    await send(user, { function: fn(ENTRY.deposit), functionArguments: [500_000_000] }, "Tree Trade deposit 500");
  }
  // Decibel collateral for a ~$10k hedge at 40x (~$250) plus fees.
  const [coll] = await view(`${PKG}::perp_engine::get_cross_total_collateral_value`, [SUB]);
  if (Number(coll) < 300_000_000) {
    const [w] = await view("0x1::primary_fungible_store::balance", [USER, cfg.deployment.usdc], ["0x1::fungible_asset::Metadata"]);
    const need = 320_000_000 - Number(coll);
    if (Number(w) < need) {
      // usdc::restricted_mint is once per account per day; fall back to the other box-generated probe account.
      const [avail] = await view(`${PKG}::usdc::available_restricted_mint_for`, [USER]);
      if (Number(avail) > 0) {
        await send(user, { function: `${PKG}::usdc::restricted_mint`, functionArguments: [Math.min(Number(avail), 500_000_000)] }, "Decibel restricted_mint");
      } else {
        const helper = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(probe.hedger) });
        const [ha] = await view(`${PKG}::usdc::available_restricted_mint_for`, [helper.accountAddress.toString()]);
        const amt = Math.min(Number(ha), 500_000_000);
        if (amt < need - Number(w)) throw new Error("not enough Decibel test USDC available today");
        await send(helper, { function: `${PKG}::usdc::restricted_mint`, functionArguments: [amt] }, "Decibel restricted_mint (helper)");
        await send(helper, { function: "0x1::primary_fungible_store::transfer", typeArguments: ["0x1::fungible_asset::Metadata"], functionArguments: [cfg.deployment.usdc, USER, amt] }, "transfer test USDC to user");
      }
    }
    await send(user, { function: `${PKG}::dex_accounts_entry::deposit_to_subaccount_at`, functionArguments: [SUB, cfg.deployment.usdc, need] }, `Decibel deposit ${need / 1e6}`);
  }
  // Settings cannot change while a position is open (ECANNOT_MODIFY_SETTINGS_WITH_OPEN_POSITION); 40x is already set then.
  if ((await decibelSize(BTC)) === 0n)
    await send(user, { function: `${PKG}::dex_accounts_entry::configure_user_settings_for_market`, functionArguments: [SUB, BTC, true, 40] }, "Decibel BTC cross 40x");
  // Consent: BTC only (ETH deliberately not delegated, for the nodelegation scenario), 1 day.
  await send(
    user,
    { function: `${PKG}::dex_accounts_entry::delegate_perp_trading_to_market_for_subaccount`, functionArguments: [SUB, HEDGER, BTC, Math.floor(Date.now() / 1000) + 86_400] },
    "delegate BTC perp trading to hedger (1 day)",
  );
}

async function expectedTarget(ids: string[]) {
  const ps = [];
  for (const id of ids) {
    const t = await view(fn(VIEW.getPosition), [id]);
    ps.push({ id, isLong: t[2] === true, notionalRaw: BigInt(t[5] as string), entryPriceRaw: BigInt(t[6] as string) });
  }
  const spec = { name: "BTC/USD", addr: BTC, szDecimals: 9, lotSize: 10_000n, minSize: 20_000n, tickSize: 1_000_000n, maxLeverage: 40 };
  return targetSize(ps, spec);
}

async function scenarioOpenClose() {
  log("=== scenario: open -> hedge -> close -> flatten + prune");
  const before = await decibelSize(BTC);
  check(before === 0n, "Decibel BTC flat before", String(before));
  await send(user, { function: fn(ENTRY.openPositionHedged), functionArguments: [MARKETS.BTC, true, 20_000_000, 10, SUB] }, "open_position_hedged BTC long 20 USDC 10x");
  const id = await lastPositionId();
  check(await requestExists(id), `hedge request recorded for #${id}`);
  const target = await expectedTarget([id]);
  const hedged = await until("hedge opened", async () => {
    const g = state().groups[`${SUB}|BTC/USD`];
    if (g?.status !== "in-sync") return false;
    return (await decibelSize(BTC)) === target ? g : false;
  });
  check(!!hedged, "hedger opened the opposite Decibel position", `target ${target} actual ${hedged?.actual} tx ${hedged?.lastTx}`);
  const ordersAfterOpen = state().seq;

  await sleep(20_000);
  check(state().seq === ordersAfterOpen, "no further orders while in sync (no double hedge)", `seq ${state().seq}`);

  await send(user, { function: fn(ENTRY.closePosition), functionArguments: [id] }, `close #${id}`);
  const flat = await until("hedge flattened and pruned", async () => ((await decibelSize(BTC)) === 0n && !(await requestExists(id)) ? true : false));
  check(!!flat, `hedger closed the Decibel side and pruned request #${id}`, `close tx ${state().groups[`${SUB}|BTC/USD`]?.lastTx ?? "(group removed)"}`);
}

async function scenarioLiquidation() {
  log("=== scenario: netted 1000x long+short -> liquidation of one leg -> hedge the survivor -> close");
  // Leftovers from an earlier run: close them and let the hedger settle first.
  const [left] = (await view(fn(VIEW.userPositions), [USER])) as [string[]];
  for (const id of left) await send(user, { function: fn(ENTRY.closePosition), functionArguments: [id] }, `cleanup: close #${id}`);
  if (left.length) await until("leftovers settled", async () => ((await decibelSize(BTC)) === 0n && !(await Promise.all(left.map(String).map(requestExists))).some(Boolean) ? true : false));
  await send(user, { function: fn(ENTRY.openPositionHedged), functionArguments: [MARKETS.BTC, true, 10_000_000, 1000, SUB] }, "open_position_hedged BTC long 10 USDC 1000x");
  const longId = await lastPositionId();
  await send(user, { function: fn(ENTRY.openPositionHedged), functionArguments: [MARKETS.BTC, false, 10_000_000, 1000, SUB] }, "open_position_hedged BTC short 10 USDC 1000x");
  const shortId = await lastPositionId();
  const net = await expectedTarget([longId, shortId]);
  // The legs can open at different oracle prices, so allow a residual below Decibel's min order size.
  check((net < 0n ? -net : net) < 20_000n, "hedges of the two legs net to below min size", String(net));
  const seq0 = state().seq;
  await sleep(35_000);
  check(state().seq === seq0 && (await decibelSize(BTC)) === 0n, "hedger placed no order for a netted-flat target", `seq ${state().seq}`);

  // The keeper should liquidate. liquidate() is permissionless, so if a leg stays liquidatable for two polls
  // (e.g. the keeper's transaction hit the shared IP rate limit) the test liquidates it itself. What is under
  // test here is the hedger's reaction to the position disappearing, whoever liquidates.
  let by = "keeper";
  const seen = new Map<string, number>();
  const gone = await until(
    "liquidation",
    async () => {
      for (const [id, other] of [[longId, shortId], [shortId, longId]]) {
        if (!(await positionExists(id))) return { dead: id, alive: other };
        const liq = (await view(fn(VIEW.isLiquidatable), [id]).catch(() => [false]))[0] === true;
        seen.set(id, liq ? (seen.get(id) ?? 0) + 1 : 0);
        if (liq && seen.get(id)! >= 2) {
          try {
            await send(user, { function: fn(ENTRY.liquidate), functionArguments: [id] }, `liquidate #${id} (test as liquidator)`);
            by = "test (keeper tx did not land)";
            return { dead: id, alive: other };
          } catch (e) {
            log(`self-liquidation of #${id} failed: ${(e as Error).message.slice(0, 120)}`);
          }
        }
      }
      return false;
    },
    900_000,
  );
  check(!!gone, "one 1000x leg liquidated", gone ? `#${gone.dead} by ${by}` : "");
  if (!gone) return;
  const target = await expectedTarget([gone.alive]);
  const hedged = await until("survivor hedged", async () => ((await decibelSize(BTC)) === target ? true : false));
  check(!!hedged, `hedger hedged the survivor #${gone.alive} after the liquidation`, `target ${target} tx ${state().groups[`${SUB}|BTC/USD`]?.lastTx}`);
  const pruned = await until("liquidated request pruned", async () => !(await requestExists(gone.dead)));
  check(!!pruned, `request of liquidated #${gone.dead} pruned`);

  if (await positionExists(gone.alive)) await send(user, { function: fn(ENTRY.closePosition), functionArguments: [gone.alive] }, `close survivor #${gone.alive}`);
  else log(`survivor #${gone.alive} was also liquidated`);
  const flat = await until("flat after survivor close", async () => ((await decibelSize(BTC)) === 0n && !(await requestExists(gone.alive)) ? true : false));
  check(!!flat, "Decibel side flat and all requests pruned");
}

async function scenarioNoDelegation() {
  log("=== scenario: ETH hedge without ETH delegation -> not-delegated, nothing placed");
  await send(user, { function: fn(ENTRY.openPositionHedged), functionArguments: [MARKETS.ETH, false, 10_000_000, 10, SUB] }, "open_position_hedged ETH short 10 USDC 10x");
  const id = await lastPositionId();
  const g = await until("not-delegated status", async () => {
    const x = state().groups[`${SUB}|ETH/USD`];
    return x?.status === "not-delegated" ? x : false;
  });
  check(!!g, "hedger reports not-delegated for ETH", g?.lastError);
  check(state().positions[id]?.status === "not-delegated", `position #${id} shows the hedge-failed state`);
  check((await decibelSize(ETH)) === 0n, "no ETH order was placed");
  await send(user, { function: fn(ENTRY.closePosition), functionArguments: [id] }, `close #${id}`);
  const pruned = await until("pruned", async () => !(await requestExists(id)));
  check(!!pruned, `request #${id} pruned after close (nothing to flatten)`);
}

async function main() {
  if (!state().mode || state().mode !== "live") throw new Error("hedger must be running in live mode");
  await setup();
  if (run("open")) await scenarioOpenClose();
  if (run("nodelegation")) await scenarioNoDelegation();
  if (run("liq")) await scenarioLiquidation();
  log("SUMMARY");
  for (const [ok, n, d] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`);
  console.log(`${results.filter((r) => r[0]).length}/${results.length} checks passed`);
  process.exit(results.every((r) => r[0]) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
