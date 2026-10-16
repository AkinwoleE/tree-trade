# Oracle manipulation risk — Tree Trade (2026-10-16, read-only analysis)

Reference exploit (Paper Trade, ~$1.28M): priced at the raw instant BBO mid of one external perp venue, with no
deviation check, no TWAP, no multi-source median and no OI caps. Attackers moved that venue's BBO with real orders while
holding large synthetic positions.

## Verdict: PARTIALLY VULNERABLE
Same *design class* (a single source, raw instant price, first-that-answers fallback). The on-chain move cap, the keeper
confirm step and the house-pool payout limit block the cheap one-shot version. Nothing prevents a slow walk.

## Where prices come from (as of this analysis)
| Layer | File | What it does |
|---|---|---|
| Source list | `web/src/lib/prices/index.ts` | `AutoPriceSource` = **first source that answers**, no comparison between sources |
| Primary | `DecibelSource` | `/decibel/api/v1/prices`, `mark_px ?? oracle_px ?? mid_px ?? price` (falls through to **mid** if mark is missing) |
| Fallback | `HyperliquidSource` (internal name only; never shown in the UI) | `allMids` = **raw instant mid of the book** |
| Keeper | `keeper/src/index.ts` | 10 s tick. A >2% (`MAX_PRICE_JUMP`) move vs the last push is held until a 2nd tick confirms it within 0.5% |
| Per-trade sig | `web/src/app/api/price-sig/route.ts` | Signs whatever `AutoPriceSource` returns **right now**. **No 2% check, no comparison with the on-chain price** |
| Chain | `move/sources/oracle.move` `check_move` | Signed price ≤10 s old (3 s skew). Move vs the stored price ≤ 0.5% + 0.1%/s elapsed, capped at 10% |
| OI | `exchange.move` + keeper `trailOiCaps` | Keeper caps = OI + **$1B** headroom per side. Default `DEFAULT_OI_CAP` = $50M/side when the caps lapse (900 s); the $20M figure applies only if it was set via `set_oi_cap` |
| Size | exchange | $1K–$10M notional, up to 1000x (so $10M takes $10K margin) |

**Live state right now:** the Geomi/Decibel key is blocked (MonthlyCredit). In `keeper.log`, 1,990 of the last 2,000 ticks used
the **external raw mid** (10 used Decibel). `/api/price-sig` falls back the same way. **So today Tree Trade is pricing exactly like
Paper Trade did: the raw instant mid of one external venue.**

## Is it cheap to move?
- External venue BTC book (live snapshot): about $0.16M at top of book, ~$0.78M within 1.3 bps, **~$4.2M within 2.5 bps** on one side.
  Pushing the mid 0.5% and *holding* it means sweeping far deeper, likely tens of $M with adverse fills. Expensive, but a
  2.5–5 bps nudge costs only a few $M of round-trip at small slippage. ETH is thinner.
- Decibel testnet book: couldn't measure (API blocked). Testnet books are typically thin (thousands of $). **If the key is
  restored and `mark_px` is ever missing, `mid_px` from a thin testnet book is trivially movable.** `mark_px` itself is
  oracle-derived and much harder to move.

## Attack economics (per trade, on-chain caps)
- Max position $10M at 1000x = $10K margin. A 0.5% move (the per-trade allowed jump) = **$50K profit**, minus the shrinking
  win cut (~74–88% kept) and the 2% fee, so about $40K.
- Slow walk: the cap grows 0.1%/s, so a sustained manipulation passes. The keeper's 2% gate only catches >2% jumps between ticks.
- OI: with $1B headroom, the caps never bind. An attacker can stack positions across accounts (the per-account limit is only
  per-position size), e.g. 10 × $10M = $100M, so a 0.5% move = $500K.
- **Real ceiling today: the house pool (~$12K).** Anything above that goes into the payout queue and is paid from future
  losses. So the present-day loss is bounded by pool cash, but **queue debt is unbounded** and on mainnet it would become a
  Paper-Trade-sized hole.
- Latency arb (separate issue): a sig is valid for 10 s and the user picks when to submit, so they can pick the better of
  several sigs. This is a small edge at 1000x.

## Mitigations (recommended order)
1. **Multi-source median + deviation rejection (off-chain, in `prices/index.ts`, used by both keeper and price-sig):**
   fetch Decibel `oracle_px`/`mark_px` (never `mid_px`), **Pyth Hermes** (`hermes.pyth.network/v2/updates/price/latest`, BTC/USD
   and ETH/USD feeds, respecting `conf`), and a backup (e.g. the external mid only as a 3rd vote). Use the median. Reject (503)
   if any two sources disagree by >0.3%, or if fewer than 2 are fresh. **Remove "first that answers".**
