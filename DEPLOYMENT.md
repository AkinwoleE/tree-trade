# Tree Trade (APTree) — testnet deployment

Network: **Aptos testnet** only. Deployed 2026-10-15.

| Item | Value |
| --- | --- |
| Package address (`papertrade`, = deployer, profile `default`) | `0xadb693b4ae831f1cfcb9b1eb10e5ca8e7875c013e9cd1ed5c587720c4f84d3e9` |
| Test USDC metadata | `0xe9d453f0dd8107a53e9238dbd2c19cb60360af794ede84658b8d64ad38ab3007` |
| Exchange vault (owner `0xfff…f`) | `0x75555c26aaff97937c125f5a08c136d5ca4d5383378a94274080c8b0e5c16c9e` |
| SEEDS reward vault | `0x20ada643fc684ad1daf625d2225f0e53246eb8b13e48a3ed9000fbc768e96c6` |
| Oracle admin / keeper | deployer |
| E2E trader account | `0xa57d3ceb9fecaf8c661497be2478b0abe3de08f3444d205b626ab947cb25947b` (key in `keeper/.e2e-trader.json`, mode 600, gitignored) |

Explorer: `https://explorer.aptoslabs.com/txn/<hash>?network=testnet`

## Deployment transactions

| Step | Tx |
| --- | --- |
| Publish package (all four modules; `init_module` sets up USDC, oracle, SEEDS, exchange) | `0x3b6a9e9148f1a25d88df05b31b8fa72faee0c062e8d0869bbba2cefef8740ad7` |
| `oracle::add_keeper(deployer)` | `0x8b54b336470e91684aacdf53bd8634904f8a197fd0b9380f4d942cd4c847da04` |
| `test_usdc::mint(deployer, 50,000 USDC)` | `0xd83d9e46805c42002f0413833b9a6678656b3851f48d72adec8cce1e48d582cc` |
| `exchange::fund_pool(50,000 USDC)` | `0x097aa9a8b7122728ba93b5b453fd931289918df1a97e4f1fd67471b83d856b50` |
| First keeper `push_prices` | `0x65c966e173d25fd8f8457f263a7a1d62a03ce5f95d29a90267815a40229b9fdd` |

No other init entry functions are needed. Every module initialises itself in `init_module` at publish.

### Upgrade 2026-10-15: `hedge` module (Tree Trade Hedge)

| Step | Tx |
| --- | --- |
| Compatible upgrade adding `papertrade::hedge` (`init_module` created the request registry; `exchange`, `oracle`, `paper`, `test_usdc` unchanged; 28,233 gas) | `0x31aa87a71749db797c4a76ea38b012e113ad24ad2b9ee319864cd6ce6641e9e4` |

Move tests after the upgrade: `aptos move test --dev` → **98/98** (88 existing + 10 `hedge`).

Re-publishing (only for an upgrade; this keeps the same address and resources):

```bash
cd move
aptos move publish --profile default --named-addresses papertrade=default
```

## Running services

All three run detached (`nohup setsid`) and survive the shell exiting. They do **not** survive a reboot.

### Keeper (`keeper/`)

- Config: `keeper/.env` (mode 600, gitignored) holds `MODULE_ADDR` and `KEEPER_PRIVATE_KEY`, copied from the
  `default` profile, plus `HEDGER_PRIVATE_KEY` for the hedger. No Decibel key, so prices come from Hyperliquid `allMids`.
- Since 2026-10-15 the keeper runs on ts-sdk 7 (peer of `@decibeltrade/sdk`) with an explicit `maxGasAmount` of 200,000,
  and discovers traders from both `exchange::open_position` and `hedge::open_position_hedged`.
- Supervisor: `keeper/run.sh` restarts the keeper 5 s after any exit (tested by killing the node process).
- Logs: `keeper/keeper.log`. PID of the supervisor: `keeper/keeper.pid`.
- Pushes BTC/ETH every 10 s. Each push costs ~53 gas units × 100 octas = 0.000053 APT, about 0.46 APT/day.
  The deployer had ~9.27 APT after the E2E run, which is roughly **20 days** of runway. Top it up before then:
  on-chain prices go stale after 60 s, and stale prices block every open, close and liquidation.

```bash
cd keeper
nohup setsid ./run.sh >> keeper.log 2>&1 < /dev/null &  echo $! > keeper.pid   # start
kill $(cat keeper.pid)                                                        # stop (trap stops the child)
tail -f keeper.log
```

### Hedger (`keeper/src/hedge/hedger.ts`)

