I couldn't run proof-of-concept tests. You asked me not to edit files, and even `aptos move test` writes a `build/` directory inside the package; creating a scratch copy in `/tmp` needed approval. So every finding below comes from reading the code line by line, with the arithmetic worked by hand.

# Adversarial review: `move/sources` (exchange, paper, oracle, hedge, tokenomics, usdc_gateway, test_usdc)

## Summary

| # | Sev | Area | Location |
|---|-----|------|----------|
| 1 | **Critical** | Gateway reserve can be drained with faucet-minted tUSDC | `usdc_gateway.move:72-81`, `test_usdc.move:87-110` |
| 2 | **High** | Oracle: one keeper/admin key sets any price, no deviation bound | `oracle.move:103-115` |
| 3 | **Medium** | Trading against stale prices (60s by default, up to 24h); no haircut before V2 | `oracle.move:130,156-161`, `exchange.move:331,385` |
| 4 | **Medium** | `init_v3` sets side caps to `U128_MAX` and turns off the notional OI cap, so open interest is unbounded | `exchange.move:341,1348,1353` |
| 5 | **Medium** | `set_impact_params` has no bounds: admin can zero all profits, or make winning closes abort | `exchange.move:1102-1108,1214-1219` |
| 6 | **Medium** | Hedge registry has a global cap of 1000 that anyone can fill (DoS) | `hedge.move:34,145` |
| 7 | Low | Session-key delegate can create hedge requests and give up the owner's queue priority | `hedge.move:90-103`, `exchange.move:1134-1139` |
| 8 | Low | Bust buffer can make positions liquidatable the moment they open | `exchange.move:1383-1389,1418-1433` |
| 9 | Low | `raise_tail_progress` to near `u128::MAX` makes every loss settlement abort | `tokenomics.move:64-72,130-136` |
| 10 | Low | `remove_pool_seed` ignores `debt_margin` and doesn't check the seed still exists | `exchange.move:1113-1127` |
| 11 | Low/Info | Emptied queue entries behind the head make the queue look active (fees waived, sweep blocked) | `exchange.move:982-1005,930` |
| 12–19 | Info | Various (see below) | |

---

## Critical

### 1. Gateway backing is broken: anyone can turn faucet tUSDC into Circle USDC
**Where:** `usdc_gateway.move:72-81` (`unwrap`), `test_usdc.move:87-102` (`faucet`), `test_usdc.move:105-110` (`mint`)

**Problem:** `unwrap` exchanges *any* `test_usdc` 1:1 for Circle USDC from the reserve. But `test_usdc` has two unbacked ways to mint: the permissionless faucet (10,000 per address per day; trivial to repeat with many addresses, and `cooldown_secs` may be set to 0), and unlimited admin `mint`. The module header promises "`minted_backed` never exceeds locked real USDC", but nothing enforces it.

**Exploit:**
1. Alice wraps 50,000 USDC, so the reserve holds 50,000.
2. Mallory calls `test_usdc::faucet` from 5 fresh addresses and collects 50,000 tUSDC.
3. Mallory calls `usdc_gateway::unwrap(50_000e6)` and receives all of Alice's USDC.

Alice's tUSDC can no longer be redeemed (`E_INSUFFICIENT_RESERVE`). Profits paid out by the exchange are also faucet-funded, so they can be redeemed the same way.

On testnet, Circle USDC has no monetary value. The bug is still critical against the gateway's stated design, and becomes direct theft on any deployment where the reserve asset has value.

**Fix:** Use a separate collateral asset that only the gateway mints, and have the exchange accept only that. If that's not possible:
- Track `backed_supply` in `Gateway` and make `unwrap` redeem only against it, e.g. by tagging gateway-minted funds.
- At minimum, remove the faucet and admin `mint` from any deployment where the gateway is live.

---

## High

### 2. A single oracle key controls every price, with no sanity bounds
**Where:** `oracle.move:103-115`

**Problem:** The admin or any of up to 16 keepers can push any price in `(0, 1e18]` with any `publish_time` between the stored time and now. There is no maximum change per update, no second source, and no delay. Every PnL calculation, liquidation and SEEDS mint depends on this one value.

