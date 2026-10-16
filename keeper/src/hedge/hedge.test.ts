/**
 * Unit tests: hedge sizing (web/src/lib/hedge.ts), delegation parsing, Decibel address derivation, and the
 * sync engine against MockDecibelClient + an in-memory Tree Trade chain.
 *
 *   npm test        (tsx --test src/**\/*.test.ts)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getMarketAddr, getPerpEngineGlobalAddress, getUsdcAddress } from "@decibeltrade/sdk";
import {
  delegationFor,
  iocPrice,
  planTrade,
  previewHedge,
  targetSize,
  type HedgedPosition,
  type MarketSpec,
} from "../../../web/src/lib/hedge";
import { DECIBEL_PACKAGE, DECIBEL_PERP_ENGINE_GLOBAL, DECIBEL_USDC, decibelMarketAddr } from "../../../web/src/config/decibel";
import { MockDecibelClient } from "./decibel-client";
import { DECIBEL_TESTNET_PACKAGE } from "./decibel-config";
import { DEFAULT_SYNC, HedgeSync, emptyState, type ChainPort, type HedgeRequestRow, type TTPosition } from "./sync";

const BTC = MockDecibelClient.SPECS["BTC/USD"];
const ETH = MockDecibelClient.SPECS["ETH/USD"];
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const px8 = (x: number) => BigInt(Math.round(x * 1e8));
const pos = (id: string, isLong: boolean, notional: number, entry: number): HedgedPosition => ({
  id,
  isLong,
  notionalRaw: usdc(notional),
  entryPriceRaw: px8(entry),
});

describe("sizing", () => {
  test("hedge is the opposite base exposure N/E, in size units", () => {
    // 10,000 USDC long at 80,000 = 0.125 BTC; BTC sz_decimals 9 -> 125,000,000 units; hedge is short.
    assert.equal(targetSize([pos("1", true, 10_000, 80_000)], BTC), -125_000_000n);
    assert.equal(targetSize([pos("1", false, 10_000, 80_000)], BTC), 125_000_000n);
  });

  test("rounds to the nearest lot (half up) and stays a lot multiple", () => {
    // 1,000 USDC at 81,234.56 = 0.0123099... BTC = 12,309,958.x units -> nearest 10,000 lot = 12,310,000
    const t = targetSize([pos("1", true, 1_000, 81_234.56)], BTC);
    assert.equal(t, -12_310_000n);
    assert.equal(t % BTC.lotSize, 0n);
    // exactly half a lot rounds up: 0.000015 BTC = 15,000 units -> 20,000
    assert.equal(targetSize([pos("1", false, 1.2, 80_000)], BTC), 20_000n);
  });

  test("aggregate is rounded once, not per position", () => {
    // each 0.000014 BTC (14,000 units): per-position rounding gives 10,000 + 10,000; aggregate 28,000 -> 30,000
    const a = pos("1", true, 1.12, 80_000);
    const b = pos("2", true, 1.12, 80_000);
    assert.equal(targetSize([a], BTC), -10_000n);
    assert.equal(targetSize([a, b], BTC), -30_000n);
  });

  test("long and short positions on the same account net", () => {
    const t = targetSize([pos("1", true, 80_000, 80_000), pos("2", false, 32_000, 80_000)], BTC);
    assert.equal(t, -600_000_000n); // -1 + 0.4 BTC
  });

  test("planTrade: in sync, below min, dust, reduce-only, flip, increase", () => {
    assert.deepEqual(planTrade(0n, 0n, BTC), { kind: "none", reason: "in-sync" });
    assert.deepEqual(planTrade(-100_000n, -90_000n, BTC), { kind: "none", reason: "below-min-size" });
    assert.equal(planTrade(0n, 10_000n, BTC).kind, "dust");
    assert.deepEqual(planTrade(0n, -100_000n, BTC), { kind: "order", isBuy: true, size: 100_000n, reduceOnly: true });
    assert.deepEqual(planTrade(-40_000n, -100_000n, BTC), { kind: "order", isBuy: true, size: 60_000n, reduceOnly: true });
    // crossing zero cannot be reduce-only (reduce-only never flips)
    assert.deepEqual(planTrade(50_000n, -100_000n, BTC), { kind: "order", isBuy: true, size: 150_000n, reduceOnly: false });
    assert.deepEqual(planTrade(-100_000n, 0n, BTC), { kind: "order", isBuy: false, size: 100_000n, reduceOnly: false });
  });

  test("iocPrice: side-safe tick rounding inside the slippage band and price band", () => {
    const mark = 81_234_567_890n; // $81,234.567890
    const buy = iocPrice(mark, true, 100, BTC);
    const sell = iocPrice(mark, false, 100, BTC);
    assert.equal(buy % BTC.tickSize, 0n);
    assert.equal(sell % BTC.tickSize, 0n);
    assert.ok(buy <= (mark * 101n) / 100n && buy > mark);
    assert.ok(sell >= (mark * 99n) / 100n && sell < mark);
    assert.equal(iocPrice(5n, false, 100, { ...BTC, minPrice: 2_000_000n }), 2_000_000n);
  });

  test("previewHedge: side, fees, margin, leverage cap, min size", () => {
    const p = previewHedge({ isLong: true, notionalUsd: 8_000, entryUsd: 80_000, markUsd: 80_000, spec: BTC, leverage: 100 });
    assert.equal(p.side, "SHORT");
    assert.equal(p.sizeBase, 0.1);
    assert.equal(p.leverage, 40);
    assert.ok(p.leverageCapped);
    assert.equal(p.marginUsd, 200);
    assert.ok(Math.abs(p.feesUsd - 7.2) < 1e-9); // 2 * 8000 * 0.045%
    assert.ok(p.fundingPerDayUsd < 0); // shorts receive the baseline
    assert.ok(previewHedge({ isLong: false, notionalUsd: 1, entryUsd: 2_400, markUsd: 2_400, spec: ETH, leverage: 5 }).belowMin);
  });
});

describe("delegation", () => {
  // Shape returned by dex_accounts::view_delegated_permissions on testnet (probe, 2026-10-15).
  const hedger = "0x6dfdba8500dbf2a4d5980db421c1376806c57b0dca217ae96c1811c5cdc6173e";
  const btcMarket = "0x470454bb64051f8c5633291d1d65e2662bd345c7e0875e62a64de349ab63d1bf";
  const perms = (key: object, value: object) => ({
    __variant__: "SortedVectorMap",
    entries: [{ key: hedger, value: { __variant__: "V1", perms: { __variant__: "SortedVectorMap", entries: [{ key, value }] } } }],
  });
  const marketKey = { __variant__: "TradePerpsOnMarket", market: { inner: btcMarket } };
  const until = (t: number) => ({ __variant__: "UnlimitedUntilVia", authorized_by: "0x4b", expiration_time_s: String(t) });

  test("market-scoped delegation with expiry", () => {
    const d = delegationFor(perms(marketKey, until(2_000)), hedger, btcMarket, 1_000);
    assert.deepEqual(d, { canTrade: true, scope: "market", expiresAt: 2_000, excessive: [] });
  });
  test("expired, other market, other delegate", () => {
    assert.equal(delegationFor(perms(marketKey, until(900)), hedger, btcMarket, 1_000).canTrade, false);
    assert.equal(delegationFor(perms(marketKey, until(2_000)), hedger, "0x59fa", 1_000).canTrade, false);
    assert.equal(delegationFor(perms(marketKey, until(2_000)), "0x1234", btcMarket, 1_000).canTrade, false);
  });
  test("all-markets delegation works; funds movement is flagged as excessive", () => {
    assert.equal(delegationFor(perms({ __variant__: "TradePerpsAllMarkets" }, { __variant__: "Unlimited" }), hedger, btcMarket, 1).scope, "all-perps");
    const d = delegationFor(perms({ __variant__: "SubaccountFundsMovement" }, { __variant__: "Unlimited" }), hedger, btcMarket, 1);
    assert.deepEqual(d, { canTrade: false, excessive: ["SubaccountFundsMovement"] });
  });
});

describe("decibel addresses", () => {
  test("web config derives the same addresses as the SDK", () => {
    assert.equal(DECIBEL_PACKAGE, DECIBEL_TESTNET_PACKAGE);
    assert.equal(DECIBEL_USDC, getUsdcAddress(DECIBEL_PACKAGE).toString());
    assert.equal(DECIBEL_PERP_ENGINE_GLOBAL, getPerpEngineGlobalAddress(DECIBEL_PACKAGE).toString());
    for (const m of ["BTC/USD", "ETH/USD"]) assert.equal(decibelMarketAddr(m), getMarketAddr(m, DECIBEL_PERP_ENGINE_GLOBAL).toString());
    // BTC/USD address as listed by perp_engine::list_markets on testnet
    assert.equal(decibelMarketAddr("BTC/USD"), "0x470454bb64051f8c5633291d1d65e2662bd345c7e0875e62a64de349ab63d1bf");
  });
});

/* ------------------------------------------------------------------ */
/* Sync engine                                                         */
/* ------------------------------------------------------------------ */

