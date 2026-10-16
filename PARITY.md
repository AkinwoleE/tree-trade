# Paper Trade ↔ Tree Trade mechanics parity

Snapshot taken **2026-10-15**. This compares the live Paper Trade protocol (papertrade.xyz, HyperEVM chain 999) with our
Aptos Move package in `move/sources` (`exchange.move`, `paper.move`, `oracle.move`) and `move/REVIEW.md`.
This is a research document only. No Move code was changed.

## Sources

| Tag | Source | Notes |
|---|---|---|
| **[D:page]** | `https://docs.papertrade.xyz/#/<page>`, e.g. [D:how/mint-curve] = <https://docs.papertrade.xyz/#/how/mint-curve> | The official docs. The site is a JS SPA with no sitemap or llms.txt. All 23 pages are embedded in `/assets/index-u2mlmHj8.js`, and the text was extracted from there. |
| **[API:trading]** | <https://exchange.papertrade.xyz/state/trading> | The official live backend that feeds the exchange UI (DefiLlama's adapters read the same host). Gives instrument tuples and minimums. Read at indexed block 48,589,715. |
| **[API:summary]** | <https://exchange.papertrade.xyz/query/protocol/summary> | Gives LP, queue, PAPER supply, `trackedLp`, `tailProgress` and curve constants. Same block. |
| **[API:house]** | <https://exchange.papertrade.xyz/state/house/current> | Gives open notional per side. |
| **[DL]** | DefiLlama `dimension-adapters/fees/papertrade.ts`, `helpers/papertrade.ts`; `DefiLlama-Adapters/projects/papertrade/index.js` | Event ABIs (`PositionsClosed`, `Liquidated` with `stakerFee`/`devFee`), the fee methodology, and the Exchange address `0x6cd5…D0a2`. DefiLlama lists **no GitHub repo** for Papertrade. |
| **[SDK]** | <https://github.com/nirholas/papertrade-sdk/blob/HEAD/docs/PROTOCOL.md> | **Third-party** SDK that claims to be "verified against mainnet". I use it only for the integer bust-price formula and the tuple field order, and I cross-checked both against [D] and [API]. |

Paper Trade's contract source is **not public**. The proxies point to the implementations `0x0f3f…49ee` (Exchange) and
`0x600d…f48f` (PaperTokenomics), and neither is verified on Sourcify. The docs cite `contracts/src/QueueLib.sol` and
`Exchange.sol`, but no public repo exists for them. Everything below comes from the docs plus live state.

### Live parameters read from [API:trading] / [API:summary]

| Param | BTC (id 0) | ETH (id 1) |
|---|---|---|
| maxLeverage | 1000 | 1000 |
| maxPosition (notional per position) | $10,000,000 | $10,000,000 |
| bustBuffer | 0.04760% (4.76 bps) | 0.04813% (4.81 bps) |
| baseRate / rateMultiplier / referenceNotional | 0.10 / 15,000 / $100,000 | 0.10 / 15,000 / $100,000 |
| positionMultiplier | 814.598 | 483.979 |
| OI long / cap (base qty) | 3,148.2 / 3,250.1 BTC (headroom ≈ 102 BTC ≈ $8.3M) | 45,011 / 48,913 ETH (headroom ≈ 3,902 ETH ≈ $9.2M) |
| OI short / cap | 2,372.4 / 2,468.8 BTC (≈ $7.8M) | 44,263 / 46,787 ETH (≈ $6.0M) |

Global values:

- `minimumTradeSizeRaw` = **$10** (minimum margin).
- `minimumOpenNotionalRaw` = **$1,000**. The SDK says $10,000, which is out of date.
- LP = trackedLp = **$4.986M**. Queue = **$0**, with 0 entries.
- PAPER supply = 7.66B and staked = 7.60B.
- Curve constants: `cliff` = $2M, `cap` = $5M, `rate` = 100, `decay` (S) = $120M.
- **`tailProgress` (H) = $168.2M.**
- Lifetime fees = $41.5M. TVL = $62.7M.

The tuple order is OI-long, OI-short, cap-long, cap-short. I inferred that order from the magnitudes, and it matches [API:house] notional.

### The "~22–23 PAPER per $1" report, explained