**Exploit:** With a compromised or malicious keeper key:
1. Open a 1000x long (V3 caps allow up to $10M notional).
2. Push BTC ×10 and close. With V2 active, the haircut at m=900% is only about 1−0.9/(1+0.0001+0.014), so the trader keeps roughly 89% of raw profit.
3. The pool is paid out in full, and the remainder sits in the queue as a claim on all future losses.
4. Push the price back, then liquidate everyone else's positions for full margin.

**Fix:**
- Cap the change per update (e.g. ≤X% per push relative to the last price and elapsed time).
- Require an independent source (e.g. Pyth `price_feed` with a confidence check) or multiple keepers agreeing.
- Add a short delay or circuit breaker for large moves.

---

## Medium

### 3. Trading against stale prices
**Where:** `oracle.move:130` (staleness check), `oracle.move:156-161` (window adjustable up to 86,400s), `exchange.move:331,385`

**Problem:** Positions open and close at a price that may be up to `max_staleness_secs` old (60s by default, settable to 24h). There is no spread and no fee on opening; the fee is charged only on profit.

**Exploit:** A trader watches Binance. When the real price is already above the stored oracle price, they open a 1000x long, wait for the keeper's next push, and close.

**Before `init_v2`:** profit is not haircut. The only cost is the 2% fee, so this is close to riskless and drains the pool. The same applies if the admin raises the staleness window.

**After V2:** the impact haircut does most of the mitigation. At a 0.1% move, profit is cut to about 0.7% of raw; at a 1% move, to about 6.8%.

**Fix:**
- Keep the staleness window short (a few seconds) and enforce an upper bound much lower than 24h.
- Charge an open fee or spread.
- Or use a pull oracle where the trader submits a signed price that must be newer than the open transaction.

### 4. V3 activation leaves open interest uncapped
**Where:** `exchange.move:341` (`assert!(v3 || …)`), `exchange.move:1348,1353`

**Problem:** `init_v3` sets `long_cap_qty` and `short_cap_qty` to `U128_MAX`. Once `V3` exists, the legacy `oi_caps` (50M notional) is no longer checked, and `set_oi_cap` silently stops doing anything. Until the market keeper calls `set_side_caps`, house exposure is limited only by $10M per position. Anyone can open many positions across many addresses, while the pool is at most $5M.

Positions opened before V3 (`id < first_id`) are also not counted in `*_qty`, so caps set later under-count real exposure.

**Fix:**
- In `init_v3`, set the qty caps from the current `oi_caps` converted at the current price, or set them to 0 (side paused) until configured.
- Seed `long_qty`/`short_qty` with the existing OI.
- Make `set_oi_cap` abort under V3.

### 5. `set_impact_params` has no bounds
**Where:** `exchange.move:1102-1108`, used in `exchange.move:1214-1219`

**Problem:** Only `base_rate_bps < 10_000`, `rate_mult > 0` and `nref_usd > 0` are checked.
- **Setting `pos_mult_k[m] = 0`:** then `a = 0` and `num = 0`, so `adj = 0`. Every winning close in that market returns only the margin; profit is silently confiscated.
- **Huge `nref_usd` or `base_rate_bps = 9999`:** the same effect, almost zero profit.
- **Huge `rate_mult` / `pos_mult_k`:** `g*r*pk*1e6` and then `raw*num` overflow u256. Every winning close aborts, so winners can't exit while liquidations still work.

**Fix:**
- Enforce `pos_mult_k[i] > 0`.
- Enforce sane upper bounds on `rate_mult`, `pos_mult_k`, `nref_usd` and `base_rate_bps` (e.g. ≤ 2× the launch values, `base_rate_bps ≤ 2000`).
- Consider a timelock on these parameters.

### 6. Hedge registry can be filled by anyone
**Where:** `hedge.move:34` (`MAX_ACTIVE = 1000`), `hedge.move:145`

**Problem:** The cap is global, not per user. Any object you own counts as a valid "subaccount" (`object::is_owner` only), and requests can only be pruned after the position closes. The attacker keeps the positions open.

**Exploit:** With about 32 Sybil addresses, each opening 32 positions at 1x leverage, $1K notional, funded from the faucet:
1. Each position gets a `request_hedge` pointing at a throwaway object the attacker owns.
2. After 1000 requests, every real user's `open_position_hedged` / `request_hedge` aborts with `E_TOO_MANY_REQUESTS`.

At 1x leverage the attacker's positions barely move, so the attack costs almost nothing.