2. **Port the 2% guard to `/api/price-sig`:** refuse to sign when the price is >X% from the on-chain stored price (`oracle::price_info`).
3. **EMA/TWAP:** sign `min/max(EMA_30s, spot)` adverse to the trader (open long at max, close long at min), Pyth `ema_price` style.
4. **On-chain:** tighten to `base_move_bps` 10–20 and `move_bps_per_sec` 2 (via `set_guard_params`, no upgrade needed). Longer term,
   verify Pyth prices on-chain (Pyth Aptos `get_price_no_older_than`) instead of trusting our signer.
5. **OI caps sized to depth:** replace the $1B headroom with ~$5–10M/side (≈ the depth within 5 bps), and set the default cap to $20M.
6. **Per-account and aggregate notional limits:** e.g. ≤$10M open notional per account and ≤20% of the side cap. Add a cooldown on
   flipping the same market.
7. **Delayed / two-step fills:** commit the order, then fill at the first oracle price ≥N s later (N=2–5). This kills the pick-the-sig
   game and makes manipulation hold for N s.
8. **Profit cap per position** (e.g. ≤ X × margin, or ≤ % of pool) on mainnet.

## Recommendation
Implement **#1, #2, #5 now** (off-chain plus one admin call; low risk). Do #4's parameter tightening at the same time. Coordinate with
the API-cost worker, since they touch `keeper/src/index.ts` and the web price routes. Schedule #3, #6, #7 and on-chain Pyth before mainnet.

---
## Status update — 2026-10-16 05:58 (Lagos time)
| Fix | Status | Details |
|---|---|---|
| 1. Multi-source median | **DONE, live** | `web/src/lib/prices` `MedianPriceSource`/`aggregatePrices`, shared by the keeper and `/api/price-sig`. Sources: Decibel `oracle_px ?? mark_px` (never `mid_px`), Pyth Hermes (only if `PYTH_API_KEY` is set; Hermes requires a key since Aug 26 2026, and none is configured), the external perp mid, Coinbase spot, Kraken spot. 2.5 s timeout per source. Refuses if <2 fresh, if the agreeing set is not a strict majority, or if the agreeing set spreads >0.3%. A single outlier is outvoted and logged as `rejected=`. **Degraded mode now** (Decibel key blocked, so Decibel returns 429): median of perp mid + Coinbase + Kraken, so the perp venue alone can't move the price |
| 2. price-sig deviation check | **DONE, live** | `lib/price-guard.ts`: refuses (409) if the price is more than min(0.2% + 0.02%/s since the last on-chain push, 2%) from `oracle::price_info`. The on-chain read is cached 3 s and falls back to the anonymous fullnode. Fails closed (503) if there's no on-chain read |
| 4. On-chain guard | **DONE** | `set_guard_params(10, 3, 20, 2, 1000)` tx `0x80594f8d…9583`: 0.2% + 0.02%/s, 10% max. The keeper pushes every ≤30 s (≤0.8% allowed) and is passing. A >2% gap now takes ~90 s of catch-up (circuit-breaker behaviour) |
| 5. OI caps | **DONE** | Keeper headroom default $7.5M/side (`OI_HEADROOM_USD`). Live caps ≈ $7.5M/side (BTC ~91.8, ETH ~3,076). The on-chain default/fallback `oi_caps` is already $20M/side |
| 3, 6, 7, 8 | Open | EMA fills, per-account notional, delayed fills, profit cap. Before mainnet |

Verification on prod: a fresh sponsored account (registered in `internal-accounts.json`) opened and closed BTC via `/api/price-sig`
(txs `0x0e1d3540…c67b`, `0x483f6cd8…61ab`). A simulated keeper push +1% aborted with `E_PRICE_MOVE_TOO_LARGE`. Outlier and far-off
signing are covered by unit tests (`keeper/src/oracle-median.test.ts`, 8/8), because a source can't be faked on prod.
Residual: until Decibel or Pyth keys exist, 2 of 3 votes are CEX spot (perp/spot basis is usually <0.05%, well inside 0.3%).

---
## Update — 2026-10-16 06:30 (Lagos time), cost cut 8 (API-cost worker)
- Decibel price vote is wrapped in `CircuitBreakerSource` (`web/src/lib/prices`): on HTTP 429/401/403 or a credit/cap error it is
  **dropped from the median with no further requests** for 10 min, then one probe is sent. The pause doubles on each repeat cap,
  up to 1 h. It **re-enables automatically** on the first successful probe. Used by `/api/price-sig`, `/api/prices` and the keeper.
  The median rules above (≥2 fresh, strict majority, ≤0.3% spread) are unchanged. Unit test: `keeper/src/oracle-median.test.ts`.
- Note: at 06:12 another worker removed the Decibel key from `keeper/.env` and `web/.env.local` (backups `*.bak-decibelkey-0612`).
  The keeper runs without the Decibel vote until the key is put back. With the key restored, the breaker handles the cap on its own.
