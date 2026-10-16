/**
 * End-to-end test against the deployed testnet package. Requires the keeper to be running
 * (fresh oracle prices, liquidations).
 *
 *   npx tsx src/e2e.ts                 # full run
 *   npx tsx src/e2e.ts --skip-liq      # skip the 1000x liquidation scenario
 *   npx tsx src/e2e.ts --close <id>    # only close + verify an open position of the trader
 *
 * The trader account is generated once and stored in keeper/.e2e-trader.json (gitignored,
 * mode 600). It is funded with APT from the deployer (KEEPER_PRIVATE_KEY / profile) since
 * the testnet faucet needs a login.
 */
import "./env";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  Account,
  AccountAddress,
  Aptos,
  AptosConfig,
  Ed25519PrivateKey,
  Network,
  type InputEntryFunctionData,
  type UserTransactionResponse,
} from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "../../web/scripts/lib/test-accounts.mjs";
trackTestAccounts(Account);
import { ENTRY, MARKETS, MODULE_ADDR, VIEW, fn } from "../../web/src/config/contract";
import { loadKeeperAccount } from "./signer";

const { values: flags } = parseArgs({
  options: {
    "skip-liq": { type: "boolean", default: false },
    "liq-timeout": { type: "string", default: "900" },
    /** Only close (and verify) an existing open position of the trader, e.g. the ETH short left open. */
    close: { type: "string" },
  },
});

const TRADER_FILE = ".e2e-trader.json";
const USDC = 1_000_000n;
const FEE_BPS = 200n;
const BPS = 10_000n;
const BASE_MINT_RATE = 100n;
const DECAY_THRESHOLD = 2_000_000n * USDC;
const MIN_TRADER_APT = 20_000_000n; // 0.2 APT
const FUND_APT = 50_000_000n; // 0.5 APT

const aptos = new Aptos(
  new AptosConfig({
    network: Network.TESTNET,
    clientConfig: process.env.APTOS_API_KEY ? { API_KEY: process.env.APTOS_API_KEY } : undefined,
  }),
);

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (v: bigint) => `${v < 0n ? "-" : ""}${(Number(v < 0n ? -v : v) / 1e6).toFixed(6)}`;

let failures = 0;
const results: string[] = [];
function check(name: string, actual: unknown, expected: unknown) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  const line = `${ok ? "PASS" : "FAIL"} ${name}: actual=${actual} expected=${expected}`;
  results.push(line);
  log(line);
}

/* ------------------------------------------------------------------ */
/* Chain helpers                                                       */
/* ------------------------------------------------------------------ */

async function view(id: string, args: unknown[] = []): Promise<any[]> {
  return aptos.view({ payload: { function: fn(id), functionArguments: args as any } });
}

async function submit(signer: Account, data: InputEntryFunctionData, label: string): Promise<UserTransactionResponse> {
  // The deployer also signs keeper pushes, so retry submission on sequence-number races.
  // Only the submit step is retried: once accepted, a retry could execute the call twice.
  let hash: string;
  for (let attempt = 1; ; attempt++) {
    try {
      const txn = await aptos.transaction.build.simple({ sender: signer.accountAddress, data, options: { maxGasAmount: 200_000 } });
      hash = (await aptos.signAndSubmitTransaction({ signer, transaction: txn })).hash;
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < 4 && /SEQUENCE_NUMBER|mempool/i.test(msg)) {
        log(`${label}: retry ${attempt} (${msg.split("\n")[0].slice(0, 120)})`);
        await sleep(2000 * attempt);
        continue;
      }
      throw e;
    }
  }
  const res = (await aptos.waitForTransaction({ transactionHash: hash })) as UserTransactionResponse;
  if (!res.success) throw new Error(`${label} failed: ${res.vm_status} (${res.hash})`);
  log(`${label}: ${res.hash}`);
  txHashes.push(`${label}: ${res.hash}`);
  return res;
}
const txHashes: string[] = [];

