# Adversarial review: keeper (`index.ts`, `signer.ts`, `run.sh`) and hedger (`hedge/*.ts`, `run-hedger.sh`)

I didn't edit any files. Besides the code, I read the shared libraries it imports (`web/src/lib/{prices,hedge,positions}.ts`, `web/src/config/contract.ts`) and the Move code it depends on (`oracle.move`, `hedge.move`, `exchange.move`). Where `keeper.log` or `hedger.log` backs up a finding, I cite it.

The most serious problems are that the keeper signs with the admin key, can miss positions that need liquidating, and trusts a single price source; and that the hedger can place the same hedge twice.

---

## HIGH

### H1. The keeper signs with the package publisher/admin key
**Where:** `src/signer.ts:18-31`, `src/index.ts:47`

**What happens:** `keeper.log:3` shows `signer: 0xadb693b4…d3e9 (from KEEPER_PRIVATE_KEY)`, and `hedger.log:106` shows `module=0xadb693b4…d3e9`. The keeper's hot key is the account that published `papertrade`. That account is the oracle admin and the market keeper, can upgrade the package, and can call admin-only functions that move money (e.g. `exchange.move:1118-1126` sends pool funds to `admin`). The key sits in plaintext `.env` on a box that runs a 24/7 loop and talks to third-party HTTP APIs. If that box is compromised, the whole protocol is compromised. The `signer.ts` fallback makes this the default anyway: it picks up the `default` profile from `../move/.aptos/config.yaml`, which is normally the deployer.

**Fix:** Create a dedicated keeper account. Register it with `oracle::add_keeper` and as `market_keeper`, and make it hold nothing beyond gas. Remove the CLI-profile fallback, or refuse to start when `account.accountAddress == MODULE_ADDR`.

### H2. Trader discovery misses four of the six entry functions that open positions
**Where:** `src/index.ts:128`

**What happens:** `fnIds` only includes `exchange::open_position` and `hedge::open_position_hedged`. These also create positions but are never indexed:
- `exchange::open_position_as_delegate` (`exchange.move:534`, 1-click trading)
- `exchange::open_position_from_queue` (`:1130`)
- `exchange::open_position_from_queue_as_delegate` (`:1134`)
- `hedge::open_position_hedged_as_delegate` (`hedge.move:90`)

Example: a user who only trades through a 1-click session key never goes into `traders`. Their positions are never scanned, so they never get liquidated. When the price moves past bankruptcy, the loss beyond their margin is bad debt for the pool.

**Fix:** Add all six function IDs, ideally from one list in `contract.ts`. Better, discover owners from position-open events or a resource, so a new entry point can't silently bypass the keeper.

### H3. Rate-limited or failed views count as "no positions", so liquidations are silently missed
**Where:** `src/index.ts:150-158` (`openPositionIds` returns `[]` on any error) and `:162-172`

**What happens:** `keeper.log:1290-1299` shows a `user_positions` view getting `429`, followed by `scan: 1 trader(s), 0 open position(s), 0 liquidatable`, tick after tick. The keeper shares an anonymous 40k-CU/5-min IP budget with the hedger and the web app, and 429s appear throughout the log. Any trader can exhaust that budget (or it happens naturally under load), and while it lasts no position is liquidated. The log still reports a healthy "0 liquidatable". `withRetry` only wraps build, submit and simulate, not views.

**Fix:** Wrap the views in `withRetry`. Count failed owners and log them as `scan incomplete: N owners failed` instead of a clean summary. Keep each trader's last known position IDs and re-check them when a fetch fails.

### H4. One price source, no outlier rejection or deviation limit, and failover switches venue
**Where:** `web/src/lib/prices/index.ts:150-166`, `src/index.ts:42-45, 78-92`