- Service account (Decibel delegate): `0x9486110b7bd6e9d71cadf53759b20f17099bd13d21cee6b2813065ffa704f6d4`, funded with 0.5 APT
  (tx `0x48ebb462231aa24316cf1957ea2c84a0e2a5a90d4e15db846e16a6eeab2bdd86`). Key: `HEDGER_PRIVATE_KEY` in `keeper/.env`.
- Mode: **live** on Decibel testnet package `0xd368b820fdfbfe004679cdb0facef4b920c4fc0c2c80bd2fecf3843a93427bd1`, via the anonymous
  public fullnode (no Geomi key).
- Supervisor: `keeper/run-hedger.sh` (restarts 10 s after an exit; SIGTERM stops it cleanly). PID: `keeper/hedger.pid`.
  Log: `keeper/hedger.log` (logs on change, plus a heartbeat every 20 ticks). State: `keeper/hedge-state.json`, served by the
  web app at `/api/hedge/status`. A single-instance lock is kept at `keeper/hedge-state.lock`.
- Gas: about 0.00025 APT per hedge order (0.25 APT of headroom is needed) and a few hundred units per prune. Keep ≥ 0.3 APT.

```bash
cd keeper
nohup setsid ./run-hedger.sh >> hedger.log 2>&1 < /dev/null &  echo $! > hedger.pid   # start
kill $(cat hedger.pid)                                                               # stop
```

### Web (`web/`)

- `web/.env.local`: `NEXT_PUBLIC_MODULE_ADDR=<package address>` and `NEXT_PUBLIC_HEDGER_ADDR=<hedger address>`, with no
  Decibel key. The `/api/decibel/*` route answers 503 and the client falls back to Hyperliquid.
- Built with `npm run build`, served by `next start` on port 3000. Logs: `web/web.log`. PID of `next-server`: `web/web.pid`.

```bash
cd web
npm run build
nohup setsid ./node_modules/.bin/next start -p 3000 >> web.log 2>&1 < /dev/null &
kill $(cat web.pid)   # stop: web.pid holds the next-server pid
# write the pid without matching your own shell: ps -eo pid,args | awk '$2 ~ /^next-server/ {print $1}' > web.pid
```

## E2E test (`keeper/src/e2e.ts`)

This needs the keeper running. Run it from `keeper/`:

```bash
npx tsx src/e2e.ts                # full scenario
npx tsx src/e2e.ts --skip-liq     # skip the 1000x liquidation part
npx tsx src/e2e.ts --close <id>   # close + verify one open trader position
```

What it does:

1. Generates the trader account once (`keeper/.e2e-trader.json`). If the trader has less than 0.2 APT, it sends 0.5 APT from the deployer.
2. Claims the faucet (10,000 USDC, 24 h cooldown) and deposits 2,000 USDC.
3. **Liquidation:** opens a BTC 1000x long and a BTC 1000x short, 10 USDC margin each. A move of about 0.05% puts one
   leg past maintenance, the keeper liquidates it, and the script closes the survivor.
4. Stakes all SEEDS, so the next fee is really split between stakers and dev.
5. Opens a BTC long 50x and an ETH short 50x (100 USDC margin each), waits for the BTC oracle price to move, and closes the BTC long.
6. After every close or liquidation, it recomputes PnL with the contract's exact rounding. It then checks the event fields
   (`pnl`, `fee`, `paid_now`, `queued`, `paper_minted`) and these deltas: trading balance, SEEDS, pool, dev fees, staker
   rewards and reward-vault deposits. It also checks the `FeesDistributed` split and both vault invariants. Vault balances are read
   independently through `0x1::primary_fungible_store::balance`:
   - exchange vault FA == total_balances + total_margin + pool + dev_fees
   - reward vault FA == rewards deposited − claimed

### Results (2026-10-15): 46/46 + 17/17 checks passed

