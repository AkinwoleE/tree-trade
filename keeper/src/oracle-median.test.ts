import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregatePrices, MedianPriceSource, type PriceSource } from "../../web/src/lib/prices";
import { sigDeviationOk } from "../../web/src/lib/price-guard";

const r = (name: string, BTC: number, ETH = 2400) => ({ name, prices: { BTC, ETH } });

test("median of agreeing sources", () => {
  const a = aggregatePrices([r("a", 100_000), r("b", 100_100), r("c", 100_050)]);
  assert.equal(a.prices.BTC, 100_050);
  assert.deepEqual(a.rejected, {});
});

test("one manipulated source is outvoted and rejected", () => {
  const a = aggregatePrices([r("perp", 100_600), r("cb", 100_000), r("kr", 100_010)]);
  assert.equal(a.prices.BTC, 100_005);
  assert.deepEqual(a.rejected.BTC, ["perp"]);
});

test("refuses with fewer than 2 fresh sources", () => {
  assert.throws(() => aggregatePrices([r("a", 100_000)]), /need 2/);
});

test("refuses a 1-vs-1 disagreement > 0.3%", () => {
  assert.throws(() => aggregatePrices([r("a", 100_000), r("b", 100_400)]), /disagree/);
});

test("refuses when no majority agrees", () => {
  assert.throws(() => aggregatePrices([r("a", 100_000), r("b", 100_000), r("c", 101_000), r("d", 101_000)]), /disagree/);
});

test("2 within 0.3% pass (degraded mode)", () => {
  assert.equal(aggregatePrices([r("a", 100_000), r("b", 100_200)]).prices.BTC, 100_100);
});

test("MedianPriceSource tolerates failed/timeouts", async () => {
  const ok = (name: string, p: number): PriceSource => ({ name, fetchPrices: async () => ({ BTC: p, ETH: 2400 }) });
  const bad: PriceSource = { name: "dead", fetchPrices: async () => { throw new Error("blocked"); } };
  const hang: PriceSource = { name: "hang", fetchPrices: () => new Promise(() => {}) };
  const q = await new MedianPriceSource([bad, hang, ok("x", 100_000), ok("y", 100_010)], 200).fetch();
  assert.equal(q.prices.BTC, 100_005);
  assert.equal(q.failed.length, 2);
});

test("price-sig refuses far-off prices vs on-chain", () => {
  assert.equal(sigDeviationOk(100_100, 100_000, 5).ok, true); // 10bps <= 30bps
  assert.equal(sigDeviationOk(100_500, 100_000, 5).ok, false); // 50bps > 30bps
  assert.equal(sigDeviationOk(103_000, 100_000, 3600).ok, false); // capped at 2%
  assert.equal(sigDeviationOk(100_000, 0, 1).ok, false);
});

import { CircuitBreakerSource as CB, MedianPriceSource as MPS } from "../../web/src/lib/prices";
import { retry429 } from "../../web/src/lib/retry";
import { test as t2 } from "node:test";
import assert2 from "node:assert/strict";

t2("capped Decibel source is dropped from the median and re-enabled automatically", async () => {
  let now = 0, calls = 0, capped = true;
  const dec = new CB({ name: "decibel", fetchPrices: async () => { calls++; if (capped) throw new Error("decibel prices: HTTP 429"); return { BTC: 100, ETH: 10 }; } }, 600_000, 3_600_000, () => now);
  const fixed = (name: string) => ({ name, fetchPrices: async () => ({ BTC: 100, ETH: 10 }) });
  const m = new MPS([dec, fixed("a"), fixed("b")]);
  await m.fetch(); // probe -> 429 -> paused
  assert2.equal(calls, 1);
  for (let i = 0; i < 5; i++) { now += 10_000; const q = await m.fetch(); assert2.ok(!q.used.BTC!.includes("decibel")); }
  assert2.equal(calls, 1, "no requests while paused");
  now += 600_000; await m.fetch(); assert2.equal(calls, 2, "one probe after the pause");
  now += 600_000; assert2.equal(dec.available(), false, "second cap doubles the pause");
  capped = false; now += 600_000;
  const q = await m.fetch();
  assert2.ok(q.used.BTC!.includes("decibel"), "re-enabled once the key works");
});

t2("retry429: backs off with jitter on 429 and gives up on other errors", async () => {
  const waits: number[] = [];
  let n = 0;
  const r = await retry429(async () => { if (++n < 3) throw Object.assign(new Error("Too Many Requests"), { status: 429 }); return "ok"; }, { sleep: async (ms) => void waits.push(ms), random: () => 0.5 });
  assert2.equal(r, "ok"); assert2.deepEqual(waits, [125, 250]);
  let m = 0;
  await assert2.rejects(retry429(async () => { m++; throw new Error("E_INSUFFICIENT"); }, { sleep: async () => {} }));
  assert2.equal(m, 1);
  let k = 0;
  await assert2.rejects(retry429(async () => { k++; throw Object.assign(new Error("429"), { status: 429 }); }, { sleep: async () => {} }));
  assert2.equal(k, 4);
});