The live formula is `rate = 100 · (S / (S + H))²` per $1 of **mint basis**, with S = $120M [D:how/mint-curve]. On a
queue-empty losing close the mint basis is `loss × 0.98`. A rate of 22–23 per raw $ corresponds to H ≈ $128–136M, so the
trader's figure was correct a few days ago. **Today H = $168.2M, which gives 17.34 PAPER per $ of basis, or ≈ 17.0 PAPER per raw $1 lost.**
H only ever increases (it is a ratchet), so this rate keeps falling while the LP sits in the tail region. Today the LP is
at $4.99M, i.e. permanently above $2M, with the excess swept to stakers.

---

## Parity table

Status values:

- ✅ **match**
- 🟡 **deliberate difference**: a chain or testnet constraint, or a reasoned choice
- ❌ **gap**: diverges from Paper Trade without a good reason

| # | Mechanic | Paper Trade (cited) | Tree Trade today (`move/sources`) | Status |
|---|---|---|---|---|
| 1 | **Markets** | BTC and ETH. Instrument ids 0 and 1. New markets are added by the owner [D:learn/trades-pricing], [API:trading]. | BTC = 0 and ETH = 1, fixed by `oracle::NUM_MARKETS = 2`. | ✅ |
| 2 | **Leverage** | Integer leverage from 1 to 1000 per market (`maxLeverage` 1000 for both) [D:intro/faq], [API:trading]. | `MIN_LEVERAGE` 1, `MAX_LEVERAGE` 1000, one global value. | ✅ (one global value, not per market) |
| 3 | **Fill price** | The BBO mid `(bid+ask)/2`, read atomically from the HyperCore precompile in the execution block. No spread, no slippage, no funding. The oracle reverts only on a zero or crossed book [D:how/pricing-bbo]. | The keeper pushes HL `allMids` (the same mid) every ~10 s. The contract fills at the last pushed price if it is ≤ 60 s old (`DEFAULT_MAX_STALENESS_SECS`). No spread, no slippage, no funding. | 🟡 Aptos cannot read HL atomically. The 60 s staleness window is a ❌ risk (REVIEW #2), because PT fills at the current block price. |
| 4 | **Win settlement: deadband** | The gain is measured as if the exit were `entry/50000` (0.2 bps) worse. A gain smaller than that pays 0 [D:how/asymmetric-impact], [D:how/risk]. | None. The raw profit is paid. | ❌ **gap** |
| 5 | **Win settlement: asymmetric impact** | `adjusted = raw × (1−baseRate)/(1 + 1/(move·R) + Nref/(1e6·move·P))`, where `move` is taken after the deadband. BTC keeps ~74% of a 0.1% move and ~88% of a 1% move, and never more than 90% [D:how/asymmetric-impact]. Losses are not scaled. | None. | ❌ **gap. This is the biggest one.** It is PT's whole revenue model and its defence against jitter and straddles (REVIEW #3). |
| 6 | **Win fee** | 2% of the *adjusted* gain, so the trader keeps 98% [D:how/asymmetric-impact]. The fee is paid to stakers and dev only if the queue is empty and free LP cash covers it. Otherwise it is not paid out and the winner's queued claim is the net amount [D:how/solvency-queue]. | 2% of raw profit, rounded up, taken from the trader's net. The fee is paid from the pool only if the winner is paid in full. Otherwise the fee is waived and the queued amount is the net (`settle_profit`). | ✅ The logic matches. The fee base differs because there is no impact (see #5). |
| 7 | **Loss fee** | 2% carved from the *LP's gain*, not added to the trader's loss. **Charged only while the queue is empty.** While the queue is active, the fee is waived and the whole loss goes to `sideBucket` for queued payouts [D:learn/wins-losses], [D:how/solvency-queue]. | 2% of the loss (rounded down) goes to `distribute_fee` **always**, including while winners are queued. The remaining `loss−fee` goes to the pool (`settle_loss`). | ❌ **gap.** Stakers and dev get paid ahead of queued winners, which contradicts PT and the intent of REVIEW #5. |
| 8 | **Liquidation fee** | 2% of the forfeited margin while the queue is empty. Waived while the queue is active [D:learn/liquidations]. | 2% of margin, always charged. | ❌ Same gap as #7. |
| 9 | **Fee split** | 50% to stakers ("1% of PnL") and 50% to the dev fee recipient [D:learn/staking-dividends], [DL]. | `floor(fee/2)` to stakers and the rest to dev. If nothing is staked, the stakers' half goes to dev. | ✅ |
| 10 | **Notional fee, spread, funding, gas** | None. A relayer pays gas [D:intro/what-is-papertrade]. | None. The user pays APT gas. | ✅ / 🟡 (gas) |
| 11 | **Liquidation trigger** | A hard bust at a **price** trigger. The long zero-equity price is `p0 = ceil(e·(L−1)/L)` and `bust = floor(p0·(1+bustBuffer))`. The short version is mirrored. `bustBuffer` ≈ 4.8 bps of *price* (0.0476% for BTC, 0.0481% for ETH) [D:learn/liquidations], [API:trading], [SDK]. There is no maintenance-margin percentage. | Maintenance = `min(ceil(0.5% notional), ceil(margin/2))`. Liquidatable when `loss ≥ margin − maint` (`maintenance`, `is_liquidatable_at`). | ❌ **gap.** See the distance table below. We liquidate much earlier than PT from about 20x to 500x. |
| 12 | **Liquidation outcome** | The full isolated margin is forfeited, even if a close just before would have returned equity. PAPER mints on the full margin. The protocol keeper liquidates. There is no liquidator reward [D:learn/liquidations]. | The full margin is lost (`settle_loss(margin, margin)`). PAPER mints on the margin. Liquidation is permissionless and has no reward. | ✅ |
| 13 | **Min margin / min notional / max position** | Minimum margin $10. **Minimum notional $1,000.** **Maximum notional per position $10M** [API:trading], [D:intro/faq]. The market keeper can change the minimums [D:how/risk]. | `MIN_MARGIN` = 10 USDC. **No minimum notional** (1x × $10 = $10 is allowed). **No per-position maximum** (only the OI cap). | ❌ **gap** (both bounds) |
| 14 | **OI caps** | Independent long and short caps per instrument, in **base-asset quantity**. A trailing keeper sets each cap to current OI + headroom with a 10% hysteresis band. The docs give a $1B headroom target, but **live headroom is about $6–9M per side**. A market-keeper role owns the caps [D:how/risk], [API:trading]. | One cap per market, applied to each side, in **USDC notional at entry**. The default is 50M. Only the admin can set it (`set_oi_cap`). | ❌ Minor gap: there is no per-side cap and no keeper role. Notional vs quantity is 🟡. |
| 15 | **Position model** | Isolated, immutable slugs. No adding margin. Full close only [D:learn/trades-pricing]. | The same. | ✅ |
| 16 | **LP origin** | The LP starts at **$0**. **No one can deposit into the LP**. It grows only from user losses [D:learn/lp-queue], [D:intro/faq]. | The pool can be seeded through `fund_pool`, a donation with no shares that is capped at 5M + queue. 50k was seeded at deploy. | 🟡 A testnet bootstrap convenience. It should not count toward the mint curve (see #19). |
| 17 | **LP cap / excess to stakers** | Above **$5M tracked LP**, every further dollar of LP gain goes to stakers through a public `pushStakerFees()` that a keeper calls [D:paper/overview], [API:summary] `cap`. | Above `LP_CAP` = 5M, the pool is swept automatically to stakers on every inflow or crank, but only when the queue is empty (`sweep_excess`). | ✅ Same behaviour. Ours is push-on-inflow instead of a keeper. |
| 18 | **Payout queue** | FIFO of `(user, amount)` entries. Only the profit portion is queued, and margin is always returned. `lpBankrollAvailable()` is 0 while anything is queued. A permissionless `harvest(maxEntries)` runs, with the keeper calling `harvest(32)` every block. `sideBucket` earmarks losses for the queue [D:how/solvency-queue]. | FIFO table. Margin is always returned. New winners are not paid while the queue is non-empty. Each inflow automatically processes 16 entries, and the permissionless `process_queue` crank handles 1–200. Losses go to the pool and then straight into the queue. | ✅ Functionally equivalent. Our pool-to-queue drain is the same thing as `sideBucket`. |
| 19 | **PAPER mint rate** | A flat **100 PAPER per $1** of mint basis while `trackedLp < $2M`, including when it is negative. Above that the rate is **`100·(S/(S+H))²`**, with S = $120M and H = `tailProgress`. H is a **high-water-mark ratchet** of cumulative tail-region LP gain, and staker drains do not reduce it [D:how/mint-curve]. **Currently ≈ 17.3 per $ of basis.** | `100` per USDC while `pool < 2M`, otherwise `100 · 2M / pool`. Here `pool` is the live pool *before* the loss. The pool is capped and swept at 5M, so **the rate never drops below 40** and **it rises again** whenever the pool shrinks (`paper::mint_amount`). | ❌ **gap.** We mint ~2.3× PT's current rate, and our rate has no ratchet. |
| 20 | **PAPER mint basis** | Losing close with the queue empty: `loss − 2% fee`. Queue active: the full loss. Liquidation: the full margin, always [D:how/mint-curve]. | Always the full `loss` (the fee is not subtracted). Liquidation uses the full margin. | ❌ Minor gap (2%). Fixing #7 fixes this too. |
| 21 | **Tracked LP** | `trackedLpUsd` is a running P&L tally of the LP. It can go negative. Every loss credits it when it settles, including while the queue is active. Wins and staker drains debit it [D:learn/staking-dividends], [D:how/mint-curve]. | Not tracked. Only `pool` (cash) and `queue_owed`. | ❌ **gap** (needed for #19) |
| 22 | **PAPER token** | Supply starts at 0 with a fair launch. **Non-transferable at launch.** It can only be minted, staked and unstaked. ERC-20 with 18 decimals [D:paper/overview]. | Supply 0. A non-transferable table balance. Mint, stake and unstake only. 6 decimals (100 base units per USDC base unit = 100 PAPER/$). | ✅ |
| 23 | **Staking** | Instant stake and unstake. No lockup or cooldown. Pro-rata via `accRewardPerShare` (1e27 precision). Distribution is pushed by a keeper. Rewards are claimed to the exchange balance. PT has some minimum stake (error `below_minimum_paper_stake`, value unknown) [D:paper/staking], [SDK]. | Instant stake and unstake. Rewards are distributed on every fee (1e18 precision plus remainder carry). Claims go to the wallet. | ✅ / 🟡 (push vs immediate, claim destination) |
| 24 | **Deposit / withdraw minimums** | At least **10 USDC** for a deposit and **10 USDC** for a withdrawal [D:learn/deposits-withdrawals]. | Any amount above 0. | 🟡 Optional. |
| 25 | **Activation fee** | **1 USDC**, one time, on the first deposit. This covers HyperCore account activation, an infrastructure cost [D:learn/deposits-withdrawals]. | None. | 🟡 Deliberate. Aptos has no account-activation cost, so do not copy it. |
| 26 | **Trading pause** | `setTradingPaused` blocks opens on all markets while closes stay live. **Per-market retirement** freezes the BBO, is permanent, and lets positions close at the frozen price [D:how/pricing-bbo]. | `set_paused` blocks opens **and deposits**. There is no per-market freeze. A stale oracle blocks closes and liquidations (REVIEW #6). | ❌ Minor gap (retirement) |
| 27 | **Trading from queued balance** | You can open positions using your queued claim as margin ("debt-funded"). The rules for losses and liquidation are special [D:how/solvency-queue]. | Not supported. | 🟡 Defer. It is complex and matters only while a queue exists. |
| 28 | **Session keys / relayer** | 30-day session keys and 1-hour intents. The relayer batches intents and pays gas [D:learn/session-keys]. | Direct wallet transactions. | 🟡 Out of scope. Aptos fee-payer and orderless txns could approximate it. |
| 29 | **Builder codes** | Planned: 1% of the LP-revenue carve. Not live [D:how/builder-codes]. | None. | 🟡 N/A |
| 30 | **Governance** | A 7-day timelock owned by a 2-of-3 multisig, plus pause-guardian and market-keeper roles [D:dev/contract-addresses], [D:how/risk]. | A single admin with two-step transfer. | 🟡 Testnet. |

### Liquidation distance: adverse price move that triggers liquidation

PT uses `1/L − bustBuffer·(L−1)/L` with a BTC bustBuffer of 0.0476%. Ours uses `1/L − min(0.5%, 1/(2L))`.

| Leverage | Zero-equity move | **PT trigger** | **Tree Trade trigger** | Equity forfeited at trigger, PT | Equity forfeited at trigger, ours |
|---|---|---|---|---|---|
| 2x | 50% | 49.976% | 49.500% | 0.0% | 1.0% |
| 10x | 10% | 9.957% | 9.500% | 0.4% | 5.0% |
| 50x | 2% | 1.953% | 1.500% | 2.3% | **25%** |
| 100x | 1% | 0.953% | 0.500% | 4.7% | **50%** |
| 200x | 0.5% | 0.453% | 0.250% | 9.5% | **50%** |
| 500x | 0.2% | 0.153% | 0.100% | 23.8% | **50%** |
| 1000x | 0.1% | 0.052% | 0.050% | 47.6% | 50.0% |

Between 20x and 500x we liquidate at roughly half of PT's distance. Our UI liquidation price will therefore not match
what PT users expect.

### Impact haircut: share of raw gain kept before the 2% fee

These are computed from PT's formula with the live parameters and include the deadband.

| Move | 0.05% | 0.1% | 0.2% | 0.5% | 1% | 5% |
|---|---|---|---|---|---|---|
| BTC | 62.0% | 73.9% | 81.3% | 86.4% | 88.1% | 89.6% |
| ETH | 55.1% | 69.0% | 78.3% | 85.0% | 87.4% | 89.5% |

---

## Recommended Move changes

### How safe each change is as a compatible upgrade

The package is live on testnet (`DEPLOYMENT.md`, `0xadb6…d3e9`) with the default `compatible` policy. The rules that apply:

- You **may** change constants, function bodies, private and `public(friend)` signatures, and error codes. You may also add new functions, structs and resources.
- You **may not** add, remove or reorder fields of existing structs. That includes `Exchange`, `Position`, `QueueEntry`, `PaperState`, `Account` and **all event structs**. You may not change the signatures of `public` or `entry` functions, and you may not remove them.
- **`init_module` does not run again on upgrade.** New state must go in a new resource (for example `exchange::ParamsV2 has key` at `@papertrade`). That resource is created by a one-time admin entry function such as `init_v2(admin)`, and code must check `exists<ParamsV2>(@papertrade)` and fall back to the old behaviour until then. The other option is to hard-code the parameters as constants, which needs no new state.
- Off-chain mirrors must change in the same release: `web/src/config/contract.ts`, the PnL/liquidation helpers in `web/src/lib/` and the keeper. I have not touched them.

### P0: asymmetric impact plus deadband on winning closes (#4, #5)

This is PT's only source of revenue on wins and its main protection against jitter and straddles. Our design is more
exposed than PT's because of the stale-price window (REVIEW #2, #3).

In `close_position`, before `settle_profit`:
```move
// deadband: entry/50000 (0.2 bps), integer like PT
let db = entry / 50_000;
let gain = (if (pos.is_long) exit - entry else entry - exit);   // only when profitable
if (gain <= db) profit = 0 else {
    let g = (gain - db as u256);                 // price units
    let e = (entry as u256);
    // move = g/e. scale = (1-b) / (1 + e/(g·R) + Nref·e/(1e6·g·P))
    // Multiply through by g·R·P·1e6 (P scaled ×1000 → P_k):
    // adjusted = notional·g/e · (1-b)·g·R·P_k·1e6
    //            / (g·R·P_k·1e6 + e·P_k·1e6 + Nref·e·R·1000)
    ...
}
```
- Parameters: `BASE_RATE_BPS = 1000`, `RATE_MULT = 15_000`, `NREF_USD = 100_000`, and `POS_MULT_K` = `[814_598, 483_979]` (×1000) for BTC and ETH.
- Use u256 throughout. The worst case is `notional·g²·R·P_k·1e6` ≈ 1.8e22·1e36·1.5e4·8e5·1e6 ≈ 2e80. That **overflows u256**, so divide in stages: compute `num1 = notional·g/e` first, which is at most about 1.8e40, and then apply the scale ratio. Round down, in the pool's favour.
- Report the adjusted gain in the existing `PositionClosed.pnl`, and add a new event `WinImpact { id, raw_profit, deadband, adjusted }`. Existing event structs cannot gain fields.
- **Upgrade-safe: yes.** It changes a private function body and adds constants and a new event. For tunable parameters, use a new `ImpactParams has key` resource behind `init_v2`.

### P0: PT-style price-buffer bust instead of 0.5% maintenance (#11)

Replace the body of `is_liquidatable_at` with a price comparison:
```move
// BUST_BUFFER_WAD = 476_041_580_087_574 (BTC), 481_304_050_180_130 (ETH), 1e18 = 100%
long : p0 = ceil(e*(L-1)/L);  bust = floor(p0*(1e18+buf)/1e18);  liquidatable iff price <= bust
short: p0 = floor(e*(L+1)/L); bust = ceil(p0*(1e18-buf)/1e18);   liquidatable iff price >= bust
```
- Return `bust` from `liquidation_price`. Its body changes but its signature stays the same. Delete `maintenance()` and `MAINT_BPS`.
- At 1x long, p0 = 0, so the position can never be liquidated. That is correct, because the loss is capped at margin.
- **Upgrade-safe: yes.** These are a private function body, a view body and constants. Positions that are already open immediately get PT's (looser) triggers. That only helps users.
- The keeper and web must switch to the same integer formula. REVIEW #4's design note goes away, because the price buffer is valid at every leverage.

### P0: PT mint curve with tracked LP and a tail ratchet (#19, #20, #21)

Add a new resource in `paper` (the code is friend-written by `exchange`):
```move
struct MintCurve has key {
    tracked_lp_mag: u128, tracked_lp_neg: bool, // signed running LP P&L (USDC base units)
    tail_progress: u128,                        // HWM, never decreases
    flat_threshold: u128,                       // 2_000_000e6
    decay_scale: u128,                          // 120_000_000e6
}
```
- `mint_for_loss(user, basis)`: if `tracked_lp < threshold`, then `rate = 100`. Otherwise `rate = 100·S²/(S+H)²`. Compute it as `basis·100·S²/(S+H)²` in u256 and round down. Then call `on_lp_gain(basis)`.
- `on_lp_gain(x)`: `tracked += x`. Advance `tail_progress` by the part of the gain that lands at or above the threshold. Use `max(0, tracked_after − max(tracked_before, threshold))` when crossing up, or `x` when already above.
- `on_lp_loss(x)` is called for wins paid or queued (the trader's net) and for staker sweeps: `tracked −= x`. This **never touches `tail_progress`**.
- `fund_pool` donations are **not** counted. PT has no deposits.
- `mint_for_loss` is `public(friend)`, so its signature may change. Keep `paper::mint_amount(loss, pool)`, because it is a `public` view, but treat its second argument as legacy or ignore it. Add new views `mint_rate()`, `tracked_lp()` and `tail_progress()`.
- Mint basis must follow PT: `loss − fee` on a queue-empty losing close, `loss` while the queue is active, and the full margin on liquidation.
- Initialization: `paper::init_curve(admin)` runs once. Seed `tracked_lp` with the current `pool − queue_owed` (or 0 for a clean PT-like start) and `tail_progress` with 0. Until the resource exists, fall back to the old formula.
- Optionally seed `tail_progress` from PT's live value ($168M → ~17/$) for exact rate parity. I don't recommend that, because PT's H comes from PT's volume. Start at 0 and let our own volume drive it.
- **Upgrade-safe: yes** (new resource, friend signature, new views). `PaperMinted` keeps its fields, so `pool_balance` should now carry `tracked_lp` clamped at 0, or add a new `PaperMintedV2` event.

### P1: waive loss and liquidation fees while the queue is non-empty (#7, #8)

In `settle_loss`, after the minimal fix:
```move
let queue_active = ex.queue_head != ex.queue_tail;
let fee = if (queue_active) 0 else loss * FEE_BPS / BPS;
```
The whole `loss` then goes through `pool_inflow`, which drains the queue first. This is exactly PT's `sideBucket`
behaviour. Passing `loss − fee` as the mint basis also fixes #20. **Upgrade-safe: yes** (a private body).

### P1: minimum notional and maximum position (#13)

- Add `MIN_NOTIONAL: u128 = 1_000_000_000` ($1,000) and `MAX_POSITION_NOTIONAL: u128 = 10_000_000_000_000` ($10M).
- Assert both in `open_position`, with new error codes `E_NOTIONAL_TOO_SMALL` and `E_POSITION_TOO_LARGE`.
- These match the live PT values. `MIN_NOTIONAL` also blocks dust positions at low leverage, which add gas and state for nothing.
- **Upgrade-safe: yes** (constants and an entry body; the signature is unchanged). The web trade panel needs the same limits.

### P1: tighten the oracle window (#3)

- PT fills at the current block's mid. We fill at a price up to 60 s old, which is a free option against the pool (REVIEW #2).
- Call `oracle::set_max_staleness(admin, 15)` (or lower) and push every 2–3 s.
- Better: let opens and closes optionally take a fresh signed HL mid, or add a new `exchange::open_position_v2`.
- Note: the impact curve (P0) only partly mitigates this. PT relies on atomic prices *plus* the curve.
- **Upgrade-safe: yes.** It is an admin call or keeper config, with no code change.

### P2: per-side OI caps and a market-keeper role (#14)

- Add a new resource `OiCapsV2 { long_caps: vector<u64>, short_caps: vector<u64>, market_keeper: address }`.
- Add a new entry `set_side_caps(keeper, market, long_cap, short_cap)`, callable by the admin or the market keeper.
- `open_position` checks the per-side cap when `OiCapsV2` exists. Otherwise it uses `oi_caps`.
- Run a keeper policy like PT's: cap = OI + headroom with 10% hysteresis. The live PT headroom is about $6–10M per side, and that is a reasonable default here, given our pool is ≤ $5M. The existing `oi_caps` vector stays for compatibility.
- **Upgrade-safe: yes** (a new resource and a new entry).

### P2: per-market retirement with a frozen price (#26)

- Add a new resource `Retired { frozen: Table<u8, u64> }` and an admin entry `retire_market(m)`. The entry snapshots `oracle::get_price(m)`.
- `open_position` aborts on a retired market. `close_position` and `liquidate` read the frozen price instead of the oracle. Retirement is permanent.
- This also removes REVIEW #6 ("a stale oracle freezes positions") for retired markets.
- Optionally, make `set_paused` stop blocking deposits, to match PT's opens-only gate.
- **Upgrade-safe: yes.**

### P3 (optional) and things deliberately not copied

- **10 USDC minimum for deposit and withdraw (#24).** Constants only, and upgrade-safe. If you adopt it, allow withdrawing the full balance when it is below 10 so dust is never stranded.
- **Activation fee (#25).** Do not copy it. It is a HyperCore cost, not protocol economics.
- **Debt-funded opens (#27).** Defer. They would need a new `DebtPositions` table keyed by position id, because `Position` cannot gain a field. They also need PT's special close and liquidation accounting.
- **`fund_pool` (#16).** Keep it for the testnet bootstrap. It must not count toward `tracked_lp` or `tail_progress`. To match PT strictly, it could be restricted to the admin.

---

## Summary of key gaps (by impact)

1. **No asymmetric impact and no 0.2 bps deadband on wins (#4, #5).** PT's haircut takes at least 10% of every winning gain before the 2% fee: 12% on a 1% BTC move, 26% on a 0.1% move, and close to 100% on tiny moves. We pay the raw gain minus 2%. That is PT's entire revenue model and its anti-jitter defence. Without it, and with a pushed oracle up to 60 s stale, our pool bleeds to straddles and stale-price trades.
2. **The liquidation rule differs (#11).** PT uses a price-buffer hard bust of about 4.8 bps. We use a maintenance margin of `min(0.5% notional, 50% margin)`. Between 20x and 500x we liquidate at about half of PT's price distance; at 100x, for example, we trigger at a 0.50% move where PT triggers at 0.95%. The fix is a small body-only change.
3. **The PAPER mint curve is wrong (#19, #21).** PT uses `100·(S/(S+H))²` with S = $120M and a **ratcheting** `tailProgress` H. That is about **17.3 PAPER per $ today** (H = $168M); the reported 22–23 PAPER/$ matched H ≈ $130M a few days ago. Our curve is `100·2M/pool`, uses a pool that is swept at 5M, so it **never decays below 40/$**, and it rises again as the pool shrinks. It needs a tracked-LP and HWM resource.
4. **Loss and liquidation fees are charged while winners are queued (#7, #8, #20).** PT waives them so queued winners come first. The mint basis should also be net of fee when the queue is empty.
5. **Missing open bounds (#13).** PT enforces a $1,000 minimum notional and a $10M maximum notional per position. We have neither.
6. **Smaller gaps:**
   - Single-value OI caps with no keeper role. PT uses trailing per-side caps with only about $6–10M headroom live.
   - No per-market retirement with a frozen price.
   - The 60 s oracle staleness window.

**Every recommended change can ship as a compatible upgrade.** It needs only constants, function-body changes, friend-signature changes, and new resources, entries, views and events.
No existing struct or event layout and no public or entry signature has to change. New state needs a one-time
`init_v2` admin call after publishing, because `init_module` does not run again.

## Page inventory (Paper Trade app vs Tree Trade)

Source: the live app at https://exchange.papertrade.xyz (rendered headless on 2026-10-15) and the docs sidebar at https://docs.papertrade.xyz/.

| Paper Trade page | URL | What it shows | Tree Trade page | Notes |
| --- | --- | --- | --- | --- |
| Trade | `/trade/btc` (`/trade/eth`) | Price chart (toggles for trades / entries / busts), long/short ticket with leverage presets up to 1000x, account equity, tabs: Positions, History, Leaderboard, Status | `/trade/btc`, `/trade/eth` | Chart (lightweight-charts, 1m–1d) with entry and liquidation lines; tabs Positions / History / Leaderboard / Status (house pool + queue); trade ticket, account, Hedge panel |
| Portfolio | `/portfolio` | Open PnL, notional, margin; PAPER balance/staked/claimed/claimable; equity, historical PnL, volume; tabs Open Positions, Trade History, Deposits/Withdrawals, Staking, Open Queue | `/portfolio` | Same cards and tabs, SEEDS naming. No equity-over-time chart yet; no leaderboard badges |
| House | `/house` | Open interest by market (long/short/net), open margin, open positions; PAPER supply/staked/staker rewards; house funds, LP balance, open house PnL, queue debt | `/house` | Same sections; open house PnL (mark-to-market of all positions) not computed yet |
| Paper (staking) | `/staking` | Claimable rewards, staked, wallet balance; rewards claimed, stake share, total staker rewards, reward rate, supply, staked supply, stake ratio, contracts | `/seeds` | Same, named SEEDS |
| Leaderboard | `/leaderboard` | Positions / Accounts views; 24h / 7d / 30d / All; usernames | `/leaderboard` | Positions / Accounts, same windows. Usernames not implemented |
| Dashboard | `/dashboard` | Customizable widget layout (user positions, PAPER, house stats; export/import layouts) | `/dashboard` | Fixed all-in-one layout (the original Tree Trade screen). Custom layouts not implemented |
| Stats | `/stats` | Totals (volume, liq. volume, trades, users, rewards, TVL) and time-series charts | `/stats` | Same totals and cumulative charts, computed from on-chain events (most recent activity window) |
| Docs | docs.papertrade.xyz (Intro, How it works, How it actually works, LP, $PAPER, Developer reference) | Mechanics docs | `/docs` | In-app docs mirroring the "Intro" and "How it works" sections for Tree Trade's actual rules, plus Hedge and Risk |
| Deposit / Withdraw modals, language switch, "UwU mode", global trade notifications | header | | Account panel (faucet, deposit, withdraw) | Language switch, notifications and cosmetic modes not implemented |

Data sources for history, leaderboard and stats: `web/src/app/api/activity/route.ts` reads our package's transactions from the Aptos indexer (`user_transactions`, bounded from the publish version because the events table is deprecated and unbounded scans time out) and decodes their events from the fullnode. It keeps the latest 150 transactions per entry function, so totals cover recent activity, not all time, once volume grows; a dedicated indexer would be needed for full history.