| Event | Numbers | Tx |
| --- | --- | --- |
| Fund trader 0.5 APT | | `0x47f391ab4e31b6980ed131ce793fb767462cfd6219fdb64ef0b0567b0ebed52e` |
| Faucet +10,000 USDC | | `0x329c0af9af4477294b63e47a0aaf4616451c19689da6804dd7efdada43ff1cc5` |
| Deposit 2,000 USDC (vault FA +2,000) | | `0x2378a90717844a08e5c916a6e226795ced80117e7c50392e0d44e51acc55eabe` |
| Open #1 BTC LONG 1000x, 10 USDC @ 80983.50 | liq ≤ 80943.01 | `0xd34a34aa6e55398ab732d4977dcf9ac95bf1f1a6cb5e84986e292036948cb276` |
| Open #2 BTC SHORT 1000x, 10 USDC @ 80983.50 | liq ≥ 81023.99 | `0x252b1ac6b940db765db4b323da1696bdb4f4eb4118ea8f36f8ed27db60b775d5` |
| **Keeper liquidated #2** at mark 81039.5 (~70 s after open) | margin 10 lost; fee 0.20 → dev (nothing staked yet); pool +9.80; **SEEDS +1,000** (100/USDC) | `0x32806a44a34921c73d6c2185f07346b22a23c14bb7aa86e12fb4fba41c075b86` |
| Close #1 (survivor) @ 81039.50 | profit 6.914988, fee 0.138300 (2%), paid 16.776688, pool −6.914988, split 0.069150/0.069150 (both to dev, nothing staked) | `0xce34871a3f5a6a1e73db2845ad1ccb54043d8dd1136c9adb5759e0364ca95391` |
| Stake 1,000 SEEDS | | `0x5486a4d6ea7dbf135875657ff9c55cbd802853367fb3f844896864c628add36d` |
| Open #3 BTC LONG 50x, 100 USDC @ 81039.50 | liq 79823.91 | `0xe2adfe80bdb777861bd19a85b81372d7ace848600c1d22a7e553065c976afd34` |
| Open #4 ETH SHORT 50x, 100 USDC @ 2359.15 | liq 2394.54 | `0xe47b2f8b9c89e1bd319ec861b2de74d4233e99354e3aa2bded43e61d335cc4cb` |
| **Close #3 BTC long** @ 81063.50 | profit 1.480759, fee 0.029616 (2%), paid 101.451143, pool −1.480759, **stakers 0.014808 / dev 0.014808**, trader pending rewards +0.014808 | `0x8a8c9207f492d2f4e0c5d6c7bca9d3954ea877c75281f646b18f7d3241b497b3` |
| **Close #4 ETH short** (`--close 4`, at a loss) | loss 1.271645, fee 0.025432 (2%), refund 98.728355, pool +1.246213, stakers 0.012716 / dev 0.012716, **SEEDS +127.1645** | `0xa4f601d051d08cb02ef30db891f169e2b00ddfb26514db1582a11cece397de31` |

On-chain state after the run:

| Item | Value |
| --- | --- |
| Exchange vault FA | 51,999.972476 USDC |
| Accounting: balances + margin + pool + dev | 1,996.956186 + 0 + 50,002.650466 + 0.365824 (exact match) |
| Reward vault | 0.027524 USDC (= deposited − claimed) |
| Payout queue | empty |

## Notes

- The deployer key signs both keeper pushes and admin transactions. A manual admin transaction can race the keeper for
  a sequence number. The keeper only logs that push as failed and retries on the next tick. `e2e.ts` retries the submission.
- To use a separate keeper key: put it in `KEEPER_PRIVATE_KEY` and run `oracle::add_keeper(<addr>)` from the deployer.
- Secrets: `keeper/.env` and `keeper/.e2e-trader.json` are mode 600 and gitignored, and `move/.aptos/` is fully gitignored.
  No private key appears in any log.

## Hedge E2E (`keeper/src/hedge/hedge-e2e.ts`), 2026-10-15, live on Decibel testnet

Needs the keeper and the hedger (live) running. User = box-generated probe owner
`0x4b88038a26dd234f3548f0bf8766e6ca303771dc3771b72a0ab386854175ba23` (key in `keeper/.hedge-probe.json`, mode 600,
gitignored), Trading Account `0xe3e9c42b043c3def5c5b62031ccc1508127eefbe0329592841a8bd46ed6c345a`, hedger
`0x9486110b7bd6e9d71cadf53759b20f17099bd13d21cee6b2813065ffa704f6d4`. Logs: `keeper/hedge-e2e.log` (run 1),
`keeper/hedge-e2e-liq.log` (liquidation rerun), `keeper/hedger.log`, `keeper/hedge-probe.log`.