**Fix:** Use a per-owner limit (e.g. `MAX_POSITIONS_PER_USER`) with no global cap. `OrderedMap` can be replaced with `BigOrderedMap`/`Table` plus an indexer, since `active_requests` is just a view. Optionally require a minimum margin for hedged positions.

---

## Low

### 7. Delegate scope is wider than the docs say
**Where:** `hedge.move:90-103`, `exchange.move:1134-1139`
- **Hedge requests:** `open_position_hedged_as_delegate` lets a session key create hedge requests. The hedger then trades on the owner's Decibel subaccount, possibly with real funds, using the owner's Decibel delegation. This conflicts with the module docstring ("per-position, **owner-signed** consent"). A delegate can create requests but cannot cancel them (`cancel_hedge` needs the owner).
- **Queue priority:** `open_position_from_queue_as_delegate` lets a compromised session key turn the owner's queued claims into debt positions. When those close, the surviving claim is re-queued at the **tail**, so the owner loses their place in line.
- **No expiry required:** delegations can be created with no expiry (`exp = 0`, `exchange.move:494-496`).

**Fix:**
- Either require the owner's signature for hedge requests, or add a separate opt-in flag for each delegate (a capabilities bitmask: open/close/queue/hedge).
- Consider a maximum delegation lifetime.

### 8. Bust buffer can make positions liquidatable at open
**Where:** `exchange.move:1383-1389`, `1418-1433`, `open_core` at `325-373`

**Problem:** `set_bust_buffers` accepts any buffer below 1%. At leverage L, a long's bust price is about `e(1 − 1/L + buf)`. Once `buf ≥ 1/L` (about 0.1% at 1000x), bust ≥ entry and the position can be liquidated in the same block, losing its full margin. `open_core` never checks that a new position is not already liquidatable.

**Fix:** Require `buf < 1/(MAX_LEVERAGE+1)` in WAD, and/or assert `!is_liquidatable_at(&pos, price)` in `open_core`.

### 9. `tail_progress` overflow blocks loss settlement
**Where:** `tokenomics.move:64-72`, `130-136`

**Problem:** `raise_tail_progress` accepts any u128. With `tail` close to `2^128`, `d = s + tail` slightly exceeds 2^128, so `d*d` overflows u256. Then every `quote` aborts when tracked LP ≥ threshold, and with it every losing close and every liquidation. Admin-only, but it would freeze the whole exchange.

**Fix:** Cap `new_tail` (e.g. ≤ 2^96) or compute `(s/d)^2` in a way that cannot overflow.

### 10. `remove_pool_seed` can take cash that backs debt
**Where:** `exchange.move:1113-1127`

**Problem:** It checks that the queue is empty but ignores `debt_margin`, the outstanding contingent claims. It also never checks that the 50k seed is actually still in the pool; the pool may by then be only trader losses. The admin can pull up to 50k from cash that backs debt-funded positions, pushing tracked LP negative.

**Fix:** Require `pool - amount ≥ debt_margin`, or `debt_margin == 0`.

### 11. Emptied queue entries can make the queue look active
**Where:** `exchange.move:982-1005`, `930`

**Scenario:**
1. The queue holds [A(rem 100), B(rem 0)]. B was emptied by an `open_position_from_queue`, but it isn't at the head, so it stays in the table.
2. A pool inflow of 100 pays A, and `queue_head` moves to B.
3. The loop condition `ex.pool > 0` then stops the loop, so B is never skipped and `queue_head != queue_tail` with nothing owed.

**Effect:** The next `settle_loss` treats the queue as active and waives the 2% fee (stakers and dev lose it). Also, `sweep_excess`, `remove_pool_seed` and `init_v2` are blocked until the next crank. It fixes itself on the next `process_queue_internal`, which calls `skip_empty_head` first.

**Fix:** Call `skip_empty_head(ex)` after the loop, and before computing `queue_active` in `settle_loss`.

---

## Info