class FakeChain implements ChainPort {
  reqs = new Map<string, HedgeRequestRow>();
  open = new Map<string, TTPosition>();
  prunes: string[] = [];
  async requests() {
    return [...this.reqs.values()];
  }
  async position(id: string) {
    return this.open.get(id) ?? null;
  }
  async prune(id: string) {
    if (this.open.has(id)) throw new Error("E_POSITION_OPEN");
    if (!this.reqs.delete(id)) throw new Error("abort_code: 4 E_NO_REQUEST");
    this.prunes.push(id);
    return `0xprune${id}`;
  }
  openHedged(id: string, owner: string, sub: string, symbol: "BTC" | "ETH", isLong: boolean, notional: number, entry: number) {
    this.open.set(id, { ...pos(id, isLong, notional, entry), owner, symbol });
    this.reqs.set(id, { positionId: id, owner, subaccount: sub });
  }
}

function harness() {
  const client = new MockDecibelClient();
  const chain = new FakeChain();
  let now = 1_000_000;
  const logs: string[] = [];
  const opt = { ...DEFAULT_SYNC, now: () => now, log: (m: string) => logs.push(m) };
  const sync = new HedgeSync(client, chain, emptyState("mock", client.hedgerAddress), opt);
  const tick = async (advanceMs = 15_000) => {
    client.step();
    now += advanceMs;
    return sync.tick();
  };
  return { client, chain, sync, tick, logs, opt, advance: (ms: number) => (now += ms), nowRef: () => now };
}

