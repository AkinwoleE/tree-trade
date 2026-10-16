/**
 * Decibel (testnet) interface used by the web app and shared with the keeper's hedger.
 *
 * The web app cannot import @decibeltrade/sdk: the SDK peers on @aptos-labs/ts-sdk ^7 while the wallet adapter
 * peers on ^5. Addresses are derived here exactly like the SDK does (constants.ts / utils.ts getMarketAddr), and
 * keeper/src/hedge/hedge.test.ts asserts they match the SDK's helpers.
 *
 * Package: docs (contract-reference) and SDK 0.8.2 still list 0xe7da…1b7f, which has no modules after the
 * 2026-10 testnet redeploy; the live package comes from testnet-app.decibel.trade's bundled config.
 */
import { AccountAddress, MoveString, createObjectAddress } from "@aptos-labs/ts-sdk";

export const DECIBEL_PACKAGE: string =
  process.env.NEXT_PUBLIC_DECIBEL_PACKAGE ||
  process.env.DECIBEL_PACKAGE ||
  "0xd368b820fdfbfe004679cdb0facef4b920c4fc0c2c80bd2fecf3843a93427bd1";

/** Hedger service address that users delegate to (public; its key lives only in keeper/.env). */
export const HEDGER_ADDR: string = process.env.NEXT_PUBLIC_HEDGER_ADDR || process.env.HEDGER_ADDR || "";

const seed = (s: string) => new TextEncoder().encode(s);
export const DECIBEL_USDC = createObjectAddress(AccountAddress.from(DECIBEL_PACKAGE), seed("USDC")).toString();
export const DECIBEL_PERP_ENGINE_GLOBAL = createObjectAddress(AccountAddress.from(DECIBEL_PACKAGE), seed("GlobalPerpEngine")).toString();

/** docs.decibel.trade/developer-hub/on-chain/overview/contract-reference "Get Market Address". */
export const decibelMarketAddr = (name: string) =>
  createObjectAddress(AccountAddress.from(DECIBEL_PERP_ENGINE_GLOBAL), new MoveString(name).bcsToBytes()).toString();

export const dfn = (id: string): `${string}::${string}::${string}` => `${DECIBEL_PACKAGE}::${id}` as `${string}::${string}::${string}`;

/** Entry functions (dex_accounts_entry ABI on chain; docs.decibel.trade/developer-hub/on-chain/account-management/*). */
export const DECIBEL_ENTRY = {
  restrictedMint: "usdc::restricted_mint", // (amount: u64)  testnet only
  createSubaccount: "dex_accounts_entry::create_new_subaccount", // ()
  deposit: "dex_accounts_entry::deposit_to_subaccount_at", // (subaccount: address, asset: Object<Metadata>, amount: u64)
  withdraw: "dex_accounts_entry::withdraw_from_cross_collateral", // (subaccount, asset, amount)
  configureMarket: "dex_accounts_entry::configure_user_settings_for_market", // (subaccount: address, market, is_cross: bool, leverage: u8)
  /** Scoped consent: perp trading on one market only, optional expiry. Not wrapped by SDK 0.8.2. */
  delegateMarket: "dex_accounts_entry::delegate_perp_trading_to_market_for_subaccount", // (subaccount, delegate, market, Option<u64>)
  revoke: "dex_accounts_entry::revoke_delegation", // (subaccount: Object<Subaccount>, delegate)
  /**
   * One-click hedging: Decibel's native one-shot onboarding entry (live dex_accounts_entry ABI). On the user's
   * primary Trading Account it creates the account if missing, deposits, and delegates trading to `delegate`
   * with an expiry, all in one signature. (subaccount: address, asset, amount: u64, delegate, Option<u64>)
   * Only the primary subaccount can be created lazily (a seeded one aborts ESUBACCOUNT_DOESNT_EXIST).
   */
  oneClickSetup: "dex_accounts_entry::add_delegated_trader_and_deposit_to_subaccount",
} as const;

export const DECIBEL_VIEW = {
  marketSzDecimals: "perp_engine::market_sz_decimals",
  marketLotSize: "perp_engine::market_lot_size",
  marketMinSize: "perp_engine::market_min_size",
  marketTickSize: "perp_engine::market_ticker_size",
  marketMaxLeverage: "perp_engine::market_max_leverage",
  marketMinPrice: "perp_engine::market_min_price",
  marketMaxPrice: "perp_engine::market_max_price",
  markPrice: "perp_engine::get_mark_price", // (market): u64
  viewPosition: "perp_engine::view_position", // (account, market): Option<PositionViewInfo>
  fundingCost: "perp_engine::get_position_unrealized_funding_cost", // (account, market): i64
  collateral: "perp_engine::get_cross_total_collateral_value", // (account): i64
  remainingSize: "perp_engine::get_remaining_size_for_order", // (market, order_id: u128): u64
  delegations: "dex_accounts::view_delegated_permissions", // (subaccount): OrderedMap<address, DelegatedPermissions>
  primarySubaccount: "dex_accounts::primary_subaccount", // (owner): address
  mintAvailable: "usdc::available_restricted_mint_for", // (owner): u64
} as const;

export const SUBACCOUNT_RESOURCE = () => `${DECIBEL_PACKAGE}::dex_accounts::Subaccount`;
export const DECIBEL_APP_URL = "https://testnet-app.decibel.trade/trade";
