/**
 * Decibel testnet probe: can a hedger service account trade a user's Trading Account (subaccount)
 * after the user delegates, using only the public fullnode (no Geomi key)?
 *
 *   npx tsx src/hedge/probe.ts            # full probe, results to stdout (tee to hedge-probe.log)
 *
 * Accounts are generated once into keeper/.hedge-probe.json (mode 600, gitignored). "owner" stands in for a
 * Tree Trade user (box-generated, testnet only); "hedger" is the service account. Each is funded with 0.3 APT
 * from the deployer profile when below 0.15 APT.
 */
import "../env";
import fs from "node:fs";
import path from "node:path";
import {
  Account,
  Aptos,
  AptosConfig,
  Ed25519PrivateKey,
  Network,
  type CommittedTransactionResponse,
  type InputEntryFunctionData,
} from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "../../../web/scripts/lib/test-accounts.mjs";
trackTestAccounts(Account);
import { DecibelWriteDex, TimeInForce, getMarketAddr } from "@decibeltrade/sdk";
import { decibelConfig } from "./decibel-config";
import { loadKeeperAccount } from "../signer";

const cfg = decibelConfig();
const PKG = cfg.deployment.package;
const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET, clientConfig: process.env.APTOS_API_KEY ? { API_KEY: process.env.APTOS_API_KEY } : undefined }));
const FILE = path.resolve(import.meta.dirname, "../../.hedge-probe.json");
/** ts-sdk v7 defaults max_gas_amount to 2,000,000 (2 APT reserved at 100 octas); v5 used 200,000. */
const MAX_GAS = 200_000;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const results: { step: string; ok: boolean; detail: string }[] = [];
const record = (step: string, ok: boolean, detail: string) => {
  results.push({ step, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
};

function loadAccounts(): { owner: Account; hedger: Account } {
  let saved: Record<string, string> = {};
  if (fs.existsSync(FILE)) saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const get = (k: string) => {
    if (!saved[k]) saved[k] = Account.generate().privateKey.toString();
    return Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(saved[k]) });
  };
  const out = { owner: get("owner"), hedger: get("hedger") };
  fs.writeFileSync(FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
  return out;
}

const view = async (fn: string, args: unknown[], typeArguments: string[] = []) =>
  aptos.view({ payload: { function: fn as `${string}::${string}::${string}`, typeArguments: typeArguments as never[], functionArguments: args as never[] } });

async function send(signer: Account, data: InputEntryFunctionData): Promise<CommittedTransactionResponse> {
  const txn = await aptos.transaction.build.simple({ sender: signer.accountAddress, data, options: { maxGasAmount: MAX_GAS } });
  const pending = await aptos.signAndSubmitTransaction({ signer, transaction: txn });
  return aptos.waitForTransaction({ transactionHash: pending.hash });
}

/** Simulate only: used for the negative tests so failures cost no gas. */
async function simulate(signer: Account, data: InputEntryFunctionData): Promise<{ ok: boolean; status: string }> {
  const txn = await aptos.transaction.build.simple({ sender: signer.accountAddress, data, options: { maxGasAmount: MAX_GAS } });
  const [r] = await aptos.transaction.simulate.simple({ signerPublicKey: signer.publicKey, transaction: txn });
  return { ok: r.success, status: r.vm_status };
}

async function fund(target: Account) {
  const bal = await aptos.getAccountAPTAmount({ accountAddress: target.accountAddress }).catch(() => 0);
  if (bal >= 15_000_000) return log(`${target.accountAddress} has ${bal / 1e8} APT`);
  const { account: deployer } = loadKeeperAccount();
  if (!deployer) throw new Error("no deployer key to fund probe accounts");
  for (let i = 0; i < 4; i++) {
    try {
      const txn = await aptos.transferCoinTransaction({ sender: deployer.accountAddress, recipient: target.accountAddress, amount: 30_000_000 });
      const p = await aptos.signAndSubmitTransaction({ signer: deployer, transaction: txn });
      await aptos.waitForTransaction({ transactionHash: p.hash });
      return log(`funded ${target.accountAddress} 0.3 APT tx=${p.hash}`);
    } catch (e) {
      log(`fund retry (${(e as Error).message.slice(0, 120)})`); // sequence-number race with the keeper
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error("funding failed");
}

const subaccountFromTx = (tx: CommittedTransactionResponse): string | undefined => {
  const ev = ("events" in tx ? tx.events : []).find((e) => e.type.endsWith("::dex_accounts::SubaccountCreatedEvent"));
  const d = ev?.data as Record<string, unknown> | undefined;
  return (d?.subaccount as string) ?? (d?.subaccount_address as string) ?? (d ? String(Object.values(d)[0]) : undefined);
};

async function main() {
  const { owner, hedger } = loadAccounts();
  log(`decibel package ${PKG}`);
  log(`owner  ${owner.accountAddress}`);
  log(`hedger ${hedger.accountAddress}`);
  await fund(owner);
  await fund(hedger);

  // No nodeApiKey on purpose: does the public fullnode accept SDK writes?
  // skipSimulate: with simulation the SDK reserves max(2x simulated max gas, 250k) units, which exceeds a
  // small APT balance; without it the SDK's own 250k default (0.25 APT reserved at 100 octas) is used.
  const ownerDex = new DecibelWriteDex(cfg, owner, { skipSimulate: true });
  const hedgerDex = new DecibelWriteDex(cfg, hedger, { skipSimulate: true });
  const btc = getMarketAddr("BTC/USD", cfg.deployment.perpEngineGlobal).toString();
  const eth = getMarketAddr("ETH/USD", cfg.deployment.perpEngineGlobal).toString();

  // 1. restricted_mint testnet USDC
  const usdcBal = async (a: Account) => Number((await view("0x1::primary_fungible_store::balance", [a.accountAddress.toString(), cfg.deployment.usdc], ["0x1::fungible_asset::Metadata"]).then((r) => r[0]).catch(() => 0)) as string);
  let bal = await usdcBal(owner);
  if (bal < 50_000_000 && !process.env.PROBE_SKIP_MINT) {
    const [avail] = await view(`${PKG}::usdc::available_restricted_mint_for`, [owner.accountAddress.toString()]);
    const amount = Math.min(Number(avail), 250_000_000);
    log(`restricted mint available: ${Number(avail) / 1e6} USDC; minting ${amount / 1e6}`);
    const tx = await send(owner, { function: `${PKG}::usdc::restricted_mint`, functionArguments: [amount] });
    bal = await usdcBal(owner);
    record("usdc::restricted_mint", tx.success, `tx=${tx.hash} balance=${bal / 1e6} USDC`);
  } else record("usdc::restricted_mint", true, `already funded: ${bal / 1e6} USDC`);

  // 2. dedicated (non-primary) Trading Account for hedges
  let saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  let sub: string | undefined = saved.subaccount;
  if (!sub) {
    const tx = await ownerDex.createSubaccount();
    sub = subaccountFromTx(tx);
    if (!sub) log("SubaccountCreatedEvent:", JSON.stringify("events" in tx ? tx.events : []).slice(0, 800));
    record("createSubaccount (SDK)", tx.success && !!sub, `tx=${tx.hash} subaccount=${sub}`);
    saved = { ...saved, subaccount: sub };
    fs.writeFileSync(FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
  } else record("createSubaccount (SDK)", true, `reusing ${sub}`);
  const [subOwner] = await view("0x1::object::owner", [sub]).catch(() => [undefined]);
  // object::owner is generic; fall back to reading ObjectCore.
  const core = await aptos.getAccountResource({ accountAddress: sub!, resourceType: "0x1::object::ObjectCore" }).catch(() => undefined);
  record("subaccount owned by owner (ObjectCore)", core?.owner === owner.accountAddress.toString(), `owner=${core?.owner ?? subOwner}`);

  // 3. deposit
  const collat = async () => Number((await view(`${PKG}::perp_engine::get_cross_total_collateral_value`, [sub]))[0]);
  if ((await collat()) < 20_000_000) {
    const tx = await ownerDex.deposit(50_000_000, sub);
    record("deposit 50 USDC (SDK)", tx.success, `tx=${tx.hash} collateral=${(await collat()) / 1e6}`);
  } else record("deposit (SDK)", true, `collateral already ${(await collat()) / 1e6}`);

  // 4. leverage / cross for BTC
  {
    const tx = await ownerDex.configureUserSettingsForMarket({ marketAddr: btc, subaccountAddr: sub!, isCross: true, userLeverage: 10 });
    record("configureUserSettingsForMarket BTC cross 10x (SDK)", tx.success, `tx=${tx.hash}`);
  }

  // 5. market-scoped delegation (not wrapped by SDK 0.8.2; ABI from dex_accounts_entry on chain)
  const expiry = Math.floor(Date.now() / 1000) + 7 * 86400;
  {
    const tx = await send(owner, {
      function: `${PKG}::dex_accounts_entry::delegate_perp_trading_to_market_for_subaccount`,
      functionArguments: [sub, hedger.accountAddress.toString(), btc, expiry],
    });
    record("delegate_perp_trading_to_market_for_subaccount(BTC, 7d)", tx.success, `tx=${tx.hash} vm=${tx.vm_status}`);
  }
  try {
    const [perms] = await view(`${PKG}::dex_accounts::view_delegated_permissions`, [sub]);
    record("view_delegated_permissions", true, JSON.stringify(perms).slice(0, 600));
  } catch (e) {
    record("view_delegated_permissions", false, (e as Error).message.slice(0, 200));
  }

  // 6. hedger places a BTC IOC sell (opens a short) on the owner's subaccount, fullnode only
  const [markRaw] = await view(`${PKG}::perp_engine::get_mark_price`, [btc]);
  const mark = Number(markRaw);
  const tick = Number((await view(`${PKG}::perp_engine::market_ticker_size`, [btc]))[0]);
  const size = 100_000; // 0.0001 BTC (sz_decimals 9), lot 10_000, min 20_000
  const sellPx = Math.floor((mark * 0.99) / tick) * tick;
  const posSize = async (m: string) => {
    const [s] = await view(`${PKG}::perp_engine::get_position_size`, [sub, m]);
    const [isLong] = await view(`${PKG}::perp_engine::get_position_is_long`, [sub, m]).catch(() => [true]);
    return { size: Number(s), isLong: isLong as boolean };
  };
  // Decibel matching is asynchronous: the order transaction only acknowledges; the fill lands a few seconds later.
  const settle = async (m: string, want: (s: number) => boolean) => {
    for (let i = 0; i < 15; i++) {
      const p = await posSize(m);
      if (want(p.size)) return p;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return posSize(m);
  };
  {
    const r = await hedgerDex.placeOrder({
      marketName: "BTC/USD", price: sellPx, size, isBuy: false, timeInForce: TimeInForce.ImmediateOrCancel,
      isReduceOnly: false, clientOrderId: "tt-probe-open", subaccountAddr: sub, tickSize: tick,
    });
    const p = await settle(btc, (s) => s > 0);
    record("hedger placeOrder BTC IOC sell on owner's subaccount (SDK, no Geomi key)", r.success, r.success ? `tx=${r.transactionHash} orderId=${r.orderId} position=${p.isLong ? "+" : "-"}${p.size}` : r.error);
  }

  // 7. negative: delegation is scoped to BTC, so ETH must fail
  {
    const [ethMark] = await view(`${PKG}::perp_engine::get_mark_price`, [eth]);
    const ethTick = Number((await view(`${PKG}::perp_engine::market_ticker_size`, [eth]))[0]);
    const s = await simulate(hedger, {
      function: `${PKG}::dex_accounts_entry::place_order_to_subaccount`,
      functionArguments: [sub, eth, Math.floor((Number(ethMark) * 0.99) / ethTick) * ethTick, 500_000, false, 2, false, null, null, null, null, null, null, null, null],
    });
    record("negative: hedger ETH order (not delegated) rejected", !s.ok, s.status);
  }
  // 8. negative: hedger cannot withdraw collateral
  {
    const s = await simulate(hedger, {
      function: `${PKG}::dex_accounts_entry::withdraw_from_cross_collateral`,
      functionArguments: [sub, cfg.deployment.usdc, 1_000_000],
    });
    record("negative: hedger withdraw rejected", !s.ok, s.status);
  }

  // 9. hedger closes with reduce-only IOC buy
  {
    const p = await posSize(btc);
    if (p.size > 0) {
      const buyPx = Math.ceil((mark * 1.01) / tick) * tick;
      const r = await hedgerDex.placeOrder({
        marketName: "BTC/USD", price: buyPx, size: p.size, isBuy: p.isLong ? false : true, timeInForce: TimeInForce.ImmediateOrCancel,
        isReduceOnly: true, clientOrderId: "tt-probe-close", subaccountAddr: sub, tickSize: tick,
      });
      const after = await settle(btc, (s) => s === 0);
      record("hedger reduce-only close", r.success && after.size === 0, r.success ? `tx=${r.transactionHash} position after=${after.size}` : r.error);
    } else record("hedger reduce-only close", false, "no position to close (open did not fill)");
  }

  // 10. revoke, then the hedger must be rejected
  {
    const tx = await ownerDex.revokeDelegation({ subaccountAddr: sub, accountToRevoke: hedger.accountAddress.toString() });
    record("revokeDelegation (SDK)", tx.success, `tx=${tx.hash}`);
    const s = await simulate(hedger, {
      function: `${PKG}::dex_accounts_entry::place_order_to_subaccount`,
      functionArguments: [sub, btc, sellPx, size, false, 2, false, null, null, null, null, null, null, null, null],
    });
    record("negative: hedger order after revoke rejected", !s.ok, s.status);
  }

  log("SUMMARY");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.step}  — ${r.detail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