**What happens:**
- `AutoPriceSource` uses whichever source answers first. `hasAll` only checks that each price is finite and above 0. Nothing compares the price to the previous push, to the other source, or to the on-chain price.
- When `DECIBEL_NODE_API_KEY` is set, Decibel testnet `mark_px ?? oracle_px ?? mid_px` is preferred. That comes from a thin testnet venue that anyone can trade on.
- A bad or manipulated print, e.g. BTC 10% off, goes straight to `push_prices`. Liquidations then run on it the same tick, because the chain's `is_liquidatable` and the simulation both read the price the keeper just pushed, so the simulation check does not protect against this.
- A trader can open, push or wait for the bad print, and close against it.
- Even without an attacker, when Decibel fails and Hyperliquid takes over (and again 60s later when it switches back), the price jumps by the gap between the two venues. That jump is enough to liquidate positions at 1000x leverage, where the liquidation buffer is about 5 bp (`keeper.log:80`: 1000x liq≈81023.99 vs entry 80983.5).

**Fix:**
- Query every source on each tick and use the median.
- Reject the tick if sources disagree by more than X bp.
- Cap the change versus the last pushed price per tick, and require confirmation over two ticks before a large move.
- Only liquidate when the local mark and the chain price agree.

### H5. Hedger: a tick that throws after placing an order loses the in-flight order, which leads to a double hedge
**Where:** `src/hedge/sync.ts:178-205`, `src/hedge/hedger.ts:202-207`

**What happens:**
- `tick()` builds `nextGroups` locally and only assigns `this.state` at the end (`:204`).
- `saveState` only runs if the tick succeeds.
- Inside `syncGroup`, `client.position()` (`:253`), `markPrice()` (`:297`) and `marketSpec()` can throw.

Scenario: group A places an IOC SELL (`gs.pending` set only in the local `gs`). Then group B's `client.position()` gets a 429, or the 120s watchdog fires. `hedger.log` shows 6 watchdog exits today, e.g. `:102`, `:160`, `:169`. Group A's pending record is discarded. On the next tick (15s later, or after a restart) A has no `pending`, so `orderPending` is never checked. If Decibel's async matching hasn't filled yet, A still reads `actual == 0`, places a second SELL of the full size, and the user ends up 2× hedged. `state.seq` was already incremented on the old object, so the record and the client order IDs drift apart as well.

The comment at `hedger.ts:200-201` ("reconciliation makes the restart safe") is wrong for in-flight orders.

**Fix:**
- Wrap each `syncGroup` in try/catch so one group's failure can't drop another group's result.
- Write `pending` to `this.state.groups[k]` and call `saveState` right after `placeOrder` returns, before any further RPC.
- On startup, treat any group whose last tx is younger than `pendingTimeoutMs` as pending.

---

## MEDIUM

### M1. An order with an unknown outcome or no order ID can still fill after the hedger has re-placed it, giving a double hedge
**Where:** `src/hedge/decibel-client.ts:129-139`, `src/hedge/sync.ts:243-245, 259-263, 302-309`

**What happens:**
- The 45s `Promise.race` timeout does not cancel `this.place(r)`. The signed transaction can still commit, and Decibel matches orders asynchronously after that.
- With no `orderId`, the group is "pending" for only `noOrderIdWaitMs = 20s`. After that, if the position hasn't moved, `fail()` sets a 30s cooldown, clears `pending`, and the next attempt places a fresh order.
- That gives about 50s after the timeout. If the original transaction's expiration is longer than that, or matching is slow, both orders fill.
- The success path with `res.orderId === undefined`, which the code says the SDK can return, behaves the same way.

**Fix:**
- Record the client order ID and tx hash (sign locally to get the hash before submitting).
- Before re-placing, look the transaction up by hash, or query orders by `clientOrderId`.
- Keep the group pending until the hash is committed and matched, or until the tx's `expiration_timestamp_secs` has passed.

### M2. Losing the state file orphans hedges that the user cancelled, and the hedger can silently overwrite live state with mock state
**Where:** `src/hedge/sync.ts:173-176`, `src/hedge/hedger.ts:76-91, 160-161`, `src/env.ts:4`

