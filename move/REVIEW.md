# papertrade — adversarial self-review

Scope: `sources/test_usdc.move`, `oracle.move`, `exchange.move`, `paper.move` (tests in `sources/tests.move`).
Result after fixes: `aptos move test --dev` → **88 / 88 passing**, no compiler warnings. The package also compiles with a real named address.

## Design summary

- **One vault, internal buckets.** All exchange USDC sits in one vault object. The invariant
  `vault == total_balances + total_margin + pool + dev_fees` is asserted after every test scenario (`check_invariants`).
- **PAPER reward vault.** This is a separate object. Its invariant is `vault == deposited - claimed`.
- **Pool inflows are processed in this order:** first the FIFO queue (at most 16 entries automatically), then the sweep of anything above 5M to stakers. The sweep only runs when the queue is empty.
- **Fees** are split 50/50. Stakers get `floor(fee/2)` and dev gets the remainder. When nothing is staked, the stakers' half (and any sweep) goes to dev. Carrying it over instead would let the next staker capture it.

## Findings and fixes

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | **Critical** | Object ownership on Aptos is transitive (`object::owns` walks the owner chain). The deployer owned both vault objects, so it could call `fungible_asset::withdraw` on the vault stores and drain all user deposits and staker rewards, bypassing all accounting. Confirmed with a failing test before the fix. | At init, ownership of both vault objects moves to `0xfff…f`, which has no `ObjectCore` and no signer, using a linear `TransferRef`. Ungated transfer is disabled. Only the module's `ExtendRef` signer can withdraw. | `test_deployer_cannot_drain_exchange_vault`, `test_deployer_cannot_drain_reward_vault`, `test_vaults_not_owned_by_deployer` |
| 2 | Medium | `is_liquidatable` computed `loss_ceil + maint`. `loss_ceil` saturates at `u128::MAX`, so in principle the addition could overflow. That would abort and make the position impossible to liquidate. | Rewritten as `loss_ceil >= margin - maint`. This cannot overflow because `maint <= margin`. | `test_extreme_values_no_overflow` |
| 3 | Medium | Lifetime stats counters (`total_staker_rewards`, `total_dev_fees_accrued`, `total_rewards_deposited/claimed`) were u64. Lifetime volume can exceed the u64 balance bound because funds are recycled. An overflow there would abort and block every close and liquidation. | Counters changed to u128. | `test_fee_accounting_and_conservation` |
| 4 | Design | Spec says maintenance = 0.5% of notional. Above 200x leverage, margin (`notional/lev`) is below 0.5% of notional, so every position from 200x to 1000x would be liquidatable the moment it opened. | Maintenance = `min(ceil(0.5% notional), ceil(margin/2))`. The cap only applies above 100x. **This deviates from the spec; please confirm.** | `test_leverage_bounds_ok`, `test_liquidation_1000x` |
| 5 | Design | Collecting the profit fee when the pool is short would pay stakers/dev ahead of traders waiting in the queue. | The profit fee is taken from the pool only when the winner is paid in full. If any of the payout is queued, the fee is waived. | `test_fifo_queue_partial_fills` (`dev_fees == 0` after the queued wins) |
| 6 | Low | Reward-per-share rounding: the usual `reward_debt` pattern can over-credit by 1 unit per staker, which can make the last claim fail. | Each account stores an `rps_snapshot` and accrues `floor(staked * Δacc / 1e18)`. The global division remainder is carried in `rps_remainder`. Total claims never exceed deposits. | `test_reward_rounding_never_insolvent` |

### Checked areas with no bug found (or handled from the start)

- **Overflow in pnl/notional.**
  - `notional = margin * leverage` is stored as u128 (it can exceed u64).
  - PnL uses u256 intermediates (`notional * |Δprice|` can reach about 1e41) and saturates to u128.
  - Realized profit is clamped to u64. The queue total is u128.
  - Oracle price is bounded to `(0, 1e18]`.
  - PAPER mint is computed in u128 and saturates at the u64 supply limit, so it never aborts a close.
  - Tested at about `u64::MAX` notional with a price move from 1 to 1e18.
- **Rounding.** Every choice favours the pool:
  - profit is floored; loss is ceiled (and capped at margin);
  - maintenance is ceiled;
  - the fee on losses is floored (the pool keeps more);
  - staker rewards are floored.
  - `test_rounding_favors_pool`: a 1-raw-unit adverse move costs 1 base unit; a favourable one pays 0.
