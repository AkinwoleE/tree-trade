# Tree Trade by APTree — Aptos testnet perps casino

Trade BTC/ETH perpetuals up to 1000x on Aptos **testnet** with faucet test USDC. Optionally **hedge**
each position with an opposite position on [Decibel](https://docs.decibel.trade) testnet (see
[HEDGE_DESIGN.md](HEDGE_DESIGN.md)).

| Dir        | What                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| `move/`    | Move package `papertrade` (`test_usdc`, `oracle`, `exchange`, `paper`, `hedge`)   |
| `web/`     | Next.js (App Router, TypeScript, Tailwind) dapp                                   |
| `keeper/`  | Node/TypeScript: keeper (oracle prices, liquidations) and hedger (Decibel hedges) |

On-chain identifiers (package `papertrade`, module names, the `SEEDS` token) keep their original names. Only
the product is branded Tree Trade.

Docs: [HEDGE_DESIGN.md](HEDGE_DESIGN.md) (hedge architecture and research),
[DOCS_REVIEW.md](DOCS_REVIEW.md) (code vs official docs), [DEPLOYMENT.md](DEPLOYMENT.md) (testnet deployment),
[move/REVIEW.md](move/REVIEW.md) (Move security review).

## Contract interface: one file

All function ids, decimals and trading constants used by the web app **and** the keeper are in
[`web/src/config/contract.ts`](web/src/config/contract.ts). The keeper imports that file (and the
shared price and PnL helpers in `web/src/lib/`) directly. If the Move code renames something, edit
that file only.

Quick check that every configured id still exists in the Move sources:

```bash
grep -oE '"(test_usdc|oracle|exchange|paper|hedge)::[a-z_]+"' web/src/config/contract.ts | tr -d '"' |
  while IFS=: read m _ f; do grep -qE "fun $f\(" move/sources/$m.move || echo "MISSING $m::$f"; done
```

## Prerequisites

- Node.js ≥ 20.9
- A published `papertrade` package on testnet (see `move/`). Its address is `MODULE_ADDR` below.
- A testnet wallet: Petra or any AIP-62 wallet, set to **Testnet**. Fund it with APT from the
  [testnet faucet](https://aptos.dev/network/faucet).

## Price sources

`web/src/lib/prices/index.ts` defines a `PriceSource` interface with two implementations, and
`AutoPriceSource` picks one automatically:

1. **DecibelSource**: `GET https://api.testnet.aptoslabs.com/decibel/api/v1/prices` with
   `Authorization: Bearer <DECIBEL_NODE_API_KEY>`. If the response is keyed by market address,
   names are resolved through `/markets`. Without a key the API returns 401.
2. **HyperliquidSource** (fallback): `POST https://api.hyperliquid.xyz/info {"type":"allMids"}`, BTC/ETH.

The first source that answers wins. A failed source is retried after 60 s, so the app switches back
to Decibel once it recovers. The source in use is shown in the header (`via decibel|hyperliquid`)
and in the keeper logs.

In the browser, Decibel is called through the Next route `/api/decibel/[prices|markets]`. The route
adds the key on the server, so the key never reaches the client bundle. It reads
`DECIBEL_NODE_API_KEY`, then `NEXT_PUBLIC_DECIBEL_NODE_API_KEY` if that is all you have. Both are
read only on the server. With no key, the route answers 503 and the client falls back to Hyperliquid.

## Web

```bash
cd web
cp .env.example .env.local      # set NEXT_PUBLIC_MODULE_ADDR, optionally DECIBEL_NODE_API_KEY
npm install
npm run dev                     # http://localhost:3000
npm run build && npm start      # production
```

| Env var                    | Required | Notes                                         |
| -------------------------- | -------- | --------------------------------------------- |
| `NEXT_PUBLIC_MODULE_ADDR`  | yes      | package address                               |
| `DECIBEL_NODE_API_KEY`     | no       | server-only, used by `/api/decibel/*`         |
| `NEXT_PUBLIC_APTOS_API_KEY`| no       | Aptos node API key (avoids rate limits)       |
| `NEXT_PUBLIC_HEDGER_ADDR`  | for hedge| public address of the hedger service users delegate to |
| `NEXT_PUBLIC_DECIBEL_PACKAGE` | no    | Decibel package override (default: live testnet `0xd368…7bd1`) |
| `HEDGE_STATE_PATH`         | no       | hedger state file served by `/api/hedge/status` (default `../keeper/hedge-state.json`) |

Features:

- **Connect wallet** via `@aptos-labs/wallet-adapter-react`, testnet. Lists installed wallets and
  links to install others.
- **Faucet**: `test_usdc::faucet` gives a fixed amount once per cooldown. The button shows the
  time remaining.
- **Deposit / withdraw** between your wallet and your exchange trading balance.
- **Trade panel**: BTC/ETH, long/short, margin (minimum 10 USDC), leverage slider from 1 to 1000x
  with presets. It previews size, live mark, on-chain oracle (entry) price with its age, and the
  estimated liquidation price. Opening is disabled while the oracle is stale, because the contract
  would abort.
- **Positions**: size, margin, entry, live mark, liquidation price (from
  `exchange::liquidation_price`), and live PnL with ROE. Profit is shown net of the 2% fee and
  losses are capped at margin. Each row has a close button.
- **SEEDS**: balance (non-transferable), staked amount with your share of the pool, claimable USDC
  rewards, and stake / unstake / claim.
- **House pool**: pool and vault balances, trader balances, locked margin, fee split, SEEDS supply
  and staked, open interest per market against the cap, and the **payout queue** (first 25
  entries, total owed). It also has a permissionless **Crank** button (`process_queue`).

- **Hedge on Decibel** (toggle in the trade panel): shows the Decibel side, size (lot-rounded), margin at your
  Decibel leverage, estimated fees (taker, open + close) and baseline funding per day. Opening with the toggle on
  sends `hedge::open_position_hedged`. The **Hedge panel** walks through the one-time Decibel setup, with every
  step signed in your wallet: create or select a Trading Account, mint test USDC, deposit, set leverage, and allow
  the hedger per market with an expiry (revocable). Positions show each hedge's status (hedged / hedging… / **hedge
  failed** with the reason / orphaned), and a net-exposure table with Tree Trade Δ, Decibel position, net Δ and
  combined PnL.