12. **Overflow aborts in extreme cases:**
    - `settle_debt_close`: `pos.margin + amt - fee` is u64 (`exchange.move:1179`), and `raw*num` can overflow in `impact_adjusted` (`1219`). Both need near-maximum prices such as entry=1, exit=1e18, so they are only reachable through oracle abuse (#2). Saturate or compute in u128/u256.
    - `compute_rate_e6` casts to u64 (`tokenomics.move:82`) and aborts if `flat_rate > ~1.8e13`. View only.
13. **No reward for liquidators** (`exchange.move:429-446`). Liquidation depends entirely on the house keeper. If prices jump past bankruptcy (keeper outage, then a big push), the pool absorbs losses beyond margin while the opposite side is paid in full.
14. **Dead legacy mint curve:** `paper::mint_for_loss` and `paper::mint_amount` (`paper.move:117-119, 213-220`) are no longer called; the exchange uses `tokenomics::quote`. `mint_amount` is still a public view and returns a different curve, which could mislead a front-end. Remove it.
15. **Admin handling:**
    - `test_usdc::set_admin` is a single step with no accept, so a typo is unrecoverable.
    - The `tokenomics` admin is fixed to the deployer and cannot be transferred, which is inconsistent with the two-step transfer in exchange and oracle.
16. **Rate is not integrated over large losses:** one large loss mints entirely at the pre-loss marginal rate. This is documented as matching Paper Trade. A $10M loss over-mints about 8% compared with splitting it into small losses.
17. **`queued_balance_of` loops without bound** from `queue_head` to the user's first index (`exchange.move:1270`). It's a view, but it can hit gas limits on a long queue.
18. **Unaccounted direct transfers:** tUSDC sent straight to the vault or paper-vault addresses is not in any bucket and is stuck. Harmless.
19. **Hedge subaccount ownership is checked only when the request is created** (`hedge.move:138-142`). The off-chain hedger must re-check ownership and the Decibel delegation before every action.

---

## Checked and fine

- **Vault invariant** `vault == total_balances + total_margin + pool + dev_fees`: I traced every path and it holds. Paths: deposit, withdraw, fund_pool, open (cash and from-queue), win, loss, liquidation (normal and debt), `settle_debt_close`, `process_queue`, `sweep_excess`/`send_to_stakers` (withdraw to the paper vault, or to `dev_fees` when nothing is staked), `withdraw_dev_fees` and `remove_pool_seed`. `queue_owed` and `debt_margin` are unbacked liabilities by design, and are counted correctly in the tracked LP and the sweep floor.
- **Vault custody:** the vault objects are moved to `0xfff…f` with ungated transfer disabled. Only the module's `ExtendRef` can move funds. tUSDC is non-dispatchable, so it can't call back into the exchange.
- **FIFO queue:** entries are only removed at the head, and all of `[head, tail)` exist in the table. `UserQueue.total` and `indices` stay in step with entry `remaining` across enqueue, partial and full pay, and debt consumption (newest first). Nothing from before V2 exists, since `init_v2` requires an empty queue. Winners can't jump the queue: `settle_profit` and `settle_debt_close` process the queue first and pay only when it is empty. The win fee is paid only when the trader is paid in full.
- **Rounding:**
  - PnL: profit rounded down, loss rounded up and capped at margin.
  - Fees: win fee rounded up, loss fee rounded down; the 50/50 split rounds down for stakers.
  - Haircut and mint curve round down.
  - Paper rewards: per-staker shares round down with the remainder carried over, so the sum of claims never exceeds deposits.
  - `compute_mint` stays within u256 for every u64 input (about 1.05e77 < 1.157e77).
- **Bust price:** long `p0` rounded up / bust rounded down, short `p0` rounded down / bust rounded up, as commented. 1x long is never liquidatable. V3 qty is computed the same way on open and close (same notional and entry price).
- **Session keys:** delegates cannot withdraw, deposit, stake, claim, re-delegate or touch other owners' positions (`pos.owner == owner` is checked). Expiry uses strict `exp > now`. Settlement always credits `pos.owner`. Up to 8 delegates, with expired entries pruned.
- **Re-initialisation:** `init_v2` and `init_v3` require the admin *and* `@papertrade` *and* that the resource doesn't exist yet. They can't be re-run, and after an admin transfer they fail safely. Each module's `init_module` runs only once.
- **Access control:** every admin and keeper entry function checks its own module's admin. `paper::mint_seeds`, `deposit_rewards`, `tokenomics::quote`/`on_lp_gain` and `test_usdc::mint_for_gateway` are friend-only.
- **Oracle:** `publish_time` must be ≤ now and must not go backwards; the staleness sum can't overflow; missing or stale prices abort. Withdraw, close and liquidate are not blocked by pause; only deposit and open are.