| Step | Result | Tx |
| --- | --- | --- |
| Delegate BTC perp trading to the hedger (1 day), market-scoped | ok | `0xcbdd461f2b03acfa80c5c446878e4c972fbae0aa529fefc0941ac38dfd8982ab` |
| `hedge::open_position_hedged` BTC long 20 USDC × 10x (#5) | request recorded | `0x5e7063ebb60136305c85fbf8cb719e6d8e6965e55034584c4470f38d1a8a8342` |
| Hedger: SELL 2,460,000 (0.00246 BTC) IOC on the user's Trading Account | filled; target = actual | `0xa561263150e4dc7d30df335a2124d19d8df261f30ddd0f56c6dae93c163b46c9` |
| 20 s in sync | no further orders (no double hedge) | — |
| Close #5 | | `0xba625b98a77a4ec2489853f5b5a139265bf56074244da5b1ec0cb8cab384babe` |
| Hedger: BUY 2,460,000 reduce-only, then `hedge::prune(5)` | flat, request gone | `0x4e5815fc…`, `0x0537c4ef840eef80d8f45f5a1296566e41c05f6bc15b2916515fc81a746d5030` |
| Hedged ETH short (#6) without an ETH delegation | `not-delegated`, hedge-failed shown, **no order** | `0xf1711bab2e614e030213851bdf6a156a623423d03eb84db8b5b6968cf79b8dfe` |
| Close #6 → prune (nothing to flatten) | ok | `0x13e67f7e66d75999151d5284219540176c28152e046fe4cac11ae497ee54d3a4` |
| Hedged 1000x long + 1000x short (#7/#8): hedges net to 1 lot (< min size) | `below-min`, **no order** | — |
| Keeper liquidated #7 (its earlier attempts on #8/#7 hit 429s) | | keeper tx v76811807 |
| Hedger hedged survivor #8 (long 0.12294 BTC); then hung in `placeOrder` under 429s → fixed (timeout + watchdog), restarted | after restart: in sync, **no duplicate order**, pruned #7 | `0x283d7e38800dfbd77ac0332bcb32b88b9a88023dc86a3349120dc70e78b203f4` |
| Rerun: close #8 → hedger SELL 122,940,000 reduce-only, prune #8 | flat | `0xe75bfadc2bf7b2006e9d73d918f0a0b5b77fbd85aa0977f74929b5dd0e789e94` |
| Rerun: 1000x long #9 + short #10 (net 0); **keeper liquidated #9** within ~30 s | | |
| Hedger: BUY 123,140,000 for survivor #10, prune #9 | target reached | `0x24d2db46e5a8fe2f78cac511e2c7486fc7243bf1c80be49ad62aca6b932d6779`, `0xb18d68f3d6d47f555d6f1d344d85e75c7f0f76c5019727047941ffaf65333d2c` |
| Close #10 → hedger SELL reduce-only, prune #10 | flat, no requests left | `0x7325640b…`, `0xb6ac6f569adb089a672fff657aa2c49ca82a818079cb7f1bd9426f6d1a8685d0` |

Check tally: run 1 had 9 PASS and 2 FAIL. The first FAIL was a test check that was too strict (it required exactly 0 net; the legs opened
at different oracle prices, leaving 1 lot below min size, which the hedger correctly did not trade). The second was a keeper
liquidation that failed on 429 before the price recovered. The liquidation rerun had 5 PASS and 1 FAIL. That FAIL was a
timing artifact: "no order for the netted target" was violated because the keeper liquidated #9 inside the 35 s observation
window, so the survivor hedge was the correct order. That check passed in run 1. Every hedge behaviour (open, close,
liquidation, no permission, netting, prune, restart without double hedge) passed live at least once.

## 1-click trading (session-key delegation), 2026-10-15
Compatible upgrade tx `0xcf869d47babbd0b7c01749643d473f2cfc49a65ae64a101aa9969af9798bfe3a`: adds `exchange::delegate_trading_to(delegate, Option<u64> expiry)`,
`revoke_delegation`, `revoke_all_delegations`, `open_position_as_delegate(owner,..)`, `close_position_as_delegate(owner,id)`, views `delegation_of`, `delegates_of`.
Per-user `TradingDelegates` resource lives under the owner's account (max 8, expired pruned). Tests: 116/116 (`delegation_tests.move`). Prod e2e: `web/scripts/e2e-oneclick.mjs`.

## One-click hedging, 2026-10-15
Compatible upgrade `0x0b5a72ce6a6bfd44520373946a7ebc4d96010e49678a64b965b6ae5a4bf2888d` adds `hedge::open_position_hedged_as_delegate`. Web: `/api/hedge/fund`, Decibel one-shot setup, Hedge panel balance/withdraw. See HEDGE_DESIGN.md §10.

## Roles (2026-10-15)
- **Admin** `0xadb6…d3e9`: package upgrades, params, and the price circuit breaker (unbounded `push_price`).
- **Keeper role** `0x71f3…1b4e`: oracle keeper and market keeper (keeper/.env `KEEPER_PRIVATE_KEY`). The keeper refuses the admin key unless `ALLOW_ADMIN_KEEPER=1`.
- **Price signer**: ed25519 key in Vercel `PRICE_SIGNER_KEY`, public key on chain (`oracle::guard_params`). Rotate with `oracle::set_price_signer(admin, pk)`, then update the Vercel env and redeploy.
- After the V4 init, `exchange::init_v4` must exist before any new frontend ships, and opens require `*_px` entries.

### Moving the admin to Aptos multisig v2 (recommended, not yet done)
1. `aptos multisig create --additional-owners <o2> <o3> --num-signatures-required 2` creates the multisig account M.
2. Package upgrades: the package lives at the deployer account, so either rotate the deployer's auth key to be controlled by M (`0x1::account::rotate_authentication_key_call` flow / offering a signer capability to M) or republish under an object-code deployment owned by M.
3. Admin params: `exchange::transfer_admin`/`oracle` two-step admin transfer to M, then accept via a multisig proposal (`aptos multisig create-transaction` → `approve` → `execute`).
4. Keep the keeper role key and price signer separate. They need no admin rights.

### Upgrade 2026-10-16: API usage reduction

| Step | Tx |
| --- | --- |
| Compatible upgrade adding view `exchange::open_positions(start_id, max_ids)` (`--included-artifacts none`, 4,125 gas) | `0x14f2bb9dae634525fa0b7b1cefda18eaf0e338a22dd4117ffbef3ca1394d1d1d` |

Move tests: 172/172 (incl. 2 new in `v5_tests`).

Keeper: positions come from the one batched view every `SCAN_SECS` (20 s; every tick when a position is within `NEAR_LIQ_BPS`=100 of its bust price);
liquidation is computed locally and simulated on chain only when crossed (price is pushed first). Prices are pushed on a `PUSH_MOVE_BPS`=10 move or every
`PUSH_MAX_AGE_SECS`=30 s, built locally (cached sequence number, fixed gas price, chain-clock offset from tx timestamps) = submit + one wait. OI caps every 120 s.
Hourly `usage[keeper]` / `usage[hedger]` lines in `keeper.log` (first after 15 min). Role keys: `APTOS_API_KEY_BOTS`, `APTOS_API_KEY_SITE`, `DECIBEL_API_KEY`
(fallbacks: `APTOS_API_KEY`, `DECIBEL_NODE_API_KEY`). Site per-instance counters: `/api/usage`.

## Cost cuts 7–9 (2026-10-16)
- **Hedger** reads open positions from the keeper's `exchange::open_positions` snapshot (`keeper/open-positions.json`, `OPEN_SNAPSHOT_PATH`).
  If the snapshot is older than `HEDGE_SNAPSHOT_MAX_AGE_SECS` (60), it runs its own batched `open_positions` view.
  `hedge::active_requests` is re-read only when the open set changes, or every `HEDGE_REQ_REFRESH_SECS` (60).
  Decibel position reads are skipped for in-sync groups whose target hasn't changed, with a full reconcile every `HEDGE_RECONCILE_SECS` (300).
- **Decibel price vote**: circuit breaker, automatic re-enable (see ORACLE_RISK.md).
- **/api/sponsor**: submit retries on 429 with exponential backoff and full jitter (4 tries, ≤5 s total, honours Retry-After). The resubmit is idempotent.
  The client (`postSponsor` in `lib/hooks.ts`) also retries 429s from the route. This covers faucet, deposit, trade and every other sponsored tx.
- Prod check script: `web/scripts/e2e-cost-cuts.mjs` (fresh accounts are auto-added to `internal-accounts.json`).

## Live UI prices (2026-10-20)

- The ticker and Tick chart stream straight from the browser to free public market-data WebSockets (no key):
  Binance mirror `wss://data-stream.binance.vision` (`<sym>usdt@bookTicker`, converted to USD with `usdcusdt@bookTicker`),
  Coinbase Exchange `wss://ws-feed.exchange.coinbase.com` (`ticker`), Kraken `wss://ws.kraken.com/v2` (`ticker`, `event_trigger: bbo`).
  Code: `web/src/lib/price-feeds.ts` (median, then mean of feeds within 15 bp of it; 200 ms throttle; per-socket backoff 1→30 s with jitter).
- Fallback: `/api/stream` (SSE) opens only after 5 s with no WebSocket tick; `/api/prices` polls only if both are down.
- Hidden tabs close every socket. The UI shows only a generic LIVE badge, never a venue name.
- Display only. Trades still use the signed `/api/price-sig` price and the keeper's on-chain price. If the stream is more than 0.3%
  away from the latest signed price (30 s) or a fresh on-chain price (90 s), the UI shows that trusted price instead (`web/src/lib/price-anchor.ts`).