Chain state is polled every 5 s, Decibel state every 10 s, and prices every 3 s. If any view call fails (for example, a wrong
`MODULE_ADDR`), the errors are listed at the bottom of the page.

## Keeper

```bash
cd keeper
cp .env.example .env            # set MODULE_ADDR and a key (or APTOS_PROFILE)
npm install
npm run dry-run                 # log only: no transactions
npm start                       # live
npx tsx src/index.ts --once     # single iteration
npx tsx src/index.ts --interval 5
npm run typecheck
```

On each iteration (default every `PUSH_INTERVAL_SECS` = 10 s; the oracle goes stale after 60 s) the
keeper:

1. Fetches BTC/ETH prices using the same auto-selected source as the web app. Decibel is tried
   first only when `DECIBEL_NODE_API_KEY` is set.
2. Calls `oracle::push_prices(btc, eth, publish_time)` with prices scaled to 1e8.
   `publish_time` comes from the ledger clock, so it is never "in the future" on-chain.
3. Scans open positions and liquidates the ones that qualify:
   - The contract has no all-positions view, and the indexer `events` table is deprecated. So
     traders are discovered from indexed `exchange::open_position` and `hedge::open_position_hedged`
     user transactions, and `exchange::user_positions(owner)` lists their open ids.
   - For each position, `exchange::is_liquidatable(id)` decides. If that view aborts (for example,
     the oracle is stale in dry-run), the keeper uses a local estimate with the same math.
   - Each liquidation is **simulated** first and only submitted if the simulation succeeds, so no
     gas is spent on reverts.

`--dry-run` pushes nothing and liquidates nothing. It logs the `push_prices` call it would send. If
a key is available, it also prints the simulation result for each liquidation it would make.

Signer (first match wins):

1. `KEEPER_PRIVATE_KEY`: ed25519 key, hex or AIP-80 (`ed25519-priv-0x…`)
2. `APTOS_PROFILE` (default `default`) from `APTOS_CONFIG_PATH`, or from the first
   `.aptos/config.yaml` found in `keeper/`, `move/`, the repo root, or `~`

The keeper account must be allowed to push prices. Use the publisher (oracle admin), or register
the keeper once from the admin account:

```bash
aptos move run --function-id $MODULE_ADDR::oracle::add_keeper --args address:<KEEPER_ADDR> --profile <admin>
```