function eventsOf(tx: UserTransactionResponse, name: string): any[] {
  return tx.events.filter((e) => e.type.endsWith(`::exchange::${name}`) || e.type.endsWith(`::paper::${name}`)).map((e) => e.data);
}

async function aptBalance(addr: AccountAddress): Promise<bigint> {
  return BigInt(await aptos.getAccountAPTAmount({ accountAddress: addr }));
}

/** Independent FA balance read via the framework (not the package's own view). */
async function faBalance(owner: string, metadata: string): Promise<bigint> {
  const [b] = await aptos.view({
    payload: {
      function: "0x1::primary_fungible_store::balance",
      typeArguments: ["0x1::fungible_asset::Metadata"],
      functionArguments: [owner, metadata],
    },
  });
  return BigInt(b as string);
}

interface Snap {
  vaultFa: bigint;
  totalBalances: bigint;
  totalMargin: bigint;
  pool: bigint;
  devFees: bigint;
  toStakers: bigint;
  toDev: bigint;
  rewardsDeposited: bigint;
  rewardsClaimed: bigint;
  rewardVaultFa: bigint;
  traderBalance: bigint;
  traderPaper: bigint;
  traderPending: bigint;
  paperSupply: bigint;
  totalStaked: bigint;
}

let usdcMeta = "";
let exchangeVault = "";
let rewardVault = "";

async function snapshot(trader: AccountAddress): Promise<Snap> {
  const [acc, fees, rewards, bal, paper, pending, supply, staked] = await Promise.all([
    view(VIEW.accounting),
    view(VIEW.feeStats),
    view(VIEW.rewardStats),
    view(VIEW.tradingBalance, [trader.toString()]),
    view(VIEW.paperBalance, [trader.toString()]),
    view(VIEW.pendingRewards, [trader.toString()]),
    view(VIEW.paperTotalSupply),
    view(VIEW.paperTotalStaked),
  ]);
  const [vaultFa, rewardVaultFa] = await Promise.all([faBalance(exchangeVault, usdcMeta), faBalance(rewardVault, usdcMeta)]);
  return {
    vaultFa,
    totalBalances: BigInt(acc[1]),
    totalMargin: BigInt(acc[2]),
    pool: BigInt(acc[3]),
    devFees: BigInt(acc[4]),
    toStakers: BigInt(fees[0]),
    toDev: BigInt(fees[1]),
    rewardsDeposited: BigInt(rewards[0]),
    rewardsClaimed: BigInt(rewards[1]),
    rewardVaultFa,
    traderBalance: BigInt(bal[0]),
    traderPaper: BigInt(paper[0]),
    traderPending: BigInt(pending[0]),
    paperSupply: BigInt(supply[0]),
    totalStaked: BigInt(staked[0]),
  };
}

function checkInvariants(s: Snap, tag: string) {
  check(`[${tag}] exchange vault FA == balances+margin+pool+dev`, s.vaultFa, s.totalBalances + s.totalMargin + s.pool + s.devFees);
  check(`[${tag}] reward vault FA == deposited-claimed`, s.rewardVaultFa, s.rewardsDeposited - s.rewardsClaimed);
}

const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);
const mintAmount = (loss: bigint, pool: bigint) => {
  let raw = loss * BASE_MINT_RATE;
  if (pool >= DECAY_THRESHOLD) raw = (raw * DECAY_THRESHOLD) / pool;
  return raw;
};

async function oraclePrice(market: number): Promise<{ price: bigint; time: bigint }> {
  const [p, t] = await view(VIEW.priceInfo, [market]);
  return { price: BigInt(p), time: BigInt(t) };
}

async function waitFresh(market: number) {
  for (let i = 0; i < 30; i++) {
    const [fresh] = await view("oracle::is_fresh", [market]);
    if (fresh) return;
    await sleep(2000);
  }
  throw new Error(`oracle market ${market} is stale — is the keeper running?`);
}