**What happens:**
- `cancel_hedge` deletes the request on-chain. After that, the only record that a subaccount still holds a Decibel position is `state.groups` (`:174-175`).
- `loadState` throws that record away on a parse error, or when `mode` or `hedger` doesn't match.
- `env.ts` loads `.env` relative to the current directory. If someone runs `npx tsx keeper/src/hedge/hedger.ts` from the repo root, `HEDGER_PRIVATE_KEY` is missing. The hedger then silently falls back to MOCK and writes mock state over the live `hedge-state.json`.
- After the next live start, every hedge whose request was cancelled stays open on Decibel indefinitely. It isn't flattened and isn't flagged "orphaned". The closed-position path covers lost state (`:168-171`); the cancel path doesn't.

**Fix:**
- Fail closed when no key is set, unless `--mock` was passed.
- Use separate state files per mode.
- Resolve env paths from `import.meta.dirname`.
- On startup, rebuild the set of known groups from chain: `HedgeRequested` events for the hedger's subaccounts, or `view_position` across known subaccounts.

### M3. Dust, orphaned and not-delegated groups never get pruned; the 1000-entry registry fills up and blocks `open_position_hedged` for every user
**Where:** `src/hedge/sync.ts:268-276, 286-294, 199`, `move/sources/hedge.move:145`

**What happens:**
- A closed position is only pruned when its group returns `plan.kind === "none"`.
- An IOC partial fill can leave a residual smaller than `min_size` (ETH: residual of 1-4 lots against a min of 5). The group is then permanently "dust".
- Groups that are "orphaned" or "not-delegated" also never settle.
- Their requests stay in the registry forever. With `MAX_ACTIVE = 1000`, `open_position_hedged` eventually aborts with `E_TOO_MANY_REQUESTS` for everyone.
- A griefer gets there faster by opening many minimum-size hedged positions on a subaccount that never delegates. Each request also costs hedger RPC calls on every tick, on the shared anonymous budget.

**Fix:**
- For dust with target 0, clear it with a `min_size` order the opposite way followed by a reduce-only close, or treat dust as settled and prune.
- Prune closed requests whose group is not-delegated once the actual position is confirmed to be 0.
- On the contract side, cap requests per owner.

### M4. The keeper has no single-instance guard; sequence-number collisions drop price pushes
**Where:** `src/index.ts:64-69`, `run.sh`

**What happens:**
- `keeper.log:1301-1304`: the keeper's own push confirmed at 07:46:04. At 07:46:13 the next push failed with `Transaction already in mempool with a different payload`. Something else was signing with the same key (e.g. `e2e.ts`, `--once`, or a second `run.sh`).
- There is also `SEQUENCE_NUMBER_TOO_OLD` at `:5754`, and 5 more mempool conflicts.
- `build.simple` reads the sequence number from the chain every time, so two signers, or a timed-out transaction still in the mempool, reuse the same number.
- Every lost push brings the oracle closer to its 60s staleness limit (`oracle.move:130`). Once it's stale, all trading is blocked.

**Fix:** Add a pidfile/flock like the hedger's. Use a dedicated key per process. On `invalid_transaction_update` or `SEQUENCE_NUMBER_*` errors, re-fetch the sequence number and retry once within the same tick.

### M5. Price pushes share a serial loop with the scan, liquidations and OI caps, and that loop can run past the oracle's 60s staleness limit
**Where:** `src/index.ts:251-271, 223-248, 314-326`

**What happens:**
- Prices are pushed once, at the start of each tick.
- Each liquidation then does a simulation plus a `waitForTransaction`, one at a time. On top of that are `trailOiCaps` (a view and a possible tx per market) and 429 back-offs of 1.5s and 3s.
- The watchdog allows 90s, while the oracle rejects prices after 60s. A tick that takes 60-90s leaves the oracle stale, so all trades revert, including the remaining liquidation simulations (`E_STALE_PRICE`). `keeper.log:6637, 6938` show ticks that went past 90s.
- This also produces the scenario the watchdog comment describes (exit and restart), which adds 5s+ of restart time with no pushes.

**Fix:** Run price pushing in its own loop with its own timer and per-request timeouts. Bound the scan and liquidation phase by the time left until staleness, and skip ahead to the next push when it's running out.

### M6. Indexer-lag fast-forward can skip traders permanently
**Where:** `src/index.ts:145-146`