| Env var                | Notes                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| `MODULE_ADDR`          | or `NEXT_PUBLIC_MODULE_ADDR`. `web/.env.local` is also read.              |
| `KEEPER_PRIVATE_KEY`   | or `APTOS_PROFILE` / `APTOS_CONFIG_PATH`                                  |
| `DECIBEL_NODE_API_KEY` | optional, enables Decibel prices                                          |
| `APTOS_API_KEY`        | optional node API key                                                     |
| `PUSH_INTERVAL_SECS`   | default 10                                                                |
| `KEEPER_START_VERSION` | optional, the ledger version to start trader discovery from. Defaults to the package account's first transaction, else the last 2M versions. |

## Hedger

A separate process in `keeper/` (`src/hedge/hedger.ts`, supervisor `run-hedger.sh`, log `hedger.log`). Every
`HEDGE_INTERVAL_SECS` (15) it reads `hedge::active_requests`, computes for each (Decibel Trading Account,
market) the target `−Σ notional/entry` of the open hedged positions, rounded to lots, compares it with the
on-chain Decibel position, and trades only the difference (IOC, reduce-only for reductions). Closed or
liquidated positions are flattened and their requests pruned on-chain. Details: [HEDGE_DESIGN.md](HEDGE_DESIGN.md).

```bash
cd keeper
npm test                               # unit tests (sizing, delegation parsing, sync with a mock Decibel)
npm run hedger -- --once               # one tick; live if HEDGER_PRIVATE_KEY is set, else mock
npm run hedger -- --mock               # force the in-memory Decibel client
nohup setsid ./run-hedger.sh >> hedger.log 2>&1 < /dev/null &  echo $! > hedger.pid
npx tsx src/hedge/probe.ts             # Decibel capability probe (box-generated accounts)
npx tsx src/hedge/hedge-e2e.ts         # live E2E: open/close, no-delegation, liquidation
```

| Env var              | Notes                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| `HEDGER_PRIVATE_KEY` | hedger service key (ed25519, AIP-80 ok). Unset → mock mode                  |
| `HEDGE_INTERVAL_SECS`| default 15                                                                  |
| `HEDGE_SLIPPAGE_BPS` | IOC price band around the Decibel mark, default 100                         |
| `DECIBEL_PACKAGE`    | Decibel package override                                                    |
| `HEDGE_STATE_PATH`   | default `keeper/hedge-state.json`                                           |
| `APTOS_API_KEY`      | Geomi node key, strongly recommended: keeper + hedger share the anonymous 40k CU / 5 min per-IP limit |

No Decibel REST key is needed: the hedger writes through `@decibeltrade/sdk` over the public fullnode and reads
`#[view]` functions.

## End-to-end on testnet

1. Publish `move/` (for example `aptos move publish --named-addresses papertrade=<addr>`) and note
   the address.
2. Seed the house pool so winners can be paid: `exchange::fund_pool(amount)`, using USDC from
   `test_usdc::mint` as admin.
3. Start the keeper (`npm start` in `keeper/`). Opening positions needs a fresh oracle price.
4. `npm run dev` in `web/`, connect your wallet, use the faucet, deposit, and trade.
5. For hedging: set `HEDGER_PRIVATE_KEY` in `keeper/.env` (fund it with ~0.5 APT), start `run-hedger.sh`, and
   set `NEXT_PUBLIC_HEDGER_ADDR` in `web/.env.local`.

> **Naming:** the reward token is shown as **SEEDS** in the app and docs. On-chain it is still the `paper` Move module (no republish was needed: SEEDS balances are internal resources, not a fungible asset with metadata).

## Backup / quick start

- Live site: https://tree-trade-murex.vercel.app
- Keeper (price pusher + liquidator): `cd keeper && npm ci && cp .env.example .env` (fill in values), then `./run.sh`
- Hedger (Decibel): `cd keeper && ./run-hedger.sh`
- Web: `cd web && npm ci && cp .env.example .env.local && npm run dev`

Env vars needed (names only, see the `.env.example` files): APTOS_API_KEY APTOS_PROFILE DECIBEL_NODE_API_KEY HEDGER_PRIVATE_KEY HEDGE_INTERVAL_SECS HEDGE_SLIPPAGE_BPS KEEPER_PRIVATE_KEY MODULE_ADDR NEXT_PUBLIC_HEDGER_ADDR NEXT_PUBLIC_MODULE_ADDR PUSH_INTERVAL_SECS 

Secrets (private keys, API keys, .aptos/config.yaml, state files) are never committed.