const ALICE = "0xa11ce";
const SUB = "0x5ub";
const key = `${SUB}|BTC/USD`;

describe("sync", () => {
  test("in sync + unchanged target: skips Decibel reads until the reconcile interval", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    await h.tick();
    let s = await h.tick();
    assert.equal(s.groups[key].status, "in-sync");
    let reads = 0;
    const orig = h.client.position.bind(h.client);
    h.client.position = async (a, b) => (reads++, orig(a, b));
    for (let i = 0; i < 10; i++) await h.tick(15_000); // 150 s < 300 s
    assert.equal(reads, 0, "no Decibel position reads while nothing changed");
    await h.tick(200_000);
    assert.equal(reads, 1, "periodic reconcile re-reads");
    h.chain.open.delete("1");
    s = await h.tick();
    assert.equal(reads, 2, "target change forces a read");
    assert.equal(s.positions["1"].status, "closed-awaiting-flatten");
  });

  test("open -> one order -> waits while pending (no double hedge) -> in sync", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    h.client.fillDelay = 3;
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    let s = await h.tick();
    assert.equal(s.groups[key].status, "pending");
    assert.equal(h.client.placed.length, 1);
    assert.deepEqual([h.client.placed[0].isBuy, h.client.placed[0].size, h.client.placed[0].reduceOnly], [false, 125_000_000n, false]);
    s = await h.tick(); // still matching
    assert.equal(s.groups[key].status, "pending");
    assert.equal(h.client.placed.length, 1);
    s = await h.tick();
    s = await h.tick();
    assert.equal(s.groups[key].status, "in-sync");
    assert.equal(s.groups[key].actual, "-125000000");
    assert.equal(s.positions["1"].hedgeSize, "-125000000");
    await h.tick();
    assert.equal(h.client.placed.length, 1, "no further orders once in sync");
  });

  test("close -> reduce-only flatten -> prune once", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    await h.tick();
    await h.tick();
    h.chain.open.delete("1"); // closed by owner
    let s = await h.tick();
    assert.equal(s.positions["1"].status, "closed-awaiting-flatten");
    const close = h.client.placed[1];
    assert.deepEqual([close.isBuy, close.size, close.reduceOnly], [true, 125_000_000n, true]);
    assert.deepEqual(h.chain.prunes, [], "not pruned before the hedge is flat");
    s = await h.tick();
    assert.equal(h.client.positions.get(key), 0n);
    assert.deepEqual(h.chain.prunes, ["1"]);
    assert.equal(s.groups[key], undefined);
    assert.equal(s.positions["1"], undefined);
    await h.tick();
    assert.deepEqual(h.chain.prunes, ["1"]);
    assert.equal(h.client.placed.length, 2);
  });

  test("liquidation of one of two netted positions shrinks the hedge to the survivor", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 80_000, 80_000); // hedge -1 BTC
    h.chain.openHedged("2", ALICE, SUB, "BTC", false, 32_000, 80_000); // hedge +0.4 BTC
    await h.tick();
    await h.tick();
    assert.equal(h.client.positions.get(key), -600_000_000n);
    assert.equal(h.client.placed.length, 1, "netted into a single order");
    h.chain.open.delete("2"); // liquidated
    await h.tick();
    await h.tick();
    assert.equal(h.client.positions.get(key), -1_000_000_000n);
    assert.deepEqual(h.chain.prunes, ["2"]);
    assert.equal(h.client.placed[1].reduceOnly, false); // growing the short is not a reduction
  });

  test("partial fills converge without overshooting", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    h.client.fillRatio = 0.5;
    h.chain.openHedged("1", ALICE, SUB, "BTC", false, 8_000, 80_000); // target +0.1 BTC = 100,000,000
    for (let i = 0; i < 20; i++) await h.tick();
    const final = h.client.positions.get(key)!;
    assert.ok(final <= 100_000_000n && 100_000_000n - final < BTC.minSize, `final ${final}`);
    for (const o of h.client.placed) assert.equal(o.isBuy, true, "never sells back");
  });

  test("no delegation: no orders, clear status; hedges once delegated", async () => {
    const h = harness();
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    let s = await h.tick();
    assert.equal(s.groups[key].status, "not-delegated");
    assert.equal(h.client.placed.length, 0);
    h.client.delegate(SUB, "BTC/USD");
    h.advance(DEFAULT_SYNC.baseBackoffMs);
    s = await h.tick();
    assert.equal(s.groups[key].status, "pending");
    assert.equal(h.client.placed.length, 1);
  });

  test("delegation revoked while hedged, then position closes: orphaned (user must close on Decibel)", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    await h.tick();
    await h.tick();
    h.client.delegated.clear();
    h.chain.open.delete("1");
    const s = await h.tick();
    assert.equal(s.groups[key].status, "orphaned");
    assert.match(s.groups[key].lastError!, /close it on Decibel/);
    assert.deepEqual(h.chain.prunes, [], "request kept so the orphan stays visible");
  });

  test("order failure backs off, then retries", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    h.client.failNext = ["EINSUFFICIENT_MARGIN"];
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    let s = await h.tick();
    assert.equal(s.groups[key].status, "failed");
    assert.equal(s.groups[key].lastError, "EINSUFFICIENT_MARGIN");
    s = await h.tick(1_000); // inside the 30 s cooldown
    assert.equal(h.client.placed.length, 0);
    s = await h.tick(DEFAULT_SYNC.baseBackoffMs);
    assert.equal(h.client.placed.length, 1);
    assert.equal(s.groups[key].status, "pending");
  });

  test("IOC that fills nothing is reported as a failure", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    h.client.fillRatio = 0;
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    await h.tick();
    const s = await h.tick();
    assert.equal(s.groups[key].status, "failed");
    assert.match(s.groups[key].lastError!, /did not fill/);
  });

  test("restart while an order is in flight does not place a duplicate", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    h.client.fillDelay = 3;
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    await h.tick();
    const saved = JSON.parse(JSON.stringify(h.sync.state));
    const restarted = new HedgeSync(h.client, h.chain, saved, h.opt);
    h.client.step();
    await restarted.tick();
    assert.equal(h.client.placed.length, 1);
  });

  test("order acknowledged without an order id is still treated as in flight", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    h.client.fillDelay = 2;
    const place = h.client.placeOrder.bind(h.client);
    h.client.placeOrder = async (r) => {
      const res = await place(r);
      return res.ok ? { ok: true, txHash: res.txHash } : res;
    };
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    await h.tick();
    await h.tick(5_000); // not yet filled, no id to ask about
    assert.equal(h.client.placed.length, 1);
    const s = await h.tick(20_000);
    assert.equal(s.groups[key].status, "in-sync");
    assert.equal(h.client.placed.length, 1);
  });

  test("unknown order outcome (timeout) is not resubmitted until the position is re-read", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    const place = h.client.placeOrder.bind(h.client);
    h.client.placeOrder = async (r) => {
      await place(r); // it did land...
      return { ok: false, unknown: true, error: "placeOrder timed out" }; // ...but we could not tell
    };
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    let s = await h.tick();
    assert.equal(s.groups[key].status, "pending");
    s = await h.tick(5_000);
    assert.equal(h.client.placed.length, 1, "no resubmission while the outcome is unknown");
    s = await h.tick(20_000);
    assert.equal(s.groups[key].status, "in-sync");
    assert.equal(h.client.placed.length, 1);
  });

  test("state lost after a close: flattens every market of the subaccount before pruning", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    h.client.delegate(SUB, "ETH/USD");
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    await h.tick();
    await h.tick();
    h.chain.open.delete("1");
    const fresh = new HedgeSync(h.client, h.chain, emptyState("mock", h.client.hedgerAddress), h.opt);
    await fresh.tick();
    assert.deepEqual(h.chain.prunes, []);
    h.client.step();
    await fresh.tick();
    assert.equal(h.client.positions.get(key), 0n);
    assert.deepEqual(h.chain.prunes, ["1"]);
  });

  test("cancelled request (position still open) flattens the hedge", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    await h.tick();
    await h.tick();
    h.chain.reqs.delete("1"); // hedge::cancel_hedge
    await h.tick();
    const s = await h.tick();
    assert.equal(h.client.positions.get(key), 0n);
    assert.equal(s.groups[key], undefined);
  });

  test("request whose owner does not match the position is ignored", async () => {
    const h = harness();
    h.client.delegate(SUB, "BTC/USD");
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    h.chain.reqs.set("1", { positionId: "1", owner: "0xbad", subaccount: SUB });
    const s = await h.tick();
    assert.equal(h.client.placed.length, 0);
    assert.equal(s.positions["1"], undefined);
  });
});

describe("review 2026-10-15", () => {
  test("H-5: another group's RPC failure does not drop a just-placed order (no double hedge)", async () => {
    const h = harness();
    const SUB2 = "0x5ub2";
    h.client.delegate(SUB, "BTC/USD");
    h.client.delegate(SUB2, "BTC/USD");
    h.client.fillDelay = 3;
    h.chain.openHedged("1", ALICE, SUB, "BTC", true, 10_000, 80_000);
    h.chain.openHedged("2", "0xb0b", SUB2, "BTC", true, 10_000, 80_000);
    const orig = h.client.position.bind(h.client);
    let fail = true;
    h.client.position = async (sub: string, m: MarketSpec) => {
      if (sub === SUB2 && fail) throw new Error("429 Too Many Requests");
      return orig(sub, m);
    };
    let s = await h.tick();
    assert.equal(h.client.placed.length, 1, "group 1 placed once");
    assert.ok(s.groups[key]?.pending, "group 1's in-flight order survives group 2's failure");
    fail = false;
    s = await h.tick();
    const forSub1 = h.client.placed.filter((o) => o.subaccount === SUB).length;
    assert.equal(forSub1, 1, "group 1 not re-hedged while its order is pending");
  });
});