**What happens:**
- After each pass, the cursor jumps to `ledgerVersion - 100_000`.
- If the indexer lags the fullnode by more than 100k versions, those `open_position` transactions haven't been indexed yet when the cursor moves past them. That's a few minutes of testnet traffic, and the log shows indexer timeouts (`keeper.log:1500`).
- The traders in that window are never added, and only a keeper restart (full re-scan) recovers them.

**Fix:** Advance the cursor only to the indexer's own processed version (`processor_status` / `ledger_infos` from the indexer), never to the fullnode's version.

### M7. Hedger lock: check-then-write race, and a reused PID blocks the hedger permanently
**Where:** `src/hedge/hedger.ts:50-74`

**What happens:**
- The lock check is read, `kill(pid, 0)`, then write. Two hedgers starting at the same time both pass it. That gives the double-trading the lock is meant to prevent.
- After a reboot or container restart, the PID in `hedge-state.lock` can belong to an unrelated live process. Every start then exits with "another hedger holds…", and `run-hedger.sh` loops every 10s. Hedging is down silently and closed positions stay unflattened.

**Fix:** Open the lock with `O_EXCL` / `flock`. Check that `/proc/<pid>/cmdline` is actually a hedger before trusting it, or store a start-time nonce in the lock file.

---

## LOW

| # | Where | Issue | Fix |
|---|---|---|---|
| L1 | `sync.ts:282-286` | If the delegation view fails, `del` is `undefined` and the hedger places the order anyway. Without delegation it reverts, costing gas and pushing the group into backoff. | Skip the trade this tick when `del` is undefined. |
| L2 | `index.ts:281-295` | `set_side_caps` is submitted without simulating first. If the key isn't `market_keeper` or the call aborts, gas is paid on every tick. A throw on BTC also skips ETH. Head-room is sized from the unvalidated off-chain price (H4). | Simulate first and wrap each market in its own try/catch. |
| L3 | `index.ts:67`, `hedger.ts:152` | `waitForTransaction` isn't retried on 429. `keeper.log:736` shows a `GET by_hash` 429 reported as "push_prices failed" even though the tx was probably committed. This leads to misleading logs and, for prune, extra resubmits. | Retry the wait on 429 and timeout before reporting failure. |
| L4 | `sync.ts:341` | The prune "already done" regex `0x4\b` / `abort_code: 4` would match abort code 4 from any module. The request would then be marked pruned locally while it stays on chain. | Match `hedge::E_NO_REQUEST` / module-qualified abort codes only. |
| L5 | `sync.ts:300`, `hedger.ts:84` | `seq` resets to 0 on a fresh state file, so `clientOrderId`s (`tt1-xxxxxx`) repeat across runs. That makes it hard to tell orders apart when reconciling, and it matters for M1's fix. | Seed with a timestamp or random prefix. |
| L6 | `env.ts:4` | `.env` paths are resolved from the current directory, not the file. It also loads `../web/.env*`, which gives keeper processes the web app's secrets. A run from another directory has `MODULE_ADDR=0x0`; the keeper only logs a warning and keeps running (`index.ts:302`). | Resolve from `import.meta.dirname`, load only `keeper/.env`, and exit when `MODULE_ADDR` is unset. |
| L7 | `index.ts:212`, `positions.ts:97-101` | The local fallback check uses the bust price, while its comment says "equity <= maintenance". It only matters when the chain view fails, and the simulation blocks wrong submits. | Align the comment or the formula. |

---

## Checked and found sound
- Hedge direction and sizing: TT long → Decibel short, target = −ΣN/E rounded once to lots (`hedge.ts:57-77`).
- Reduce-only is used only for pure reductions.
- The IOC price is rounded to the safe side of the tick.
- Owner mismatch is checked (`sync.ts:155`).
- Closed positions with unknown market are reconciled across all markets before pruning.
- The keeper simulates before liquidating, so a liquidation the chain would reject costs no gas.
- Publish time comes from the ledger clock.

**Suggested order of fixes:** H1, H2, H5, H4 and H3 first, since each can directly cause bad debt, an unwanted double hedge, or a full compromise. Then M1-M4.