- **Bankrupt positions and price gaps.** Losses are capped at margin, so the pool never takes on bad debt and a trader never owes more than their margin. Owner close and liquidation both work after a gap (`test_liquidation_bankrupt_gap`, `test_owner_close_bankrupt`).
- **Queue edge cases.**
  - Empty pool: the whole net profit is queued.
  - Partial fills and FIFO order: covered.
  - A new winner goes to the back while older entries remain.
  - Funding the pool or liquidations pay the queue.
  - `fund_pool` room = `cap + queue_owed`.
- **Queue gas bounds.**
  - Automatic processing is limited to 16 entries per inflow.
  - The permissionless `process_queue` crank is limited to 1–200 steps.
  - Fully paid entries are removed from the table.
  - The per-user position list is capped at 32, so `vector::index_of` is bounded.
  - Test: 40-entry queue, step bound, then the crank clears it.
- **Fee double counting.** Every fee unit is moved to exactly one destination, and invariants are checked. `test_fee_accounting_and_conservation` checks that `stakers + dev` equals the fees charged and that total USDC across wallets and vaults is conserved.
- **Total staked = 0.** Rewards go to dev (`test_rewards_go_to_dev_when_nothing_staked`). A late staker's snapshot starts at the current accumulator, so they earn nothing from earlier rewards (`test_staking_rewards_and_late_staker`).
- **Reentrancy.** Test USDC is a plain FA with no dispatch hooks, and Move forbids re-entering a module. All state is updated in the same function as the transfers, and there are no external callbacks.
- **Auth.**
  - Oracle: push is admin/keeper only. Keeper and staleness changes are admin only. Admin transfer is two-step.
  - Exchange admin functions: OI cap, pause, dev-fee withdrawal, two-step admin transfer.
  - `paper::mint_for_loss` and `deposit_rewards` are `public(friend)` (exchange only).
  - Test mint helpers are `#[test_only]`.
  - Each of these has negative tests.
- **Pause.** Pause blocks deposits and new positions only. Close, liquidation and withdrawal stay available, so the admin cannot trap funds by pausing.

## Known limitations / trust assumptions

1. **The oracle is fully trusted.** Admin and keepers can push any price within bounds, with no deviation check and no signature verification. A malicious keeper can liquidate everyone or pay themselves from the pool. User trading balances that are not in positions cannot be taken via the oracle; fix #1 closes the direct path to them.
2. **Stale-price arbitrage.** Opens and closes use the last pushed price, which can be up to `max_staleness` (default 60s) old. Traders who see the real market can trade against a lagging oracle. Mitigations would be frequent keeper pushes, a short staleness window, an open fee or spread, or a minimum hold time.
3. **The free option of high leverage plus discrete liquidation.** Losses are capped at margin, but profit is unbounded. At 1000x the liquidation distance is about 0.05%. Price moves between oracle pushes routinely jump past it, so a long+short straddle on the same market has positive EV against the pool. Possible mitigations: lower max leverage, a per-position profit cap (as a multiple of margin), a net-exposure limit per user (sybil-able), or open fees. Not implemented because the spec doesn't define one.
4. **A huge winner can monopolise the queue.** A queue entry can be as large as u64::MAX. Later inflows pay it first indefinitely. The per-market OI caps (default 50M notional per side) are the only brake.
5. **No liquidator reward.** Liquidation is permissionless, but the spec does not fund a reward. Keepers run by the house are expected to do it. Owners can close their own liquidatable position first and keep their remaining equity, which is at most the maintenance margin.
6. **A stale oracle halts closes and liquidations** (they abort). This is intended (no trading on stale prices), but it means keeper downtime freezes positions.
7. **No real LP shares.** `fund_pool` is a donation (no shares). The cap is enforced on donations, and loss inflows above 5M are swept to stakers. There is no LP withdrawal.
8. **The faucet is per-address, so it is sybil-able.** This is acceptable for a test token. The admin can mint unlimited test USDC.
9. **PAPER cannot be transferred or burned.** Minting stops silently once the u64 supply limit is reached.
10. **Direct transfers into the vault address are not tracked.** They become stuck surplus: `vault >= sum of buckets` still holds.
11. **The decay curve is a design choice.** The spec only says "decaying" above a 2M pool. Implemented as `100 * 2M / pool` PAPER per USDC, which is 50 at 4M and 40 at the 5M cap. The pool size used is the size *before* the loss is added.
