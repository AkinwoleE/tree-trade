/**
 * Single source of truth for the on-chain `papertrade` package interface
 * (../move/sources). Shared by ./web and ./keeper — the keeper imports this file.
 *
 * If the Move code changes a function name, edit it here. Entries are
 * `module::function`; the package address is prefixed at runtime by `fn()`.
 */

export const MODULE_ADDR: string =
  process.env.NEXT_PUBLIC_MODULE_ADDR || process.env.MODULE_ADDR || "0x0";

/** Market ids as passed to the contract (`market: u8`). */
export const MARKETS = { BTC: 0, ETH: 1 } as const;
export type MarketSymbol = keyof typeof MARKETS;
export const MARKET_SYMBOLS = Object.keys(MARKETS) as MarketSymbol[];
export const marketSymbol = (id: number): MarketSymbol | undefined =>
  MARKET_SYMBOLS.find((s) => MARKETS[s] === id);

/** Fixed-point conventions (oracle.move / test_usdc.move / paper.move). */
export const PRICE_DECIMALS = 8;
export const USDC_DECIMALS = 6;
export const PAPER_DECIMALS = 6;

/** Trading rules mirrored from exchange.move (used for previews only; the chain is authoritative). */
export const MIN_LEVERAGE = 1;
export const MAX_LEVERAGE = 1000;
export const MIN_MARGIN_USDC = 10;
/** Position value (margin x leverage) limits, Paper Trade #/intro/faq + live minimumOpenNotional. */
export const MIN_NOTIONAL_USDC = 1_000;
export const MAX_NOTIONAL_USDC = 10_000_000;
/** Hard-bust buffer per market (fraction of price), Paper Trade live bustBuffer. */
export const BUST_BUFFER: Record<string, number> = { BTC: 0.00047604158008757, ETH: 0.00048130405018013 };
/** Fee on realized profit. */
export const FEE_BPS = 200;
/** Asymmetric impact on wins (Paper Trade launch params; exchange V2). */
export const IMPACT = { baseRate: 0.1, rateMult: 15_000, nref: 100_000, posMult: { BTC: 814.598, ETH: 483.979 } as Record<string, number> };
/** LP cap: tracked LP above this is swept to stakers. */
export const LP_CAP_USDC = 5_000_000;
/** Maintenance margin: 0.5% of notional, capped at 50% of margin. */
export const MAINT_BPS = 50;
export const MAX_POSITIONS_PER_USER = 32;
/** process_queue max_steps upper bound. */
export const MAX_CRANK_STEPS = 200;

/** Entry functions (signer is implicit). */
export const ENTRY = {
  faucet: "test_usdc::faucet", // () — mints the configured amount, once per cooldown
  pushPrice: "oracle::push_price", // (market: u8, price: u64, publish_time: u64)  keeper/admin only
  pushPrices: "oracle::push_prices", // (btc_price: u64, eth_price: u64, publish_time: u64)  keeper/admin only
  deposit: "exchange::deposit", // (amount: u64)
  withdraw: "exchange::withdraw", // (amount: u64)
  gatewayWrapAndDeposit: "usdc_gateway::wrap_and_deposit", // (amount: u64) Circle USDC -> collateral
  gatewayWrap: "usdc_gateway::wrap", // (amount: u64)
  gatewayUnwrap: "usdc_gateway::unwrap", // (amount: u64) test_usdc -> Circle USDC
  openPosition: "exchange::open_position", // (market: u8, is_long: bool, margin: u64, leverage: u64)
  closePosition: "exchange::close_position", // (position_id: u64)
  liquidate: "exchange::liquidate", // (position_id: u64)  permissionless
  processQueue: "exchange::process_queue", // (max_steps: u64)  permissionless crank
  stake: "paper::stake", // (amount: u64)
  unstake: "paper::unstake", // (amount: u64)
  claim: "paper::claim", // ()  claims USDC rewards
  openPositionHedged: "hedge::open_position_hedged", // (market: u8, is_long: bool, margin: u64, leverage: u64, subaccount: address)
  requestHedge: "hedge::request_hedge", // (position_id: u64, subaccount: address)  owner only
  cancelHedge: "hedge::cancel_hedge", // (position_id: u64)  owner only
  delegateTrading: "exchange::delegate_trading_to", // (delegate: address, expires_at: Option<u64>)  owner only, 1-click trading
  revokeDelegation: "exchange::revoke_delegation", // (delegate: address)
  revokeAllDelegations: "exchange::revoke_all_delegations", // ()
  openPositionAsDelegate: "exchange::open_position_as_delegate", // (owner, market, is_long, margin, leverage)  delegate only
  closePositionAsDelegate: "exchange::close_position_as_delegate", // (owner, position_id)  delegate only
  openFromQueue: "exchange::open_position_from_queue", // (market, is_long, margin, leverage) margin = queued balance
  openFromQueueAsDelegate: "exchange::open_position_from_queue_as_delegate", // (owner, market, is_long, margin, leverage)
  // V4 signed-price variants: same args + (price: u64, publish_time: u64, signature: vector<u8>) from /api/price-sig.
  openPositionPx: "exchange::open_position_px",
  closePositionPx: "exchange::close_position_px",
  openFromQueuePx: "exchange::open_position_from_queue_px",
  openPositionHedgedPx: "hedge::open_position_hedged_px",
  openPositionAsDelegatePx: "exchange::open_position_as_delegate_px",
  closePositionAsDelegatePx: "exchange::close_position_as_delegate_px",
  openFromQueueAsDelegatePx: "exchange::open_position_from_queue_as_delegate_px",
  openPositionHedgedAsDelegatePx: "hedge::open_position_hedged_as_delegate_px",
  // (delegate, expires_at: u64 <= now+7d, allow_hedge, allow_queue)
  delegateTradingWithScope: "exchange::delegate_trading_with_scope",
  setSideCaps: "exchange::set_side_caps", // (market, long_cap_qty: u128, short_cap_qty: u128)  market keeper only
  pruneHedge: "hedge::prune", // (position_id: u64)  permissionless, position must be closed
} as const;