async function openPosition(trader: Account, market: number, isLong: boolean, margin: bigint, lev: number, label: string) {
  await waitFresh(market);
  const tx = await submit(trader, { function: fn(ENTRY.openPosition), functionArguments: [market, isLong, margin, lev] }, label);
  const ev = eventsOf(tx, "PositionOpened")[0];
  log(`  opened #${ev.id} ${isLong ? "LONG" : "SHORT"} market=${market} ${lev}x margin=${usd(margin)} entry=${ev.entry_price}`);
  return { id: String(ev.id), entry: BigInt(ev.entry_price), notional: BigInt(ev.notional), margin, isLong, market, tx: tx.hash };
}
type Opened = Awaited<ReturnType<typeof openPosition>>;

/** Wait until the oracle price for `market` differs from `entry` (keeper pushes every ~10s). */
async function waitForMove(market: number, entry: bigint, timeoutSecs = 300) {
  const until = Date.now() + timeoutSecs * 1000;
  while (Date.now() < until) {
    const { price } = await oraclePrice(market);
    if (price !== entry) return price;
    await sleep(3000);
  }
  throw new Error(`no oracle price movement on market ${market} in ${timeoutSecs}s`);
}

/** Close a position and verify every number against a recomputation from entry/exit and the views. */
async function closeAndVerify(trader: Account, p: Opened, tag: string) {
  const addr = trader.accountAddress;
  await waitFresh(p.market);
  const before = await snapshot(addr);
  const tx = await submit(trader, { function: fn(ENTRY.closePosition), functionArguments: [BigInt(p.id)] }, `close #${p.id} (${tag})`);
  const after = await snapshot(addr);
  const ev = eventsOf(tx, "PositionClosed")[0];
  const exit = BigInt(ev.exit_price);
  const isProfit = ev.is_profit === true;

  // Recompute PnL exactly as exchange::compute_pnl does.
  const diff = exit > p.entry ? exit - p.entry : p.entry - exit;
  const num = p.notional * diff;
  const floor = num / p.entry;
  const ceil = num % p.entry === 0n ? floor : floor + 1n;
  const up = exit > p.entry;
  const expectProfit = exit !== p.entry && up === p.isLong && floor > 0n;
  check(`[${tag}] is_profit`, isProfit, expectProfit);

  const staked = before.totalStaked > 0n;
  let fee: bigint, paidNow: bigint, paper: bigint, poolDelta: bigint;
  if (expectProfit) {
    fee = ceilDiv(floor * FEE_BPS, BPS);
    const net = floor - fee;
    paidNow = p.margin + net; // pool is large, queue empty
    paper = 0n;
    poolDelta = -(net + fee);
    check(`[${tag}] gross profit`, ev.pnl, floor);
  } else {
    const loss = ceil < p.margin ? ceil : p.margin;
    fee = (loss * FEE_BPS) / BPS;
    paidNow = p.margin - loss;
    paper = loss === 0n ? 0n : mintAmount(loss, before.pool);
    poolDelta = loss - fee;
    check(`[${tag}] loss`, ev.pnl, loss);
  }
  const toStakers = staked ? fee / 2n : 0n;
  const toDev = fee - toStakers;
  const feePct = Number(ev.pnl) > 0 ? ((Number(fee) / Number(ev.pnl)) * 100).toFixed(4) : "n/a";
  log(
    `  ${tag}: entry=${p.entry} exit=${exit} ${isProfit ? "PROFIT" : "LOSS"} pnl=${usd(BigInt(ev.pnl))} fee=${usd(fee)} (${feePct}%) ` +
      `paid_now=${usd(BigInt(ev.paid_now))} paper=${ev.paper_minted} stakers=${usd(toStakers)} dev=${usd(toDev)}`,
  );
  check(`[${tag}] fee (2%)`, ev.fee, fee);
  check(`[${tag}] paid_now`, ev.paid_now, paidNow);
  check(`[${tag}] queued`, ev.queued, 0);
  check(`[${tag}] paper_minted (event)`, ev.paper_minted, paper);
  check(`[${tag}] PAPER balance delta`, after.traderPaper - before.traderPaper, paper);
  check(`[${tag}] trading balance delta`, after.traderBalance - before.traderBalance, paidNow);
  check(`[${tag}] pool delta`, after.pool - before.pool, poolDelta);
  check(`[${tag}] dev_fees delta (fee - fee/2 if staked)`, after.devFees - before.devFees, toDev);
  check(`[${tag}] staker rewards delta (floor(fee/2))`, after.toStakers - before.toStakers, toStakers);
  check(`[${tag}] reward vault deposit delta`, after.rewardsDeposited - before.rewardsDeposited, toStakers);
  if (fee > 0n) {
    const fd = eventsOf(tx, "FeesDistributed")[0];
    check(`[${tag}] FeesDistributed split`, `${fd.to_stakers}/${fd.to_dev}`, `${fee / 2n}/${fee - fee / 2n}`);
  }
  checkInvariants(after, tag);
  return { isProfit, pnl: BigInt(ev.pnl), fee, paper, exit, before, after, hash: tx.hash, pending: after.traderPending - before.traderPending };
}

