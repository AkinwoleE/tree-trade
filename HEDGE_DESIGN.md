# Tree Trade Hedge: design

**Hedge** lets a Tree Trade user mirror a Tree Trade position with an opposite-side position on
**Decibel testnet**, sized to offset its exposure. The Decibel side is closed or adjusted when the Tree Trade
position closes or is liquidated. The user keeps custody throughout. The hedger service trades only on a Decibel
Trading Account the user owns, and only after the user has delegated scoped, expiring permission to it.

Status: implemented and run end to end on testnet (see [Verification](#verification)).

---

## 1. Research findings

### 1.1 Doc pages relied on

| Topic | Page |
| --- | --- |
| Account tiers (Login Wallet / API Wallet / Trading Account); the three kinds of key; integration layers | https://docs.decibel.trade/quickstart/concepts |
| Client API key (Geomi) is required for REST GETs | https://docs.decibel.trade/quickstart/node-api-key, https://docs.decibel.trade/api-reference/rest/authentication |
| Writes are signed on-chain transactions | https://docs.decibel.trade/quickstart/authenticated-requests |
| SDK: `DecibelReadDex` / `DecibelWriteDex`, "nodeApiKey required" | https://docs.decibel.trade/typescript-sdk/overview, https://docs.decibel.trade/typescript-sdk/configuration |
| `placeOrder`, `createSubaccount`, `deposit`, `delegateTradingToForSubaccount`, `revokeDelegation`, `accountOverride`, submission failures | https://docs.decibel.trade/typescript-sdk/write-sdk |
| Gas, `skipSimulate`, time sync | https://docs.decibel.trade/typescript-sdk/advanced |
| `create_new_subaccount` | https://docs.decibel.trade/developer-hub/on-chain/account-management/create-subaccount |
| `delegate_all_trading_to_for_subaccount` (expiry `Option<u64>`) | https://docs.decibel.trade/developer-hub/on-chain/account-management/delegate-trading |
| `revoke_delegation` | https://docs.decibel.trade/developer-hub/on-chain/account-management/revoke-delegation |
| `deposit_to_subaccount_at` | https://docs.decibel.trade/developer-hub/on-chain/account-management/deposit |
| `place_order_to_subaccount`, TIF (GTC/PostOnly/IOC), reduce-only, `client_order_id` ≤ 32 bytes, tick/lot/min constraints | https://docs.decibel.trade/developer-hub/on-chain/order-management/place-order |
| Package address, market address derivation | https://docs.decibel.trade/developer-hub/on-chain/overview/contract-reference |
| px/sz decimals, `tick_size`, `lot_size`, `min_size`, price band, market `mode` | https://docs.decibel.trade/developer-hub/on-chain/overview/formatting-prices-sizes, https://docs.decibel.trade/developer-hub/on-chain/overview/market-parameters |
| Async execution ("ticket to the queue"), lazy continuous funding, reduce-only never flips | https://docs.decibel.trade/quickstart/typescript-starter-kit (Part 2) |
| Builder codes (not used; see §9) | https://docs.decibel.trade/quickstart/builder-codes, https://docs.decibel.trade/developer-hub/on-chain/builder-fee/approve-max-builder-fee |
| Fees: tier 0 perps 0.045% taker / 0.015% maker | https://docs.decibel.trade/for-traders/fees |
| Funding: premium + clamp(interest 0.03%/day − premium, ±0.15%/day), hourly presentation, realized on reduce/close | https://docs.decibel.trade/for-traders/funding-rates |
| Margin: IM = 1/leverage, MM = 1/(2·max leverage), cross by default | https://docs.decibel.trade/for-traders/margin |
| Liquidation stages | https://docs.decibel.trade/for-traders/liquidations |
| SDK source and types | `keeper/node_modules/@decibeltrade/sdk@0.8.2/dist` (`constants.js`, `base.js`, `write.js`, `read/*`, `gas/resolve-max-gas-amount.js`) |
| Aptos: wallet adapter `signAndSubmitTransaction`, `groupAndSortWallets` | https://aptos.dev/build/sdks/wallet-adapter/dapp |
| Aptos: module events; Indexer recommended for reads | https://aptos.dev/network/blockchain/events |
| Aptos: indexer tables (`user_transactions`, `current_objects`; deprecated list) | https://aptos.dev/build/indexer/indexer-api/indexer-reference |
| Aptos: objects (`object::is_owner`), fungible assets (`primary_fungible_store`) | https://aptos.dev/build/smart-contracts/objects, https://aptos.dev/build/smart-contracts/fungible-asset |

### 1.2 What the testnet probe established

`keeper/src/hedge/probe.ts` ran against Decibel testnet with box-generated accounts (an "owner" standing in
for a user, and a "hedger"). Each was funded with 0.3 APT from the deployer. No Geomi key was used. Full output
is in `keeper/hedge-probe.log`.

| # | Question | Result | Evidence (testnet tx) |
| --- | --- | --- | --- |
| 1 | **Docs/SDK testnet package is stale.** The docs (contract-reference) and SDK 0.8.2 `TESTNET_CONFIG` name `0xe7da…1b7f`. | That account has **no modules**. The live package, from testnet-app.decibel.trade's bundled config (fetchedAt 2026-10-08), is **`0xd368b820fdfbfe004679cdb0facef4b920c4fc0c2c80bd2fecf3843a93427bd1`**. We override `deployment` but derive every address with the SDK's own helpers (`keeper/src/hedge/decibel-config.ts`). | `GET /v1/accounts/0xe7da…/modules` → `[]` |
| 2 | Does REST need a Geomi key? | **Yes.** Anonymous `GET /decibel/api/v1/markets` returns 401 *"anonymous requests are not allowed"*, even with an `Origin` header. | — |
| 3 | **Is fullnode-only writing feasible?** | **Yes.** All SDK writes (`createSubaccount`, `deposit`, `configureUserSettingsForMarket`, `placeOrder`, `revokeDelegation`) went through the anonymous public fullnode with no `nodeApiKey`. The docs' "required" note concerns rate limits, not authorization. The anonymous limit is **40,000 compute units per 5 minutes per IP**, shared with the keeper. We hit it once during exploration, so a Geomi node key is recommended for production. | see rows below |
| 4 | **Can reads avoid REST?** | **Yes.** Market parameters (`perp_engine::market_sz_decimals/lot_size/min_size/ticker_size/max_leverage/min_price/max_price`), `get_mark_price`, `view_position`, `get_position_unrealized_funding_cost`, `get_cross_total_collateral_value`, `get_remaining_size_for_order` and `dex_accounts::view_delegated_permissions` are all `#[view]` functions. | — |
| 5 | testnet USDC | `usdc::restricted_mint` works (owner got 1,000 available, minted 250). It is **once per account per day** (`available_restricted_mint_for` drops to 0, and `restricted_mint_daily_reset_timestamp_for` is +24 h). | mint `0x3837089b…5d5d` |
| 6 | Create Trading Account | SDK `createSubaccount` → `create_new_subaccount`. Its address comes from `SubaccountCreatedEvent.subaccount`. The subaccount is an **object owned by the wallet** (`ObjectCore.owner`). | `0x447925da…b2e3` |
| 7 | Deposit | SDK `deposit` → `deposit_to_subaccount_at`, 50 USDC | `0xc370797f…42fa` |
| 8 | **Scoped delegation (preferred path).** The live ABI has `delegate_perp_trading_to_market_for_subaccount(subaccount, delegate, market, Option<u64> expiry)`, which is narrower than the documented `delegate_all_trading_to_for_subaccount` and is not wrapped by SDK 0.8.2. | Works. `view_delegated_permissions` shows `TradePerpsOnMarket{BTC}` → `UnlimitedUntilVia{authorized_by: owner, expiration_time_s}`. | `0xbb040f5e…9da2` |
| 9 | **Hedger trades the user's account** | `DecibelWriteDex(hedger).placeOrder({subaccountAddr: owner's sub, IOC})` was accepted and filled asynchronously (−0.0001 BTC). | `0x1cc37ec5…c599` |
| 10 | Scope enforced | The hedger's ETH order (not delegated) aborts with `ENOT_SUBACCOUNT_OWNER_OR_LACKS_PERP_TRADING_PERMISSIONS(0x3)`. | simulation |
| 11 | **Funds are safe** | The hedger's `withdraw_from_cross_collateral` aborts with `ENOT_SUBACCOUNT_OWNER(0x1)`. | simulation |
| 12 | Reduce-only close by the hedger | Accepted. The fill landed a few seconds after the transaction (the probe read too early and logged FAIL; the position was 0 when re-read). | `0xe29ae57c…c24a` |
| 13 | Revocation | SDK `revokeDelegation`. The hedger's next order aborts with 0x3. | `0x39fa5e83…e1c9` |

**Conclusion.** The preferred design works on testnet without any key from the owner. The user consents
on-chain with a per-market, expiring delegation, and the hedger service trades only those markets on the user's
Trading Account and can never move funds. The fallback ("user signs every hedge order in the wallet") is not
needed.

### 1.3 SDK quirks found by reading its source

* **Gas reservation.** With simulation on, `BaseSDK.sendTx` builds with
  `maxGasAmount = max(2 × simulated max gas, 250_000)` (`gas/resolve-max-gas-amount.js`). The simulation estimates
  the maximum the balance can afford, so a low-balance service account fails with
  `INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE`. We construct `DecibelWriteDex` with `skipSimulate: true`. That falls
  back to the SDK's own `defaultMaxGasAmount = 250_000` (0.25 APT reserved at 100 octas, refunded down to the
  ~250 units actually used).
* **ts-sdk v7** (an SDK peer dependency) raised `DEFAULT_MAX_GAS_AMOUNT` to 2,000,000, so every plain
  `build.simple` now reserves 2 APT. The keeper, the E2E scripts and the prune transaction set `maxGasAmount`
  explicitly.
* **No order status without REST.** `OrderStatusClient` and the `userOrders` readers are REST-only. The fullnode
  equivalent is `perp_engine::get_remaining_size_for_order(market, order_id)`: it is > 0 while the order rests or
  is queued, and 0 once it has filled or been cancelled.
* **`placeOrder` swallows errors** into `{success:false, error}`. Version 0.8.2 does not return the `submission`
  provenance described in the docs, so the hedger treats every failure as "maybe submitted" and backs off before
  re-reading state (§6).
* The web app cannot import the SDK: it peers on ts-sdk ^7 while `@aptos-labs/wallet-adapter-react` 8.x peers on
  ^5. The web app derives addresses with ts-sdk's `createObjectAddress` exactly as the SDK does, and
  `keeper/src/hedge/hedge.test.ts` asserts they match the SDK's helpers.

---

## 2. Architecture

```
 browser (wallet adapter)                         box
 ┌───────────────────────────┐   /api/hedge/status   ┌──────────────────────────────┐
 │ Trade panel: hedge toggle │ ◄──────────────────── │ web (Next, :3000)            │
 │ Positions: status, net Δ  │                       │  reads keeper/hedge-state.json│
 │ Hedge panel: Decibel setup│                       └──────────────────────────────┘
 └─────┬───────────┬─────────┘                       ┌──────────────────────────────┐
       │ user-signed txs                             │ hedger (keeper/src/hedge)     │
       │           │                                 │  run-hedger.sh restart loop   │
       ▼           ▼                                 │  every 15 s: reconcile        │
 ┌────────────┐ ┌───────────────────────────┐ views  │  writes hedge-state.json      │
 │ papertrade │ │ Decibel dex_accounts_entry│◄───────┤  signs: placeOrder (delegate) │
 │ ::exchange │ │ create / deposit /        │ orders │         hedge::prune          │
 │ ::hedge    │ │ delegate_perp_trading_to_ │◄───────┤                               │
 │ (requests) │ │ market / revoke           │        └──────────────────────────────┘
 └────────────┘ └───────────────────────────┘
       ▲ views: active_requests, get_position, position_exists
       └──────────────────────────────── hedger