/** #[view] functions. */
export const VIEW = {
  // test_usdc
  usdcBalance: "test_usdc::balance", // (owner): u64
  faucetCooldown: "test_usdc::faucet_cooldown_remaining", // (owner): u64 seconds
  faucetConfig: "test_usdc::faucet_config", // (): (amount, cooldown_secs)
  // oracle
  priceInfo: "oracle::price_info", // (market: u8): (price, publish_time)
  maxStaleness: "oracle::max_staleness", // (): u64 seconds
  // exchange
  tradingBalance: "exchange::balance_of", // (owner): u64
  userPositions: "exchange::user_positions", // (owner): vector<u64>
  openPositions: "exchange::open_positions", // (start_id, max_ids): batched open positions + liq prices, next scan id, next_position_id
  getPosition: "exchange::get_position", // (id): (owner, market, is_long, margin, leverage, notional: u128, entry_price, opened_at)
  positionExists: "exchange::position_exists", // (id): bool
  isLiquidatable: "exchange::is_liquidatable", // (id): bool  (aborts if oracle price stale)
  liquidationPrice: "exchange::liquidation_price", // (id): u64
  poolBalance: "exchange::pool_balance", // (): u64
  queueState: "exchange::queue_state", // (): (head, tail, total_owed: u128)
  queueEntry: "exchange::queue_entry", // (index): (owner, position_id, original, remaining)
  openInterest: "exchange::open_interest", // (market: u8): (long: u128, short: u128, cap)
  accounting: "exchange::accounting", // (): (vault, total_balances, total_margin, pool, dev_fees)
  feeStats: "exchange::fee_stats", // (): (total_to_stakers, total_to_dev)
  isPaused: "exchange::is_paused", // (): bool
  // paper
  paperBalance: "paper::balance_of", // (owner): u64  (PAPER is non-transferable)
  staked: "paper::staked_of", // (owner): u64
  pendingRewards: "paper::pending_rewards", // (owner): u64  claimable USDC
  paperTotalSupply: "paper::total_supply", // (): u64
  paperTotalStaked: "paper::total_staked", // (): u64
  rewardStats: "paper::reward_stats", // (): (total_deposited, total_claimed, vault_balance) USDC
  // SEEDS mint curve (tokenomics.move)
  seedsRate: "exchange::seeds_rate", // (): (tracked_lp: u128, is_negative, rate_e6 SEEDS per $1)
  curveParams: "tokenomics::params", // (): (flat_rate, threshold, scale, tail_progress, total_minted, total_basis)
  queuedBalanceOf: "exchange::queued_balance_of", // (owner): (queued_total, first_index, usdc_ahead: u128, entries)
  v2State: "exchange::v2_state", // (): (debt_margin, seed_removed, base_rate_bps, rate_mult, nref_usd, pos_mult_k)
  quoteClose: "exchange::quote_close", // (id): (adjusted_profit, win_fee)
  isDebtPosition: "exchange::is_debt_position", // (id): bool
  riskParams: "exchange::risk_params", // (): (market_keeper, min_notional, max_notional, bust_buffer_wad[])
  sideOi: "exchange::side_oi", // (market): (long_qty, short_qty, long_cap_qty, short_cap_qty) 1e-8 asset units
  delegationOf: "exchange::delegation_of", // (owner, delegate): (active: bool, expires_at)
  delegatesOf: "exchange::delegates_of", // (owner): (delegates, expiries)
  // hedge
  hedgeRequests: "hedge::active_requests", // (): (position_ids, owners, subaccounts)
  hedgeRequestOf: "hedge::request_of", // (id): (exists, owner, subaccount, requested_at)
} as const;

export const fn = (id: string): `${string}::${string}::${string}` =>
  `${MODULE_ADDR}::${id}` as `${string}::${string}::${string}`;