/* ------------------------------------------------------------------ */
/* Scenario                                                            */
/* ------------------------------------------------------------------ */

function loadTrader(): Account {
  if (existsSync(TRADER_FILE)) {
    const { privateKey } = JSON.parse(readFileSync(TRADER_FILE, "utf8"));
    return Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(privateKey) });
  }
  const acct = Account.generate();
  writeFileSync(
    TRADER_FILE,
    JSON.stringify({ address: acct.accountAddress.toString(), privateKey: acct.privateKey.toAIP80String() }, null, 2),
    { mode: 0o600 },
  );
  log(`generated trader ${acct.accountAddress} -> ${TRADER_FILE}`);
  return acct;
}

async function main() {
  const { account: deployer } = loadKeeperAccount();
  if (!deployer) throw new Error("no deployer key (KEEPER_PRIVATE_KEY / APTOS_PROFILE)");
  if (MODULE_ADDR === "0x0") throw new Error("MODULE_ADDR not set");
  const trader = loadTrader();
  const T = trader.accountAddress;
  log(`module=${MODULE_ADDR}`);
  log(`trader=${T}`);

  [usdcMeta] = (await view("test_usdc::metadata")).map((m: any) => m.inner ?? m);
  [exchangeVault] = await view("exchange::vault_address");
  [rewardVault] = await view("paper::vault_address");
  log(`usdc=${usdcMeta} exchangeVault=${exchangeVault} rewardVault=${rewardVault}`);
  checkInvariants(await snapshot(T), "start");

  if (flags.close) {
    const t = await view(VIEW.getPosition, [flags.close]);
    if (AccountAddress.from(t[0]).toString() !== T.toString()) throw new Error(`position #${flags.close} is not the trader's`);
    const p: Opened = {
      id: flags.close, market: Number(t[1]), isLong: t[2] === true, margin: BigInt(t[3]),
      notional: BigInt(t[5]), entry: BigInt(t[6]), tx: "",
    };
    await closeAndVerify(trader, p, `close #${p.id}`);
    return report();
  }

  // 1. Gas: transfer APT from the deployer.
  const apt = await aptBalance(T);
  if (apt < MIN_TRADER_APT) {
    await submit(deployer, { function: "0x1::aptos_account::transfer", functionArguments: [T, FUND_APT] }, "fund trader 0.5 APT");
  }
  log(`trader APT: ${Number(await aptBalance(T)) / 1e8}`);

  // 2. Faucet + deposit.
  const [cooldown] = await view(VIEW.faucetCooldown, [T.toString()]);
  if (Number(cooldown) === 0) {
    const w0 = BigInt((await view(VIEW.usdcBalance, [T.toString()]))[0]);
    await submit(trader, { function: fn(ENTRY.faucet), functionArguments: [] }, "faucet");
    const w1 = BigInt((await view(VIEW.usdcBalance, [T.toString()]))[0]);
    const [amt] = await view(VIEW.faucetConfig);
    check("faucet credited", w1 - w0, amt);
  } else log(`faucet on cooldown (${cooldown}s), using existing wallet USDC`);
  const wallet = BigInt((await view(VIEW.usdcBalance, [T.toString()]))[0]);
  const deposit = wallet < 2000n * USDC ? wallet : 2000n * USDC;
  if (deposit > 0n) {
    const b0 = await snapshot(T);
    await submit(trader, { function: fn(ENTRY.deposit), functionArguments: [deposit] }, `deposit ${usd(deposit)} USDC`);
    const b1 = await snapshot(T);
    check("deposit credited", b1.traderBalance - b0.traderBalance, deposit);
    check("deposit vault FA delta", b1.vaultFa - b0.vaultFa, deposit);
  }

  // 3. Liquidation scenario: 1000x straddle on BTC. Maintenance is margin/2 above 100x, so a
  //    ~0.05% move puts one side into liquidation; the keeper should liquidate it.
  if (!flags["skip-liq"]) {
    const margin = 10n * USDC;
    const s0 = await snapshot(T);
    const long = await openPosition(trader, MARKETS.BTC, true, margin, 1000, "open BTC LONG 1000x (liq test)");
    const short = await openPosition(trader, MARKETS.BTC, false, margin, 1000, "open BTC SHORT 1000x (liq test)");
    const [liqL] = await view(VIEW.liquidationPrice, [long.id]);
    const [liqS] = await view(VIEW.liquidationPrice, [short.id]);
    log(`  liq prices: long #${long.id} <= ${liqL}, short #${short.id} >= ${liqS} (entry ${long.entry})`);
    const timeout = Number(flags["liq-timeout"]);
    const until = Date.now() + timeout * 1000;
    let liquidated: Opened[] = [];
    while (Date.now() < until) {
      const live = await Promise.all([long, short].map(async (p) => ((await view(VIEW.positionExists, [p.id]))[0] ? null : p)));
      liquidated = live.filter((p): p is Opened => p !== null);
      if (liquidated.length) break;
      const { price } = await oraclePrice(MARKETS.BTC);
      process.stdout.write(`\r  waiting for liquidation… BTC oracle=${price} (${Math.round((until - Date.now()) / 1000)}s left)   `);
      await sleep(5000);
    }
    process.stdout.write("\n");
    if (!liquidated.length) {
      log(`  no liquidation within ${timeout}s; closing both legs`);
      results.push(`SKIP liquidation: price did not move 0.05% within ${timeout}s`);
      for (const p of [long, short]) await closeAndVerify(trader, p, `liq-test close #${p.id}`);
    } else {
      const liqHashes = await findLiquidationTxs(deployer.accountAddress, liquidated.map((p) => p.id));
      for (const p of liquidated) log(`  #${p.id} liquidated by keeper: ${liqHashes[p.id] ?? "(tx not found)"}`);
      for (const [id, h] of Object.entries(liqHashes)) txHashes.push(`keeper liquidate #${id}: ${h}`);
      // Snapshot after the liquidation(s), before closing the survivor.
      const sL = await snapshot(T);
      const fee = (margin * FEE_BPS) / BPS;
      const n = BigInt(liquidated.length);
      // Pool is < 2M so PAPER rate is the flat 100 per USDC; nothing staked yet so fees go to dev.
      check("[liq] trading balance delta = -2 margins (liquidated margin not refunded)", sL.traderBalance - s0.traderBalance, -2n * margin);
      check("[liq] PAPER minted (100 per USDC lost)", sL.traderPaper - s0.traderPaper, n * mintAmount(margin, s0.pool));
      check("[liq] pool delta (margin - 2% fee)", sL.pool - s0.pool, n * (margin - fee));
      check("[liq] dev_fees delta (2% fee, no stakers)", sL.devFees - s0.devFees, n * fee);
      checkInvariants(sL, "liq");
      for (const p of [long, short]) {
        if (!liquidated.includes(p)) await closeAndVerify(trader, p, `liq-test survivor #${p.id}`);
      }
    }
  }

  // 4. Stake PAPER so the next fee is genuinely split 50/50 (stakers / dev).
  const paperBal = BigInt((await view(VIEW.paperBalance, [T.toString()]))[0]);
  if (paperBal > 0n) {
    await submit(trader, { function: fn(ENTRY.stake), functionArguments: [paperBal] }, `stake ${paperBal} PAPER`);
    check("staked", BigInt((await view(VIEW.staked, [T.toString()]))[0]) >= paperBal, true);
  } else log("no PAPER to stake; fee split will go 100% to dev (nothing staked)");

  // 5. Main scenario: BTC long + ETH short at 50x, wait for movement, close the BTC long.
  const margin = 100n * USDC;
  const btc = await openPosition(trader, MARKETS.BTC, true, margin, 50, "open BTC LONG 50x");
  const eth = await openPosition(trader, MARKETS.ETH, false, margin, 50, "open ETH SHORT 50x");
  const [up] = await view("exchange::unrealized_pnl", [btc.id]).catch(() => [undefined]);
  log(`  BTC liq=${(await view(VIEW.liquidationPrice, [btc.id]))[0]} ETH liq=${(await view(VIEW.liquidationPrice, [eth.id]))[0]} (pnl view ok=${up !== undefined})`);
  const moved = await waitForMove(MARKETS.BTC, btc.entry);
  log(`  BTC oracle moved ${btc.entry} -> ${moved}`);
  const r = await closeAndVerify(trader, btc, "BTC long 50x");
  if (r.fee > 0n && r.before.totalStaked > 0n) {
    // Sole staker: pending rewards grow by floor(staked * Δacc / 1e18) ≈ fee/2 (may lose 1 unit to rounding).
    const d = r.pending;
    check("[BTC long 50x] trader pending staking rewards ≈ fee/2", d === r.fee / 2n || d === r.fee / 2n - 1n, true);
  }
  const [ethProfit, ethAmt] = await view("exchange::unrealized_pnl", [eth.id]);
  log(`  ETH short #${eth.id} left open; unrealized ${ethProfit ? "+" : "-"}${usd(BigInt(ethAmt))} USDC`);

  // 6. Final accounting.
  const fin = await snapshot(T);
  checkInvariants(fin, "final");
  log(
    `final: vaultFA=${usd(fin.vaultFa)} balances=${usd(fin.totalBalances)} margin=${usd(fin.totalMargin)} ` +
      `pool=${usd(fin.pool)} dev=${usd(fin.devFees)} rewardVaultFA=${usd(fin.rewardVaultFa)} ` +
      `trader: balance=${usd(fin.traderBalance)} PAPER=${fin.traderPaper} staked=${(await view(VIEW.staked, [T.toString()]))[0]} pending=${usd(fin.traderPending)}`,
  );

  report();
}

function report() {
  console.log("\n==== E2E RESULTS ====");
  for (const l of results) console.log(l);
  console.log("\n==== TX HASHES ====");
  for (const l of txHashes) console.log(l);
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Find keeper `liquidate` txs for the given position ids among the deployer's recent transactions. */
async function findLiquidationTxs(keeper: AccountAddress, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const info = await aptos.getAccountInfo({ accountAddress: keeper });
  const seq = Number(info.sequence_number);
  const txs = await aptos.getAccountTransactions({ accountAddress: keeper, options: { offset: Math.max(0, seq - 100), limit: 100 } });
  for (const t of txs as UserTransactionResponse[]) {
    for (const e of t.events ?? []) {
      if (e.type.endsWith("::exchange::PositionLiquidated") && ids.includes(String(e.data.id))) out[String(e.data.id)] = t.hash;
    }
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