```

* **On-chain intent: `papertrade::hedge`** (new module, compatible upgrade
  `0x31aa87a71749db797c4a76ea38b012e113ad24ad2b9ee319864cd6ce6641e9e4`; `exchange` unchanged).
  * `open_position_hedged(market, is_long, margin, leverage, subaccount)` is `exchange::open_position` plus a
    request, in **one** wallet signature.
  * `request_hedge(id, subaccount)` hedges an already open position; `cancel_hedge(id)` stops hedging (owner only).
  * `prune(id)` is permissionless once the position no longer exists. The hedger calls it after flattening.
  * Requests are checked on-chain: the signer must own the position, and the subaccount must be an object owned by
    the signer (`object::is_owner`). A user therefore cannot point a hedge at someone else's delegated Trading
    Account.
  * `active_requests()` returns every request in one view, so the hedger needs no event indexing. (The indexer
    `events` table now returns *"Request for Deprecated Resource: events"*, which also breaks
    `aptos.getModuleEventsByEventType`.)
* **Trading authority** comes only from Decibel's own delegation on the user's Trading Account. The hedger acts
  when both a request and a live delegation exist.
* **Hedger service** (`keeper/src/hedge/hedger.ts`): a separate process with its own supervisor
  (`run-hedger.sh`), log (`hedger.log`) and single-instance lock. `DecibelClient` is pluggable:
  * `LiveDecibelClient`: SDK `placeOrder` for writes, fullnode views for reads.
  * `MockDecibelClient`: in-memory, with async fills, partial fills and injectable failures. It is used when
    `HEDGER_PRIVATE_KEY` is unset or with `--mock`.

## 3. Consent and delegation flow (Hedge panel)

All steps are signed by the user in their own wallet through `useWallet().signAndSubmitTransaction`. The box
never sees a user key.

1. **Trading Account:** pick one or create a dedicated one (`create_new_subaccount`; the address is read from
   `SubaccountCreatedEvent`). Existing ones are discovered with the documented indexer table `current_objects`
   (objects the wallet owns), filtered to objects holding `dex_accounts::Subaccount`.
2. **Collateral:** `usdc::restricted_mint` (testnet, once per day), then `deposit_to_subaccount_at`.
3. **Per market:** set cross margin and leverage with `configure_user_settings_for_market`, capped at the market's
   `max_leverage`. Then **Allow** with
   `delegate_perp_trading_to_market_for_subaccount(sub, HEDGER, market, now + 1/7/30 days)`. The panel shows
   delegation scope and expiry, and flags any extra permission (for example `SubaccountFundsMovement`) as "not
   needed".
4. **Revoke** at any time with `revoke_delegation(sub, HEDGER)`.
5. When opening a position, the **Hedge on Decibel** toggle sends `hedge::open_position_hedged`. Already open
   positions have a *hedge* or *unhedge* action.

## 4. Sizing math

A Tree Trade position with notional `N = margin × leverage` (USDC) opened at oracle price `E` has PnL
`N·(P−E)/E = Q·(P−E)`, so its delta is a **constant `Q = N/E` base units**. The hedge is `−Q`, not "current
notional", which would drift as the price moves.

All arithmetic is bigint in chain units (`web/src/lib/hedge.ts`, shared by the web preview and the hedger):

```
units_i  = N_raw · 10^(8−6) · 10^sz_decimals · PREC / E_raw            (PREC = 1e6 extra precision)
target   = −Σ sign_i · units_i  over the open, hedge-requested positions of one (Trading Account, market)
target   = sign · round_half_up(|target| / (lot_size·PREC)) · lot_size  # rounded once, on the aggregate
delta    = target − actual                                              # actual = on-chain Decibel position
```

* **Lot and min size.** Rounding the aggregate, rather than each position, keeps the error to ≤ ½ lot per
  market. A `delta` below `min_size` is not traded (`below-min`). A residual below `min_size` when the target is
  flat is reported as **dust**, because Decibel rejects orders below `min_size`.
* **Reduce-only** is used only for pure reductions (`|delta| ≤ |actual|`, opposite sign), so it can never flip. A
  crossing order is a normal IOC.
* **Price:** IOC limit at mark ± `HEDGE_SLIPPAGE_BPS` (default 100 = 1%), rounded side-safe (buys down, sells up,
  like the SDK's `roundToTickSizeForSide`) and clamped into `[min_price, max_price]`.
* Live testnet parameters: BTC/USD `sz 9, lot 10,000 (0.00001), min 20,000 (0.00002 ≈ $1.6), tick $1, max 40x`;
  ETH/USD `sz 8, lot 10,000 (0.0001), min 50,000 (0.0005 ≈ $1.2), tick $0.1, max 20x`.
* Example (E2E): a 20 USDC × 10x BTC long at $81,300 → Q = 0.0024600 BTC → hedge **SHORT 2,460,000 units**.

## 5. Leverage, fees and funding (preview)

* **Leverage.** Tree Trade allows 1000x; Decibel caps BTC at 40x and ETH at 20x. The hedge's collateral is
  `notional / L`, where L is the user's per-market Decibel leverage (default `min(10, max)`). A 10 USDC × 1000x
  position therefore needs about $250 on Decibel at 40x. The trade panel shows this against the Trading Account's
  collateral and warns when it is short.
* **Fees.** Tier-0 taker 0.045% on open plus close = `2 × notional × 0.00045`. IOC orders are always taker.
* **Funding.** Without a Geomi key the live rate (REST `asset_contexts`) is unavailable, so the preview shows the
  documented baseline interest component, 0.03%/day (longs pay shorts when the premium is ~0). It is labelled as
  an estimate. Accrued funding on the actual hedge is read on-chain (`get_position_unrealized_funding_cost`) and
  included in the Decibel PnL.
* **Combined view.** The Positions card shows, per market: Tree Trade Δ (Σ ±N/E), Decibel position, net Δ, Tree
  Trade uPnL (net of the 2% profit fee), Decibel uPnL (`size × (mark − avg entry) − funding`), and the combined
  total.

## 6. Sync on open, close and liquidation; partial fills; failures

Each tick the hedger recomputes `target` from chain state and compares it with the chain position. It keeps
**no per-event bookkeeping**, so open, close, liquidation, cancel and restart are all the same code path:

| Event | What changes | Hedger action |
| --- | --- | --- |
| open (hedged) | new request, position exists | target grows → IOC order |
| close by owner / keeper liquidation | `position_exists` = false | target shrinks → reduce-only order. Once the group is back in sync, `hedge::prune(id)` |
| `cancel_hedge` | request gone, position open | the group is remembered in state with actual ≠ 0 → flatten |
| two hedged positions on one account and market | — | netted into one target and one order |
| partial IOC fill | actual moved part way | next tick trades the remainder; never overshoots (unit test) |
| IOC filled nothing | actual unchanged | `failed: IOC order did not fill within slippage`, exponential backoff 30 s → 10 min |
| order error (margin, permissions, RPC, 429) | — | `failed` + backoff. Since 0.8.2 hides submission provenance, the hedger waits and re-reads the position rather than resending immediately |
| `placeOrder` hangs (seen live: the SDK's wait stalled under 429s) | 45 s timeout → outcome **unknown** | recorded as in flight without an order id (the SDK docs say an unknown outcome does not authorize resubmission); after 20 s the position is re-read. A tick over 120 s exits the process (watchdog) and `run-hedger.sh` restarts it from saved state |
| delegation missing or expired | `view_delegated_permissions` | `not-delegated` (no gas spent). If a hedge must be closed but permission is gone: **`orphaned`**, and the user must close it on Decibel. The request is kept so the orphan stays visible |
| state file lost | closed request, market unknown | reconciles **every** market of that subaccount before pruning, so an earlier hedge cannot be orphaned |

**Async matching:** a Decibel order transaction only *acknowledges* (`OrderEvent.status = ACKNOWLEDGED`); fills land
later. The hedger keeps **one in-flight order per group** and does not trade that group again until
`get_remaining_size_for_order` reaches 0 (or a 60 s timeout). This prevents double-hedging while the book is
working.

UI states (Positions card): `hedged`, `hedging…`, **`hedge failed`** with the error on its own red row and a link
to the last transaction, **`hedge failed: no permission`**, **`orphaned hedge`**, `dust left`, `below min size`,
`closing hedge…`, and `hedger offline` (state older than 90 s).

## 7. Security review

* **No user keys.** Every user action is a wallet-signed transaction. The hedger key (`HEDGER_PRIVATE_KEY`) is a
  service key in `keeper/.env` (mode 600, gitignored) and is never logged. The web app only gets the public
  address (`NEXT_PUBLIC_HEDGER_ADDR`).
* **Least privilege.** Delegation is `TradePerpsOnMarket` per market with an expiry. The probe confirmed the
  delegate cannot withdraw (`ENOT_SUBACCOUNT_OWNER`) or trade other markets. The UI warns if broader permissions
  were granted.
* **Consent is per position and owner-signed.** `hedge` enforces position ownership and subaccount ownership
  on-chain (Move tests `test_hedge_subaccount_owned_by_someone_else`, `test_hedge_request_not_position_owner`).
  The hedger re-checks that the request owner equals the position owner.
* **Idempotency and double-hedge.** State reconciliation, one in-flight order per group (also when the order id or
  outcome is unknown), and a single-instance lock file. A restart while an order is in flight does not resend (unit
  test). Seen live: the hedger hung inside `placeOrder` after hedging a liquidation survivor. After a forced restart
  it read the filled position, found it equal to the target, placed nothing, and pruned the liquidated request.
* **Orphaned hedges.** Requests are pruned only after the Decibel side is flat, so closed positions stay visible
  until then. Lost delegation is surfaced as `orphaned`.
* **Rounding** is half-up to lots on the aggregate; side-safe tick rounding stays inside the slippage band;
  `client_order_id` is ≤ 32 bytes.
* **Dedicated account assumption.** The hedger drives each (Trading Account, market) to exactly the hedge target.
  Manual trading on the same account and market would be reverted, so the UI asks for a dedicated Trading
  Account.
* **Hedger trust.** Within the delegated scope, the hedger could trade badly (for example a bad price within 1%
  slippage, or repeated orders). Mitigations: scope, expiry, revocation, and an open-source reconciliation loop
  with logs. The worst case is trading losses and fees on the user's own testnet collateral, never a withdrawal.
* **Public tunnel.** None is started by this work (see the final report).

## 8. Operations

```bash
cd keeper
npm test                                   # 25 unit tests (sizing, delegation parsing, addresses, sync)
npx tsx src/hedge/hedger.ts --once         # one tick (live if HEDGER_PRIVATE_KEY, else mock)
nohup setsid ./run-hedger.sh >> hedger.log 2>&1 < /dev/null & echo $! > hedger.pid   # start
kill $(cat hedger.pid)                     # stop
npx tsx src/hedge/probe.ts                 # Decibel capability probe (box-generated accounts)
npx tsx src/hedge/hedge-e2e.ts             # live E2E (needs keeper + live hedger)
```

| Env (keeper/.env) | Default | |
| --- | --- | --- |
| `HEDGER_PRIVATE_KEY` | — | service key; unset → mock mode |
| `DECIBEL_PACKAGE` | `0xd368…7bd1` | override after a Decibel testnet redeploy |
| `HEDGE_INTERVAL_SECS` | 15 | keep ≥ 15 on the anonymous fullnode (shared 40k CU / 5 min with the keeper) |
| `HEDGE_SLIPPAGE_BPS` | 100 | IOC band |
| `HEDGE_STATE_PATH` | `keeper/hedge-state.json` | also read by the web app |
| `APTOS_API_KEY` | — | Geomi node key; recommended |

Gas: each hedge order uses about 250 gas units (0.00025 APT) but needs 0.25 APT of headroom; each prune uses a
few hundred units. Keep the hedger at ≥ 0.3 APT.

## 9. Not done / options

* **Builder codes.** The hedger could charge up to 10 bps through `builderAddr`/`builderFee` after the user
  approves `approve_max_builder_fee_for_subaccount`. It is off, because it only adds cost to users.
* **Live funding rate and order status** need a Geomi Client API key (REST). Without one the app uses the
  documented baseline and fullnode views.
* **Gas Station** (sponsored gas for users' Decibel transactions) needs a Geomi Gas Station key.

## Verification

* Move: `aptos move test --dev` → 98/98, including 10 `hedge` tests.
* Unit: `cd keeper && npm test` → 25/25.
* Live testnet E2E (`keeper/hedge-e2e.log`), real hedger `0x9486110b7bd6e9d71cadf53759b20f17099bd13d21cee6b2813065ffa704f6d4`,
  user Trading Account `0xe3e9c42b043c3def5c5b62031ccc1508127eefbe0329592841a8bd46ed6c345a`. Results are listed in
  DEPLOYMENT.md.

## 10. One-click hedging (2026-10-15)

### Docs and on-chain findings
* Decibel docs (onboarding, create-subaccount, delegate-trading, deposit, builder codes, TS SDK write-sdk) describe
  separate steps. The **live testnet `dex_accounts_entry` ABI** has a native one-shot entry that the docs and SDK
  0.8.2 do not mention: `add_delegated_trader_and_deposit_to_subaccount(signer, subaccount: address, asset, amount,
  delegate, Option<u64> expiry)`. On the wallet's **primary** Trading Account (`dex_accounts::primary_subaccount(owner)`,
  deterministic) it lazily **creates** the account, **deposits**, and **delegates** in one transaction
  (events: SubaccountCreatedEvent, CollateralBalanceChangeEvent, 3× DelegationChangedEvent). ~25–30k gas units.
  A seeded (non-primary) address aborts `ESUBACCOUNT_DOESNT_EXIST(0x2)`, so the primary account is used.
* Its delegation is `TradePerpsAllMarkets + TradeSpotAllMarkets + TradeVaultTokens` with expiry. It has **no**
  `SubaccountFundsMovement`, so the hedger still cannot withdraw (re-verified; withdraw is owner-only).
* Batching alternatives ruled out: all `delegate_*` functions in `dex_accounts` are `friend`, and the entry
  wrappers are private/friend `entry`, so neither a Move script nor our own module can call them; only a direct
  entry transaction can delegate. `usdc::restricted_mint` is a private entry (cannot be scripted). Decibel cannot
  create or delegate on a user's behalf (`admin_create_new_subaccount` is admin-only).
* Testnet `usdc::mint(&signer, to, amount)` is a **public entry** while `is_public_minting_allowed()` is true, so any
  account can mint Decibel test USDC to a user.
* Default leverage on a fresh Trading Account is enough for the hedger (verified 8x and 12x positions without
  `configure_user_settings_for_market`).

### Flow (testnet)
1. Hedge toggle (or "Enable hedging" in the Hedge panel) → `POST /api/hedge/fund`: the server (sponsor key) mints
   Decibel test USDC so the wallet holds 1,000 (skips if already ≥ 1,000; refuses if the account holds ≥ 10,000;
   3/hour/owner). **No user signature.**
2. **One wallet signature**: `add_delegated_trader_and_deposit_to_subaccount(primary, USDC, wallet balance, HEDGER,
   now+30d)`, gas paid by `/api/sponsor` (allowlisted; 60k gas cap for this function only).
3. Trades: with 1-click trading on, the session key calls the new
   `hedge::open_position_hedged_as_delegate(owner, market, is_long, margin, leverage, subaccount)` (compatible
   upgrade `0x0b5a72ce6a6bfd44520373946a7ebc4d96010e49678a64b965b6ae5a4bf2888d`), so hedged opens have **zero**
   prompts. Authorization is `exchange::open_position_as_delegate`'s check; the subaccount must be owned by
   `owner`. Closes use the existing `close_position_as_delegate`; the hedger flattens Decibel automatically.
4. Hedge panel shows Decibel balance, wallet USDC and live hedge sizes, with **Withdraw back**
   (`withdraw_from_cross_collateral`, 1 signature, to the wallet) and **Add 1,000 test USDC** (server mint + 1
   signature `deposit_to_subaccount_at`). The old step-by-step setup is under "Advanced".

Why the Tree Trade balance is not debited on testnet: Tree Trade's tUSDC and Decibel's USDC are different free
test tokens with no bridge, and debiting would need a second transaction (exchange withdraw) that cannot be batched
with Decibel's private delegation entry. Minting Decibel test USDC directly is the honest testnet equivalent.

### Mainnet
Both sides are real USDC (same FA metadata), and `/api/hedge/fund` is removed. Options:
* First setup: if the wallet holds USDC, still **one** signature (`add_delegated_trader_and_deposit_to_subaccount`).
  If the funds sit in the Tree Trade balance, it is two: `exchange::withdraw` then the one-shot (unless Decibel
  exposes a public delegation function or a public "deposit-and-delegate"; ask Decibel).
* Top-ups after setup: **one** signature with a Move script calling `exchange::withdraw` (public entry) and
  `dex_accounts::deposit_to_subaccount_at` (public) in the same transaction, i.e. "fund from Tree Trade balance".
  "Withdraw back" can likewise be a script: `dex_accounts::withdraw_from_subaccount` (public) + `exchange::deposit`.
  (Scripts need wallet support for script payloads; Petra supports them, verify derived Phantom/MetaMask wallets.)
* Gas: Geomi Gas Station or our `/api/sponsor` allowlist.
* Narrower consent: the one-shot grants all-perps + spot + vault-token trading; for least privilege use the per-market
  `delegate_perp_trading_to_market_for_subaccount` (extra signature per market).

### Verification (prod, `web/scripts/e2e-hedge-oneclick.mjs`, log `web/e2e-hedge-oneclick.log`)
Fresh 0-APT account, all gas sponsored: fund (server) `0xb0f3de2b…8562` → **one signature**
`0xce7bfbe0…b4c4` (Trading Account `0x59647447…47d8`, 1,000 USDC) → session-key hedged BTC long 20×100 `0x66c591da…b8b6`
(position 45) → hedger short 0.02475 BTC within ~16 s → session close `0x5426449f…75e7` → hedger flat in ~11 s →
withdraw back 988 USDC `0x12d22deb…88d6`. Move tests 138/138 (3 new in `hedge_delegate_tests.move`).
