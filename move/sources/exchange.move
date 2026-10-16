/// Synthetic perpetuals "casino" settled in test USDC against a house pool.
///
/// Money flow (all USDC sits in a single vault object; buckets are tracked internally):
///   vault balance == total_balances + total_margin + pool + dev_fees
///
/// * Traders deposit USDC into a trading balance, then open long/short positions at the
///   oracle price with leverage 1..=1000 and margin >= 10 USDC.
/// * Winners: margin is returned, profit (minus a 2% fee on profit) is paid from the pool.
///   If the pool cannot cover it, the unpaid remainder joins a FIFO payout queue that is
///   paid by later pool inflows (losses / donations).
/// * Losers: loss goes to the pool minus a 2% fee; the trader is minted PAPER.
/// * Fees are split 50/50 between PAPER stakers and the dev treasury (stakers' half goes
///   to the dev treasury when nothing is staked).
/// * Pool is capped at 5M USDC; excess is swept to stakers.
/// * Anyone may liquidate a position whose equity <= maintenance margin; the whole margin
///   is lost to the pool (2% fee on it).
module papertrade::exchange {
    use std::option::{Self, Option};
    use std::signer;
    use std::vector;
    use aptos_std::table::{Self, Table};
    use aptos_framework::event;
    use aptos_framework::object::{Self, ExtendRef};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;
    use papertrade::oracle;
    use papertrade::paper;
    use papertrade::tokenomics;
    use papertrade::test_usdc;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    const VAULT_SEED: vector<u8> = b"PAPERTRADE_EXCHANGE_VAULT";
    const BPS: u128 = 10_000;
    const MIN_MARGIN: u64 = 10_000_000; // 10 USDC
    const MIN_LEVERAGE: u64 = 1;
    const MAX_LEVERAGE: u64 = 1000;
    /// 2% fee on realized profit / on pool gain from losses.
    const FEE_BPS: u128 = 200;
    /// Maintenance margin: 0.5% of notional (capped at 50% of margin, see `maintenance`).
    const MAINT_BPS: u128 = 50;
    /// House pool cap: 5M USDC.
    const LP_CAP: u64 = 5_000_000_000_000;
    /// Default per-market, per-side open interest cap (notional): 50M USDC.
    const DEFAULT_OI_CAP: u64 = 50_000_000_000_000;
    const MAX_POSITIONS_PER_USER: u64 = 32;
    /// Queue entries processed automatically on each pool inflow.
    const AUTO_QUEUE_STEPS: u64 = 16;
    /// Upper bound for a single permissionless crank call.
    const MAX_CRANK_STEPS: u64 = 200;
    const U64_MAX: u128 = 18446744073709551615;
    /// Owner of the vault object after init. No signer exists for it, so nobody but the
    /// vault's own (ExtendRef-derived) signer can withdraw from the vault store.
    const VAULT_OWNER: address = @0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    const E_NOT_ADMIN: u64 = 1;
    const E_ZERO_AMOUNT: u64 = 2;
    const E_INSUFFICIENT_BALANCE: u64 = 3;
    const E_INVALID_MARKET: u64 = 4;
    const E_INVALID_LEVERAGE: u64 = 5;
    const E_MARGIN_TOO_SMALL: u64 = 6;
    const E_OI_CAP_EXCEEDED: u64 = 7;
    const E_POSITION_NOT_FOUND: u64 = 8;
    const E_NOT_POSITION_OWNER: u64 = 9;
    const E_NOT_LIQUIDATABLE: u64 = 10;
    const E_PAUSED: u64 = 11;
    const E_TOO_MANY_POSITIONS: u64 = 12;
    const E_POOL_CAP_EXCEEDED: u64 = 13;
    const E_INVALID_STEPS: u64 = 14;
    const E_NOT_PENDING_ADMIN: u64 = 15;
    const E_INSUFFICIENT_DEV_FEES: u64 = 16;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    struct Position has store, copy, drop {
        id: u64,
        owner: address,
        market: u8,
        is_long: bool,
        margin: u64,
        leverage: u64,
        /// margin * leverage; u128 since it can exceed u64.
        notional: u128,
        entry_price: u64,
        opened_at: u64,
    }

    struct QueueEntry has store, drop {
        owner: address,
        position_id: u64,
        original: u64,
        remaining: u64,
    }

    struct Exchange has key {
        admin: address,
        pending_admin: Option<address>,
        paused: bool,
        vault_extend_ref: ExtendRef,
        vault: address,
        // Trading balances.
        balances: Table<address, u64>,
        total_balances: u64,
        // Positions.
        positions: Table<u64, Position>,
        user_positions: Table<address, vector<u64>>,
        next_position_id: u64,
        total_margin: u64,
        long_oi: vector<u128>,
        short_oi: vector<u128>,
        oi_caps: vector<u64>,
        // House pool and fees.
        pool: u64,
        dev_fees: u64,
        // FIFO payout queue: entries in [queue_head, queue_tail).
        queue: Table<u64, QueueEntry>,
        queue_head: u64,
        queue_tail: u64,
        queue_owed: u128,
        // Stats.
        // Lifetime counters are u128 so they can never overflow and block settlement.
        total_staker_rewards: u128,
        total_dev_fees_accrued: u128,
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    #[event]
    struct Deposited has drop, store { user: address, amount: u64 }

    #[event]
    struct Withdrawn has drop, store { user: address, amount: u64 }

    #[event]
    struct PositionOpened has drop, store {
        id: u64,
        owner: address,
        market: u8,
        is_long: bool,
        margin: u64,
        leverage: u64,
        notional: u128,
        entry_price: u64,
    }

    #[event]
    struct PositionClosed has drop, store {
        id: u64,
        owner: address,
        market: u8,
        is_long: bool,
        margin: u64,
        entry_price: u64,
        exit_price: u64,
        is_profit: bool,
        /// Gross profit (if is_profit) or realized loss (capped at margin).
        pnl: u64,
        fee: u64,
        /// Amount credited to the trading balance now (incl. returned margin).
        paid_now: u64,
        /// Amount pushed to the payout queue.
        queued: u64,
        paper_minted: u64,
    }

    #[event]
    struct PositionLiquidated has drop, store {
        id: u64,
        owner: address,
        liquidator: address,
        market: u8,
        margin: u64,
        exit_price: u64,
        fee: u64,
        paper_minted: u64,
    }

    #[event]
    struct QueueEntryAdded has drop, store {
        index: u64,
        owner: address,
        position_id: u64,
        amount: u64,
    }

    #[event]
    struct QueuePaid has drop, store {
        index: u64,
        owner: address,
        amount: u64,
        remaining: u64,
    }

    #[event]
    struct FeesDistributed has drop, store { to_stakers: u64, to_dev: u64 }

    #[event]
    struct PoolSwept has drop, store { amount: u64 }

    #[event]
    struct PoolFunded has drop, store { funder: address, amount: u64 }

    #[event]
    struct DevFeesWithdrawn has drop, store { to: address, amount: u64 }

    // ---------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------

    fun init_module(deployer: &signer) {
        let cref = object::create_named_object(deployer, VAULT_SEED);
        let vault = object::address_from_constructor_ref(&cref);
        primary_fungible_store::ensure_primary_store_exists(vault, test_usdc::metadata());
        let vault_extend_ref = object::generate_extend_ref(&cref);
        // Object ownership is transitive: if the deployer kept owning the vault object it
        // could call fungible_asset::withdraw on the vault store and bypass all accounting.
        let transfer_ref = object::generate_transfer_ref(&cref);
        object::disable_ungated_transfer(&transfer_ref);
        object::transfer_with_ref(object::generate_linear_transfer_ref(&transfer_ref), VAULT_OWNER);
        let n = (oracle::num_markets() as u64);
        let long_oi = vector::empty<u128>();
        let short_oi = vector::empty<u128>();
        let oi_caps = vector::empty<u64>();
        let i = 0;
        while (i < n) {
            vector::push_back(&mut long_oi, 0);
            vector::push_back(&mut short_oi, 0);
            vector::push_back(&mut oi_caps, DEFAULT_OI_CAP);
            i = i + 1;
        };
        move_to(deployer, Exchange {
            admin: signer::address_of(deployer),
            pending_admin: option::none(),
            paused: false,
            vault_extend_ref,
            vault,
            balances: table::new(),
            total_balances: 0,
            positions: table::new(),
            user_positions: table::new(),
            next_position_id: 1,
            total_margin: 0,
            long_oi,
            short_oi,
            oi_caps,
            pool: 0,
            dev_fees: 0,
            queue: table::new(),
            queue_head: 0,
            queue_tail: 0,
            queue_owed: 0,
            total_staker_rewards: 0,
            total_dev_fees_accrued: 0,
        });
    }

    // ---------------------------------------------------------------------
    // Balances
    // ---------------------------------------------------------------------

    public entry fun deposit(user: &signer, amount: u64) acquires Exchange {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let ex = borrow_global_mut<Exchange>(@papertrade);
        assert!(!ex.paused, E_PAUSED);
        let addr = signer::address_of(user);
        primary_fungible_store::transfer(user, test_usdc::metadata(), ex.vault, amount);
        credit(ex, addr, amount);
        event::emit(Deposited { user: addr, amount });
    }

    /// Withdraw from the trading balance. Always allowed (even when paused).
    public entry fun withdraw(user: &signer, amount: u64) acquires Exchange {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let ex = borrow_global_mut<Exchange>(@papertrade);
        let addr = signer::address_of(user);
        debit(ex, addr, amount);
        let vault_signer = object::generate_signer_for_extending(&ex.vault_extend_ref);
        primary_fungible_store::transfer(&vault_signer, test_usdc::metadata(), addr, amount);
        event::emit(Withdrawn { user: addr, amount });
    }

    /// Donate USDC to the house pool (no LP shares). Inflow first pays the payout queue.
    /// Aborts if the donation would push the pool above the 5M cap.
    /// Disabled once V2 (Paper Trade parity) is active: the LP can't be deposited into.
    public entry fun fund_pool(funder: &signer, amount: u64) acquires Exchange, V2 {
        assert!(!exists<V2>(@papertrade), E_LP_DEPOSITS_DISABLED);
        assert!(amount > 0, E_ZERO_AMOUNT);
        let ex = borrow_global_mut<Exchange>(@papertrade);
        let room = (LP_CAP as u128) + ex.queue_owed - (min_u64(ex.pool, LP_CAP) as u128);
        assert!((amount as u128) <= room, E_POOL_CAP_EXCEEDED);
        primary_fungible_store::transfer(funder, test_usdc::metadata(), ex.vault, amount);
        pool_inflow(ex, amount);
        event::emit(PoolFunded { funder: signer::address_of(funder), amount });
    }

    // ---------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------

    public entry fun open_position(
        user: &signer,
        market: u8,
        is_long: bool,
        margin: u64,
        leverage: u64,
    ) acquires Exchange, V3, V4 {
        open_position_for(signer::address_of(user), market, is_long, margin, leverage);
    }

    fun open_position_for(addr: address, market: u8, is_long: bool, margin: u64, leverage: u64) acquires Exchange, V3, V4 {
        open_core(addr, market, is_long, margin, leverage, false, legacy_open_price(market));
    }

    /// `from_queue`: margin is a queued claim already consumed by the caller (no cash debit).
    fun open_core(addr: address, market: u8, is_long: bool, margin: u64, leverage: u64, from_queue: bool, price: u64): u64 acquires Exchange, V3, V4 {
        let caps_live = side_caps_live(market);
        let ex = borrow_global_mut<Exchange>(@papertrade);
        assert!(!ex.paused, E_PAUSED);
        assert!(market < oracle::num_markets(), E_INVALID_MARKET);
        assert!(leverage >= MIN_LEVERAGE && leverage <= MAX_LEVERAGE, E_INVALID_LEVERAGE);
        assert!(margin >= MIN_MARGIN, E_MARGIN_TOO_SMALL);

        let notional = (margin as u128) * (leverage as u128);
        let m = (market as u64);
        let v3 = exists<V3>(@papertrade);
        if (v3) v3_on_open(m, is_long, notional, price);
        let cap = (*vector::borrow(&ex.oi_caps, m) as u128);
        let oi = if (is_long) vector::borrow_mut(&mut ex.long_oi, m) else vector::borrow_mut(&mut ex.short_oi, m);
        // With V3 the per-side cap is in base-asset quantity (v3_on_open). The legacy notional cap
        // (oi_caps) is the on-chain default whenever the market keeper's caps are not live (V4).
        assert!((v3 && caps_live) || *oi + notional <= cap, E_OI_CAP_EXCEEDED);
        *oi = *oi + notional;

        if (!from_queue) {
            debit(ex, addr, margin);
            ex.total_margin = ex.total_margin + margin;
        };

        let id = ex.next_position_id;
        ex.next_position_id = id + 1;
        table::add(&mut ex.positions, id, Position {
            id,
            owner: addr,
            market,
            is_long,
            margin,
            leverage,
            notional,
            entry_price: price,
            opened_at: timestamp::now_seconds(),
        });
        if (!table::contains(&ex.user_positions, addr)) {
            table::add(&mut ex.user_positions, addr, vector::empty());
        };
        let ids = table::borrow_mut(&mut ex.user_positions, addr);
        assert!(vector::length(ids) < MAX_POSITIONS_PER_USER, E_TOO_MANY_POSITIONS);
        vector::push_back(ids, id);

        event::emit(PositionOpened {
            id, owner: addr, market, is_long, margin, leverage, notional, entry_price: price,
        });
        id
    }

    /// Close own position at the oracle price.
    public entry fun close_position(user: &signer, position_id: u64) acquires Exchange, V2, V3, V4 {
        close_position_for(signer::address_of(user), position_id);
    }

    fun close_position_for(owner: address, position_id: u64) acquires Exchange, V2, V3, V4 {
        close_core(owner, position_id, false, 0, 0, vector::empty());
    }

    fun close_core(owner: address, position_id: u64, signed: bool, sprice: u64, sts: u64, ssig: vector<u8>) acquires Exchange, V2, V3, V4 {
        let market = {
            let ex = borrow_global<Exchange>(@papertrade);
            assert!(table::contains(&ex.positions, position_id), E_POSITION_NOT_FOUND);
            table::borrow(&ex.positions, position_id).market
        };
        let price = if (signed) oracle::verified_price(market, sprice, sts, ssig) else legacy_close_price(market);
        let mint_ok = hold_ok(position_id);
        let ex = borrow_global_mut<Exchange>(@papertrade);
        let pos = *table::borrow(&ex.positions, position_id);
        assert!(pos.owner == owner, E_NOT_POSITION_OWNER);
        let (lp0, neg0) = tracked_lp_signed(ex);
        let is_debt = remove_position(ex, &pos);

        let (is_profit, pnl_floor, pnl_ceil) = compute_pnl(&pos, price);
        // Paper Trade asymmetric impact (deadband + haircut) on winning closes, V2 only.
        let profit = if (is_profit) clamp_u64(pnl_floor) else 0;
        if (is_profit && exists<V2>(@papertrade)) {
            let adj = impact_adjusted(&pos, price);
            event::emit(WinImpact { id: pos.id, raw_profit: profit, adjusted: adj });
            profit = adj;
        };
        if (is_profit && profit > 0) {
            let (fee, paid_now, queued) = if (is_debt) settle_debt_close(ex, &pos, true, profit)
                else settle_profit(ex, &pos, profit);
            event::emit(PositionClosed {
                id: pos.id, owner: pos.owner, market: pos.market, is_long: pos.is_long,
                margin: pos.margin, entry_price: pos.entry_price, exit_price: price,
                is_profit: true, pnl: profit, fee, paid_now, queued, paper_minted: 0,
            });
        } else {
            // Loss rounded up (favours the pool) and capped at margin (bankrupt positions).
            let loss = if (is_profit) 0 else clamp_u64(min_u128(pnl_ceil, (pos.margin as u128)));
            if (is_debt) {
                let (fee, paid_now, queued) = settle_debt_close(ex, &pos, false, loss);
                let minted = if (loss > 0) mint_for_loss(ex, pos.owner, if (mint_ok) loss - fee else 0, loss, lp0, neg0, loss - fee) else 0;
                event::emit(PositionClosed {
                    id: pos.id, owner: pos.owner, market: pos.market, is_long: pos.is_long,
                    margin: pos.margin, entry_price: pos.entry_price, exit_price: price,
                    is_profit: false, pnl: loss, fee, paid_now, queued, paper_minted: minted,
                });
            } else {
                let (fee, minted) = settle_loss(ex, pos.owner, pos.margin, loss, false, mint_ok);
                event::emit(PositionClosed {
                    id: pos.id, owner: pos.owner, market: pos.market, is_long: pos.is_long,
                    margin: pos.margin, entry_price: pos.entry_price, exit_price: price,
                    is_profit: false, pnl: loss, fee, paid_now: pos.margin - loss, queued: 0,
                    paper_minted: minted,
                });
            }
        }
    }

    /// Permissionless liquidation when equity <= maintenance margin. Entire margin is lost.
    public entry fun liquidate(liquidator: &signer, position_id: u64) acquires Exchange, V2, V3, V4 {
        let mint_ok = hold_ok(position_id);
        let ex = borrow_global_mut<Exchange>(@papertrade);
        assert!(table::contains(&ex.positions, position_id), E_POSITION_NOT_FOUND);
        let pos = *table::borrow(&ex.positions, position_id);
        let price = oracle::get_price(pos.market);
        assert!(is_liquidatable_at(&pos, price), E_NOT_LIQUIDATABLE);
        let (lp0, neg0) = tracked_lp_signed(ex);
        let is_debt = remove_position(ex, &pos);
        let (fee, minted) = if (is_debt) {
            // Debt-funded: the whole queued claim used as margin is destroyed; no fee,
            // no cash; SEEDS on the full margin.
            (0, mint_for_loss(ex, pos.owner, if (mint_ok) pos.margin else 0, pos.margin, lp0, neg0, pos.margin))
        } else settle_loss(ex, pos.owner, pos.margin, pos.margin, true, mint_ok);
        event::emit(PositionLiquidated {
            id: pos.id, owner: pos.owner, liquidator: signer::address_of(liquidator),
            market: pos.market, margin: pos.margin, exit_price: price, fee, paper_minted: minted,
        });
    }

    /// Permissionless crank: pay up to `max_steps` queue entries from the pool, then
    /// sweep any excess above the cap.
    public entry fun process_queue(_caller: &signer, max_steps: u64) acquires Exchange, V2 {
        assert!(max_steps > 0 && max_steps <= MAX_CRANK_STEPS, E_INVALID_STEPS);
        let ex = borrow_global_mut<Exchange>(@papertrade);
        process_queue_internal(ex, max_steps);
        sweep_excess(ex);
    }

    // ---------------------------------------------------------------------
    // 1-click trading: session-key delegation (mirrors Decibel's
    // dex_accounts::delegate_trading_to_for_subaccount / revoke_delegation).
    //
    // The owner signs once to authorize a delegate address (a browser-held session key)
    // with an optional expiry. A delegate can ONLY open/close the owner's positions:
    // margin moves between the owner's trading balance and their positions inside the
    // vault, and settlement always credits `pos.owner`. Deposits, withdrawals, staking
    // and every other function keep taking the owner's own &signer, so a delegate can
    // never move funds out. Replay protection is Aptos's native per-sender sequence
    // number + tx expiration on the session key's own transactions.
    // ---------------------------------------------------------------------

    const E_NOT_DELEGATE: u64 = 17;
    const E_DELEGATION_EXPIRED: u64 = 18;
    const E_TOO_MANY_DELEGATES: u64 = 19;
    const E_BAD_EXPIRY: u64 = 20;
    const E_SELF_DELEGATE: u64 = 21;
    const MAX_DELEGATES: u64 = 8;

    struct Delegation has store, drop, copy { delegate: address, expires_at: u64 }

    /// Stored under the owner's account; only the owner's signer can create/modify it.
    struct TradingDelegates has key { entries: vector<Delegation> }

    #[event]
    struct TradingDelegated has drop, store { owner: address, delegate: address, expires_at: u64 }

    #[event]
    struct TradingDelegationRevoked has drop, store { owner: address, delegate: address }

    /// Authorize `delegate` to open/close positions for the signer. `expires_at` is unix
    /// seconds (none = no expiry). Re-delegating the same address updates its expiry.
    /// Expired entries are pruned on every call.
    public entry fun delegate_trading_to(owner: &signer, delegate: address, expires_at: Option<u64>) acquires TradingDelegates {
        let addr = signer::address_of(owner);
        assert!(delegate != addr, E_SELF_DELEGATE);
        let exp = if (option::is_some(&expires_at)) *option::borrow(&expires_at) else 0;
        let now = timestamp::now_seconds();
        // AUDIT L-5: every delegation expires, at most MAX_DELEGATION_SECS (+ clock slack) from now.
        assert!(exp > now && exp <= now + MAX_DELEGATION_SECS + DELEGATION_SLACK_SECS, E_BAD_EXPIRY);
        if (!exists<TradingDelegates>(addr)) move_to(owner, TradingDelegates { entries: vector::empty() });
        let entries = &mut borrow_global_mut<TradingDelegates>(addr).entries;
        prune_expired(entries, now);
        let (found, i) = find_delegate(entries, delegate);
        if (found) {
            vector::borrow_mut(entries, i).expires_at = exp;
        } else {
            assert!(vector::length(entries) < MAX_DELEGATES, E_TOO_MANY_DELEGATES);
            vector::push_back(entries, Delegation { delegate, expires_at: exp });
        };
        event::emit(TradingDelegated { owner: addr, delegate, expires_at: exp });
    }

    /// Revoke one delegate. No-op if absent.
    public entry fun revoke_delegation(owner: &signer, delegate: address) acquires TradingDelegates, DelegateScopes {
        let addr = signer::address_of(owner);
        if (!exists<TradingDelegates>(addr)) return;
        let entries = &mut borrow_global_mut<TradingDelegates>(addr).entries;
        let (found, i) = find_delegate(entries, delegate);
        if (found) {
            vector::swap_remove(entries, i);
            event::emit(TradingDelegationRevoked { owner: addr, delegate });
        };
        clear_scope(addr, delegate);
    }

    /// Revoke every delegate.
    public entry fun revoke_all_delegations(owner: &signer) acquires TradingDelegates, DelegateScopes {
        let addr = signer::address_of(owner);
        if (exists<DelegateScopes>(addr)) borrow_global_mut<DelegateScopes>(addr).entries = vector::empty();
        if (!exists<TradingDelegates>(addr)) return;
        let entries = &mut borrow_global_mut<TradingDelegates>(addr).entries;
        while (!vector::is_empty(entries)) {
            let d = vector::pop_back(entries);
            event::emit(TradingDelegationRevoked { owner: addr, delegate: d.delegate });
        };
    }

    /// Open a position on `owner`'s account, signed by an authorized delegate.
    public entry fun open_position_as_delegate(
        delegate: &signer, owner: address, market: u8, is_long: bool, margin: u64, leverage: u64,
    ) acquires Exchange, TradingDelegates, V3, V4 {
        assert_delegate(owner, signer::address_of(delegate));
        open_position_for(owner, market, is_long, margin, leverage);
    }

    /// Close one of `owner`'s positions, signed by an authorized delegate. Proceeds are
    /// credited to the owner's trading balance (never to the delegate).
    public entry fun close_position_as_delegate(delegate: &signer, owner: address, position_id: u64) acquires Exchange, TradingDelegates, V2, V3, V4 {
        assert_delegate(owner, signer::address_of(delegate));
        close_position_for(owner, position_id);
    }

    #[view]
    /// Expiry (unix secs, 0 = never) if `delegate` is currently authorized for `owner`.
    public fun delegation_of(owner: address, delegate: address): (bool, u64) acquires TradingDelegates {
        if (!exists<TradingDelegates>(owner)) return (false, 0);
        let entries = &borrow_global<TradingDelegates>(owner).entries;
        let (found, i) = find_delegate(entries, delegate);
        if (!found) return (false, 0);
        let exp = vector::borrow(entries, i).expires_at;
        let now = timestamp::now_seconds();
        (exp > now && exp <= now + MAX_DELEGATION_SECS + DELEGATION_SLACK_SECS, exp)
    }

    #[view]
    /// (delegates, expiries) including expired-but-unpruned entries.
    public fun delegates_of(owner: address): (vector<address>, vector<u64>) acquires TradingDelegates {
        let ds = vector::empty<address>();
        let es = vector::empty<u64>();
        if (exists<TradingDelegates>(owner)) {
            let entries = &borrow_global<TradingDelegates>(owner).entries;
            let i = 0;
            while (i < vector::length(entries)) {
                let d = vector::borrow(entries, i);
                vector::push_back(&mut ds, d.delegate);
                vector::push_back(&mut es, d.expires_at);
                i = i + 1;
            };
        };
        (ds, es)
    }

    fun assert_delegate(owner: address, delegate: address) acquires TradingDelegates {
        assert!(exists<TradingDelegates>(owner), E_NOT_DELEGATE);
        let entries = &borrow_global<TradingDelegates>(owner).entries;
        let (found, i) = find_delegate(entries, delegate);
        assert!(found, E_NOT_DELEGATE);
        let exp = vector::borrow(entries, i).expires_at;
        let now = timestamp::now_seconds();
        // Legacy never-expiring (0) or over-long delegations are no longer honoured.
        assert!(exp > now && exp <= now + MAX_DELEGATION_SECS + DELEGATION_SLACK_SECS, E_DELEGATION_EXPIRED);
    }

    fun find_delegate(entries: &vector<Delegation>, delegate: address): (bool, u64) {
        let i = 0;
        let n = vector::length(entries);
        while (i < n) {
            if (vector::borrow(entries, i).delegate == delegate) return (true, i);
            i = i + 1;
        };
        (false, 0)
    }

    fun prune_expired(entries: &mut vector<Delegation>, now: u64) {
        let i = 0;
        while (i < vector::length(entries)) {
            let exp = vector::borrow(entries, i).expires_at;
            if (exp != 0 && exp <= now) { vector::swap_remove(entries, i); } else { i = i + 1; };
        };
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    public entry fun set_oi_cap(admin: &signer, market: u8, cap: u64) acquires Exchange {
        let ex = borrow_global_mut<Exchange>(@papertrade);
        assert_admin(ex, admin);
        assert!(market < oracle::num_markets(), E_INVALID_MARKET);
        *vector::borrow_mut(&mut ex.oi_caps, (market as u64)) = cap;
    }

    /// Pausing blocks deposits and new positions; closes, liquidations and withdrawals
    /// stay available.
    public entry fun set_paused(admin: &signer, paused: bool) acquires Exchange {
        let ex = borrow_global_mut<Exchange>(@papertrade);
        assert_admin(ex, admin);
        ex.paused = paused;
    }

    public entry fun withdraw_dev_fees(admin: &signer, to: address, amount: u64) acquires Exchange {
        let ex = borrow_global_mut<Exchange>(@papertrade);
        assert_admin(ex, admin);
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(ex.dev_fees >= amount, E_INSUFFICIENT_DEV_FEES);
        ex.dev_fees = ex.dev_fees - amount;
        let vault_signer = object::generate_signer_for_extending(&ex.vault_extend_ref);
        primary_fungible_store::transfer(&vault_signer, test_usdc::metadata(), to, amount);
        event::emit(DevFeesWithdrawn { to, amount });
    }

    public entry fun transfer_admin(admin: &signer, new_admin: address) acquires Exchange {
        let ex = borrow_global_mut<Exchange>(@papertrade);
        assert_admin(ex, admin);
        ex.pending_admin = option::some(new_admin);
    }

    public entry fun accept_admin(new_admin: &signer) acquires Exchange {
        let ex = borrow_global_mut<Exchange>(@papertrade);
        let who = signer::address_of(new_admin);
        assert!(ex.pending_admin == option::some(who), E_NOT_PENDING_ADMIN);
        ex.admin = who;
        ex.pending_admin = option::none();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    #[view]
    public fun balance_of(user: address): u64 acquires Exchange {
        let ex = borrow_global<Exchange>(@papertrade);
        if (table::contains(&ex.balances, user)) *table::borrow(&ex.balances, user) else 0
    }

    #[view]
    /// (owner, market, is_long, margin, leverage, notional, entry_price, opened_at)
    public fun get_position(id: u64): (address, u8, bool, u64, u64, u128, u64, u64) acquires Exchange {
        let ex = borrow_global<Exchange>(@papertrade);
        assert!(table::contains(&ex.positions, id), E_POSITION_NOT_FOUND);
        let p = table::borrow(&ex.positions, id);
        (p.owner, p.market, p.is_long, p.margin, p.leverage, p.notional, p.entry_price, p.opened_at)
    }

    #[view]
    public fun position_exists(id: u64): bool acquires Exchange {
        table::contains(&borrow_global<Exchange>(@papertrade).positions, id)
    }

    #[view]
    public fun user_positions(user: address): vector<u64> acquires Exchange {
        let ex = borrow_global<Exchange>(@papertrade);
        if (table::contains(&ex.user_positions, user)) *table::borrow(&ex.user_positions, user)
        else vector::empty()
    }

    #[view]
    /// Unrealized (is_profit, amount) at the current oracle price (profit floored,
    /// loss ceiled and capped at margin).
    public fun unrealized_pnl(id: u64): (bool, u64) acquires Exchange {
        let ex = borrow_global<Exchange>(@papertrade);
        assert!(table::contains(&ex.positions, id), E_POSITION_NOT_FOUND);
        let p = table::borrow(&ex.positions, id);
        let (is_profit, f, c) = compute_pnl(p, oracle::get_price(p.market));
        if (is_profit) (true, clamp_u64(f)) else (false, clamp_u64(min_u128(c, (p.margin as u128))))
    }

    #[view]
    public fun is_liquidatable(id: u64): bool acquires Exchange, V3 {
        let ex = borrow_global<Exchange>(@papertrade);
        assert!(table::contains(&ex.positions, id), E_POSITION_NOT_FOUND);
        let p = table::borrow(&ex.positions, id);
        is_liquidatable_at(p, oracle::get_price(p.market))
    }

    #[view]
    /// Approximate price at which the position becomes liquidatable.
    public fun liquidation_price(id: u64): u64 acquires Exchange, V3 {
        let ex = borrow_global<Exchange>(@papertrade);
        assert!(table::contains(&ex.positions, id), E_POSITION_NOT_FOUND);
        let p = table::borrow(&ex.positions, id);
        if (exists<V3>(@papertrade)) return bust_price(p);
        // equity == maint  <=>  |move| = (margin - maint) * entry / notional
        let buffer = (p.margin as u128) - maintenance(p);
        let delta = ((buffer as u256) * (p.entry_price as u256) / (p.notional as u256) as u128);
        let entry = (p.entry_price as u128);
        if (p.is_long) {
            if (delta >= entry) 0 else ((entry - delta) as u64)
        } else {
            clamp_u64(entry + delta)
        }
    }

    #[view]
    public fun pool_balance(): u64 acquires Exchange {
        borrow_global<Exchange>(@papertrade).pool
    }

    #[view]
    public fun dev_fees(): u64 acquires Exchange {
        borrow_global<Exchange>(@papertrade).dev_fees
    }

    #[view]
    /// (head, tail, total owed). Entries live at indices [head, tail).
    public fun queue_state(): (u64, u64, u128) acquires Exchange {
        let ex = borrow_global<Exchange>(@papertrade);
        (ex.queue_head, ex.queue_tail, ex.queue_owed)
    }

    #[view]
    /// (owner, position_id, original, remaining)
    public fun queue_entry(index: u64): (address, u64, u64, u64) acquires Exchange {
        let ex = borrow_global<Exchange>(@papertrade);
        let e = table::borrow(&ex.queue, index);
        (e.owner, e.position_id, e.original, e.remaining)
    }

    #[view]
    /// (long OI, short OI, per-side cap)
    public fun open_interest(market: u8): (u128, u128, u64) acquires Exchange {
        assert!(market < oracle::num_markets(), E_INVALID_MARKET);
        let ex = borrow_global<Exchange>(@papertrade);
        let m = (market as u64);
        (*vector::borrow(&ex.long_oi, m), *vector::borrow(&ex.short_oi, m), *vector::borrow(&ex.oi_caps, m))
    }

    #[view]
    /// (vault USDC balance, total trading balances, total locked margin, pool, dev fees)
    public fun accounting(): (u64, u64, u64, u64, u64) acquires Exchange {
        let ex = borrow_global<Exchange>(@papertrade);
        (
            primary_fungible_store::balance(ex.vault, test_usdc::metadata()),
            ex.total_balances,
            ex.total_margin,
            ex.pool,
            ex.dev_fees
        )
    }

    #[view]
    /// (total paid to stakers, total accrued to dev)
    public fun fee_stats(): (u128, u128) acquires Exchange {
        let ex = borrow_global<Exchange>(@papertrade);
        (ex.total_staker_rewards, ex.total_dev_fees_accrued)
    }

    #[view]
    public fun is_paused(): bool acquires Exchange {
        borrow_global<Exchange>(@papertrade).paused
    }

    #[view]
    public fun admin(): address acquires Exchange {
        borrow_global<Exchange>(@papertrade).admin
    }

    #[view]
    public fun vault_address(): address acquires Exchange {
        borrow_global<Exchange>(@papertrade).vault
    }

    public fun lp_cap(): u64 { LP_CAP }

    // ---------------------------------------------------------------------
    // Internal: math
    // ---------------------------------------------------------------------

    /// Returns (is_profit, |pnl| floored, |pnl| ceiled). u256 intermediates: notional can
    /// reach ~1.8e22 and the price diff ~1e18, whose product overflows u128.
    fun compute_pnl(p: &Position, exit_price: u64): (bool, u128, u128) {
        let entry = p.entry_price;
        if (exit_price == entry) return (false, 0, 0);
        let up = exit_price > entry;
        let diff = if (up) exit_price - entry else entry - exit_price;
        let num = (p.notional as u256) * (diff as u256);
        let den = (entry as u256);
        let floor = num / den;
        let ceil = if (num % den == 0) floor else floor + 1;
        (up == p.is_long, saturate_u128(floor), saturate_u128(ceil))
    }

    /// 0.5% of notional, rounded up, capped at 50% of margin (rounded up). Without the
    /// cap every position above 200x would be liquidatable the moment it is opened.
    fun maintenance(p: &Position): u128 {
        let by_notional = ceil_div(p.notional * MAINT_BPS, BPS);
        let by_margin = ((p.margin as u128) + 1) / 2;
        min_u128(by_notional, by_margin)
    }

    fun is_liquidatable_at(p: &Position, price: u64): bool {
        if (exists<V3>(@papertrade)) {
            let bust = bust_price(p);
            return if (p.is_long) price <= bust else price >= bust
        };
        let (is_profit, _floor, loss_ceil) = compute_pnl(p, price);
        let maint = maintenance(p);
        let margin = (p.margin as u128);
        if (is_profit) {
            // equity = margin + profit > margin > maint
            false
        } else {
            // equity = margin - loss <= maint  <=>  loss >= margin - maint.
            // Written this way so a saturated loss_ceil cannot overflow; maint <= margin.
            loss_ceil >= margin - maint
        }
    }

    fun ceil_div(a: u128, b: u128): u128 {
        if (a == 0) 0 else (a - 1) / b + 1
    }

    fun min_u64(a: u64, b: u64): u64 { if (a < b) a else b }
    fun min_u128(a: u128, b: u128): u128 { if (a < b) a else b }
    fun clamp_u64(a: u128): u64 { if (a > U64_MAX) (U64_MAX as u64) else (a as u64) }
    fun saturate_u128(a: u256): u128 {
        let max = 340282366920938463463374607431768211455u256;
        if (a > max) (max as u128) else (a as u128)
    }

    // ---------------------------------------------------------------------
    // Internal: accounting
    // ---------------------------------------------------------------------

    fun assert_admin(ex: &Exchange, s: &signer) {
        assert!(signer::address_of(s) == ex.admin, E_NOT_ADMIN);
    }

    fun credit(ex: &mut Exchange, user: address, amount: u64) {
        if (amount == 0) return;
        if (table::contains(&ex.balances, user)) {
            let b = table::borrow_mut(&mut ex.balances, user);
            *b = *b + amount;
        } else {
            table::add(&mut ex.balances, user, amount);
        };
        ex.total_balances = ex.total_balances + amount;
    }

    fun debit(ex: &mut Exchange, user: address, amount: u64) {
        assert!(table::contains(&ex.balances, user), E_INSUFFICIENT_BALANCE);
        let b = table::borrow_mut(&mut ex.balances, user);
        assert!(*b >= amount, E_INSUFFICIENT_BALANCE);
        *b = *b - amount;
        ex.total_balances = ex.total_balances - amount;
    }

    /// Remove position from storage, owner index and OI; releases its margin from
    /// `total_margin` (the caller must re-assign it to balances / pool / fees).
    fun remove_position(ex: &mut Exchange, pos: &Position): bool acquires V2, V3 {
        table::remove(&mut ex.positions, pos.id);
        let ids = table::borrow_mut(&mut ex.user_positions, pos.owner);
        let (found, idx) = vector::index_of(ids, &pos.id);
        if (found) { vector::swap_remove(ids, idx); };
        let m = (pos.market as u64);
        let oi = if (pos.is_long) vector::borrow_mut(&mut ex.long_oi, m) else vector::borrow_mut(&mut ex.short_oi, m);
        *oi = *oi - pos.notional;
        if (exists<V3>(@papertrade)) v3_on_close(pos);
        if (exists<V2>(@papertrade)) {
            let v = borrow_global_mut<V2>(@papertrade);
            if (table::contains(&v.debt_positions, pos.id)) {
                table::remove(&mut v.debt_positions, pos.id);
                v.debt_margin = v.debt_margin - (pos.margin as u128);
                return true
            }
        };
        ex.total_margin = ex.total_margin - pos.margin;
        false
    }

    /// Winner: return margin, pay `profit - fee` from the pool (FIFO-queue any shortfall).
    /// Fee (2% of profit, rounded up) is collected only when the trader is paid in full,
    /// so stakers/dev never get paid ahead of queued traders.
    /// Returns (fee charged, credited now incl. margin, queued).
    fun settle_profit(ex: &mut Exchange, pos: &Position, profit: u64): (u64, u64, u64) {
        credit(ex, pos.owner, pos.margin);
        let fee = (ceil_div((profit as u128) * FEE_BPS, BPS) as u64);
        let net = profit - fee;
        // Let earlier claimants go first.
        process_queue_internal(ex, AUTO_QUEUE_STEPS);
        let pay = 0;
        if (ex.queue_head == ex.queue_tail) {
            pay = min_u64(ex.pool, net);
            ex.pool = ex.pool - pay;
            credit(ex, pos.owner, pay);
        };
        let owed = net - pay;
        let fee_paid = 0;
        if (owed == 0) {
            // Paper Trade: the win fee reaches stakers/dev only if free cash covers it in full.
            if (ex.pool >= fee) { fee_paid = fee; };
            ex.pool = ex.pool - fee_paid;
            distribute_fee(ex, fee_paid);
        } else {
            enqueue(ex, pos.owner, pos.id, owed);
        };
        (fee_paid, pos.margin + pay, owed)
    }

    /// Loser (or liquidated): refund `margin - loss`, take the 2% LP-side fee, rest to the
    /// pool; mint SEEDS on the Paper Trade curve (see tokenomics.move). Returns (fee, minted).
    /// Mirrors PaperTokenomics: a losing close while the payout queue is active pays no fee
    /// (all of it goes to queued winners) and mints on the full loss; otherwise it mints on
    /// loss - fee. A liquidation always mints on the full lost margin.
    fun settle_loss(ex: &mut Exchange, owner: address, margin: u64, loss: u64, is_liq: bool, mint_ok: bool): (u64, u64) {
        credit(ex, owner, margin - loss);
        if (loss == 0) return (0, 0);
        let queue_active = ex.queue_head != ex.queue_tail;
        // Loss AND liquidation fees are waived while the queue is active (PT solvency-queue).
        let fee = if (queue_active) 0 else (((loss as u128) * FEE_BPS / BPS) as u64);
        // V4: no SEEDS for positions held < min_hold_secs (anti wash-farming); the pool still books the loss.
        let basis = if (!mint_ok) 0 else if (is_liq) loss else loss - fee;
        let (lp, neg) = tracked_lp_signed(ex);
        let amount = tokenomics::quote(basis, lp, neg);
        let minted = paper::mint_seeds(owner, amount, loss, ex.pool);
        tokenomics::on_lp_gain(lp, neg, loss - fee);
        distribute_fee(ex, fee);
        pool_inflow(ex, loss - fee);
        (fee, minted)
    }

    /// Tracked LP = pool - queued debt, as (magnitude, is_negative).
    /// Debt-funded margin still counts as owed (it was a queue claim, contingent collateral).
    fun tracked_lp_signed(ex: &Exchange): (u128, bool) acquires V2 {
        let p = (ex.pool as u128);
        let owed = ex.queue_owed + debt_margin();
        if (p >= owed) (p - owed, false) else (owed - p, true)
    }

    fun debt_margin(): u128 acquires V2 {
        if (exists<V2>(@papertrade)) borrow_global<V2>(@papertrade).debt_margin else 0
    }

    #[view]
    /// (tracked LP magnitude, is_negative, current SEEDS per $1 * 1e6)
    public fun seeds_rate(): (u128, bool, u64) acquires Exchange, V2 {
        let ex = borrow_global<Exchange>(@papertrade);
        let (lp, neg) = tracked_lp_signed(ex);
        (lp, neg, tokenomics::rate_at(lp, neg, tokenomics::tail_progress()))
    }

    fun pool_inflow(ex: &mut Exchange, amount: u64) {
        ex.pool = ex.pool + amount;
        process_queue_internal(ex, AUTO_QUEUE_STEPS);
        sweep_excess(ex);
    }

    fun enqueue(ex: &mut Exchange, owner: address, position_id: u64, amount: u64) acquires V2 {
        let index = ex.queue_tail;
        table::add(&mut ex.queue, index, QueueEntry { owner, position_id, original: amount, remaining: amount });
        ex.queue_tail = index + 1;
        ex.queue_owed = ex.queue_owed + (amount as u128);
        if (exists<V2>(@papertrade)) {
            let v = borrow_global_mut<V2>(@papertrade);
            add_user_queued(v, owner, index, amount);
        };
        event::emit(QueueEntryAdded { index, owner, position_id, amount });
    }

    /// Pay queue entries in FIFO order from the pool, at most `max_steps` entries.
    fun process_queue_internal(ex: &mut Exchange, max_steps: u64) acquires V2 {
        skip_empty_head(ex);
        let steps = 0;
        while (steps < max_steps && ex.pool > 0 && ex.queue_head < ex.queue_tail) {
            let index = ex.queue_head;
            let e = table::borrow_mut(&mut ex.queue, index);
            let pay = min_u64(ex.pool, e.remaining);
            e.remaining = e.remaining - pay;
            let owner = e.owner;
            let remaining = e.remaining;
            if (remaining == 0) {
                table::remove(&mut ex.queue, index);
                ex.queue_head = index + 1;
            };
            ex.pool = ex.pool - pay;
            ex.queue_owed = ex.queue_owed - (pay as u128);
            if (exists<V2>(@papertrade)) {
                sub_user_queued(borrow_global_mut<V2>(@papertrade), owner, index, pay, remaining == 0);
            };
            credit(ex, owner, pay);
            event::emit(QueuePaid { index, owner, amount: pay, remaining });
            steps = steps + 1;
        };
        // Entries emptied by debt-funded opens can sit right behind the head; skip them even when the pool
        // just hit 0, so an empty queue never looks active (REVIEW_2026-10-15 M-11).
        skip_empty_head(ex);
    }

    /// Sweep pool above LP_CAP to stakers (only when nobody is waiting in the queue).
    fun sweep_excess(ex: &mut Exchange) acquires V2 {
        // Sweep tracked LP (pool - debt-funded margin) above the cap; never while queued.
        let floor = (LP_CAP as u128) + debt_margin();
        if (ex.queue_head != ex.queue_tail || (ex.pool as u128) <= floor) return;
        let excess = ex.pool - (floor as u64);
        ex.pool = ex.pool - excess;
        send_to_stakers(ex, excess);
        event::emit(PoolSwept { amount: excess });
    }

    /// Split a fee 50/50 between stakers (rounded down) and dev (remainder).
    fun distribute_fee(ex: &mut Exchange, fee: u64) {
        if (fee == 0) return;
        let to_stakers = fee / 2;
        let to_dev = fee - to_stakers;
        ex.dev_fees = ex.dev_fees + to_dev;
        ex.total_dev_fees_accrued = ex.total_dev_fees_accrued + (to_dev as u128);
        send_to_stakers(ex, to_stakers);
        event::emit(FeesDistributed { to_stakers, to_dev });
    }

    /// Move USDC from the vault into the PAPER reward vault. If nothing is staked the
    /// amount goes to the dev treasury instead (no one to attribute it to, and carrying
    /// it over would let the first staker snipe it).
    fun send_to_stakers(ex: &mut Exchange, amount: u64) {
        if (amount == 0) return;
        if (paper::total_staked() == 0) {
            ex.dev_fees = ex.dev_fees + amount;
            ex.total_dev_fees_accrued = ex.total_dev_fees_accrued + (amount as u128);
            return
        };
        let vault_signer = object::generate_signer_for_extending(&ex.vault_extend_ref);
        let fa = primary_fungible_store::withdraw(&vault_signer, test_usdc::metadata(), amount);
        paper::deposit_rewards(fa);
        ex.total_staker_rewards = ex.total_staker_rewards + (amount as u128);
    }

    // =====================================================================
    // V2: Paper Trade parity (asymmetric impact, no LP deposits, debt-funded
    // positions opened from queued balance). Activated once by `init_v2`.
    // Sources: docs.papertrade.xyz #/how/asymmetric-impact, #/how/solvency-queue,
    // #/learn/lp-queue, #/learn/liquidations, #/learn/wins-losses.
    // =====================================================================

    const E_LP_DEPOSITS_DISABLED: u64 = 22;
    const E_V2_EXISTS: u64 = 23;
    const E_V2_MISSING: u64 = 24;
    const E_QUEUE_NOT_EMPTY: u64 = 25;
    const E_SEED_LIMIT: u64 = 26;
    const E_INSUFFICIENT_QUEUED: u64 = 27;
    const E_BAD_IMPACT: u64 = 28;
    /// The only LP donation ever made (deploy bootstrap, DEPLOYMENT.md): 50,000 USDC.
    const SEED_DONATED: u64 = 50_000_000_000;

    struct UserQueue has store, drop { total: u64, indices: vector<u64> }

    struct V2 has key {
        /// Positions whose margin is a consumed queue claim -> margin.
        debt_positions: Table<u64, u64>,
        /// Sum of margin of open debt-funded positions (still owed contingently).
        debt_margin: u128,
        user_queue: Table<address, UserQueue>,
        seed_removed: u64,
        // Asymmetric impact params (per Paper Trade launch values).
        base_rate_bps: u64,          // 1000 = 10%
        rate_mult: u64,              // 15_000
        nref_usd: u64,               // 100_000
        pos_mult_k: vector<u64>,     // positionMultiplier * 1000: [814_598, 483_979]
    }

    #[event]
    struct WinImpact has drop, store { id: u64, raw_profit: u64, adjusted: u64 }

    #[event]
    struct PoolSeedRemoved has drop, store { to: address, amount: u64 }

    #[event]
    struct OpenedFromQueue has drop, store { id: u64, owner: address, margin: u64 }

    public entry fun init_v2(admin: &signer) acquires Exchange {
        let ex = borrow_global<Exchange>(@papertrade);
        assert_admin(ex, admin);
        assert!(signer::address_of(admin) == @papertrade, E_NOT_ADMIN);
        assert!(!exists<V2>(@papertrade), E_V2_EXISTS);
        assert!(ex.queue_head == ex.queue_tail, E_QUEUE_NOT_EMPTY);
        let pm = vector::empty<u64>();
        vector::push_back(&mut pm, 814_598);
        vector::push_back(&mut pm, 483_979);
        move_to(admin, V2 {
            debt_positions: table::new(), debt_margin: 0, user_queue: table::new(), seed_removed: 0,
            base_rate_bps: 1000, rate_mult: 15_000, nref_usd: 100_000, pos_mult_k: pm,
        });
    }

    public entry fun set_impact_params(admin: &signer, base_rate_bps: u64, rate_mult: u64, nref_usd: u64, pos_mult_k: vector<u64>) acquires Exchange, V2 {
        assert_admin(borrow_global<Exchange>(@papertrade), admin);
        assert!(base_rate_bps < 10_000 && rate_mult > 0 && nref_usd > 0, E_BAD_IMPACT);
        assert!(vector::length(&pos_mult_k) == (oracle::num_markets() as u64), E_BAD_IMPACT);
        // Bounds (REVIEW_2026-10-15 M-5): a 0 multiplier would confiscate all profit; huge values overflow
        // impact_adjusted and make every winning close abort. Allow up to ~10x the launch values.
        assert!(base_rate_bps <= 5_000 && rate_mult <= 150_000 && nref_usd <= 10_000_000, E_BAD_IMPACT);
        let i = 0;
        while (i < vector::length(&pos_mult_k)) {
            let k = *vector::borrow(&pos_mult_k, i);
            assert!(k > 0 && k <= 10_000_000, E_BAD_IMPACT);
            i = i + 1;
        };
        let v = borrow_global_mut<V2>(@papertrade);
        v.base_rate_bps = base_rate_bps; v.rate_mult = rate_mult; v.nref_usd = nref_usd; v.pos_mult_k = pos_mult_k;
    }

    /// Remove the deploy-time LP donation so the LP holds only real trader losses
    /// (Paper Trade's LP starts at $0 and can't be deposited into). Capped at the one
    /// recorded donation; never touches trader balances, margin or dev fees.
    public entry fun remove_pool_seed(admin: &signer, amount: u64) acquires Exchange, V2 {
        let ex = borrow_global_mut<Exchange>(@papertrade);
        assert_admin(ex, admin);
        assert!(exists<V2>(@papertrade), E_V2_MISSING);
        assert!(ex.queue_head == ex.queue_tail, E_QUEUE_NOT_EMPTY);
        let v = borrow_global_mut<V2>(@papertrade);
        assert!(amount > 0 && v.seed_removed + amount <= SEED_DONATED, E_SEED_LIMIT);
        assert!(amount <= ex.pool, E_INSUFFICIENT_BALANCE);
        // Never take cash that backs debt-funded positions (REVIEW L-10).
        assert!(((ex.pool - amount) as u128) >= v.debt_margin, E_INSUFFICIENT_BALANCE);
        v.seed_removed = v.seed_removed + amount;
        ex.pool = ex.pool - amount;
        let to = signer::address_of(admin);
        let vault_signer = object::generate_signer_for_extending(&ex.vault_extend_ref);
        primary_fungible_store::transfer(&vault_signer, test_usdc::metadata(), to, amount);
        event::emit(PoolSeedRemoved { to, amount });
    }

    /// Open a position using your queued (unpaid) winnings as margin ("debt-funded").
    public entry fun open_position_from_queue(user: &signer, market: u8, is_long: bool, margin: u64, leverage: u64) acquires Exchange, V2, V3, V4 {
        open_from_queue_for(signer::address_of(user), market, is_long, margin, leverage);
    }

    public entry fun open_position_from_queue_as_delegate(
        delegate: &signer, owner: address, market: u8, is_long: bool, margin: u64, leverage: u64,
    ) acquires Exchange, V2, TradingDelegates, V3, V4 {
        assert_delegate(owner, signer::address_of(delegate));
        open_from_queue_for(owner, market, is_long, margin, leverage);
    }

    fun open_from_queue_for(addr: address, market: u8, is_long: bool, margin: u64, leverage: u64) acquires Exchange, V2, V3, V4 {
        open_from_queue_core(addr, market, is_long, margin, leverage, legacy_open_price(market));
    }

    fun open_from_queue_core(addr: address, market: u8, is_long: bool, margin: u64, leverage: u64, price: u64) acquires Exchange, V2, V3, V4 {
        assert!(exists<V2>(@papertrade), E_V2_MISSING);
        assert!(margin >= MIN_MARGIN, E_MARGIN_TOO_SMALL);
        {
            let ex = borrow_global_mut<Exchange>(@papertrade);
            let v = borrow_global_mut<V2>(@papertrade);
            assert!(table::contains(&v.user_queue, addr), E_INSUFFICIENT_QUEUED);
            let uq = table::borrow_mut(&mut v.user_queue, addr);
            assert!(uq.total >= margin, E_INSUFFICIENT_QUEUED);
            // Consume newest claims first so the user's oldest place in line is kept.
            let need = margin;
            while (need > 0) {
                let n = vector::length(&uq.indices);
                let idx = *vector::borrow(&uq.indices, n - 1);
                let e = table::borrow_mut(&mut ex.queue, idx);
                let take = min_u64(e.remaining, need);
                e.remaining = e.remaining - take;
                need = need - take;
                if (e.remaining == 0) { vector::pop_back(&mut uq.indices); };
            };
            uq.total = uq.total - margin;
            if (uq.total == 0) { table::remove(&mut v.user_queue, addr); };
            ex.queue_owed = ex.queue_owed - (margin as u128);
            v.debt_margin = v.debt_margin + (margin as u128);
            skip_empty_head(ex);
        };
        let id = open_core(addr, market, is_long, margin, leverage, true, price);
        table::add(&mut borrow_global_mut<V2>(@papertrade).debt_positions, id, margin);
        event::emit(OpenedFromQueue { id, owner: addr, margin });
    }

    /// Debt-funded close. The LP owes the whole surviving claim (margin + net profit, or
    /// margin - loss): paid now if the queue is empty and cash covers it, else queued.
    /// Fee (2%) is paid from free LP cash only if the queue is empty and cash covers the
    /// claim plus the fee; otherwise waived. Returns (fee, paid_now, queued).
    fun settle_debt_close(ex: &mut Exchange, pos: &Position, is_win: bool, amt: u64): (u64, u64, u64) acquires V2 {
        let fee = if (is_win) (ceil_div((amt as u128) * FEE_BPS, BPS) as u64)
                  else (((amt as u128) * FEE_BPS / BPS) as u64);
        let surviving = if (is_win) pos.margin + amt - fee else pos.margin - amt;
        process_queue_internal(ex, AUTO_QUEUE_STEPS);
        let empty = ex.queue_head == ex.queue_tail;
        let fee_paid = if (empty && ex.pool >= surviving + fee) fee else 0;
        let pay = if (empty) min_u64(ex.pool, surviving) else 0;
        ex.pool = ex.pool - pay;
        credit(ex, pos.owner, pay);
        let owed = surviving - pay;
        if (owed > 0) enqueue(ex, pos.owner, pos.id, owed);
        if (fee_paid > 0) {
            ex.pool = ex.pool - fee_paid;
            distribute_fee(ex, fee_paid);
        };
        sweep_excess(ex);
        (fee_paid, pay, owed)
    }

    fun mint_for_loss(ex: &mut Exchange, owner: address, basis: u64, loss: u64, lp: u128, neg: bool, gain: u64): u64 {
        let amount = tokenomics::quote(basis, lp, neg);
        let minted = paper::mint_seeds(owner, amount, loss, ex.pool);
        tokenomics::on_lp_gain(lp, neg, gain);
        minted
    }

    /// Paper Trade win settlement: deadband (entry/50000) then
    /// adjusted = raw * (1-b) / (1 + 1/(move*R) + Nref/(1e6*move*P)).
    fun impact_adjusted(p: &Position, exit_price: u64): u64 acquires V2 {
        let v = borrow_global<V2>(@papertrade);
        let e = (p.entry_price as u256);
        let x = (exit_price as u256);
        let gain = if (x > e) x - e else e - x;
        let db = e / 50_000;
        if (gain <= db) return 0;
        let g = gain - db;
        let r = (v.rate_mult as u256);
        let pk = (*vector::borrow(&v.pos_mult_k, (p.market as u64)) as u256);
        let raw = (p.notional as u256) * g / e;
        let a = g * r * pk * 1_000_000;
        let num = ((10_000 - v.base_rate_bps) as u256) * a;
        let den = 10_000 * (a + e * pk * 1_000_000 + (v.nref_usd as u256) * e * r * 1000);
        let adj = raw * num / den;
        if (adj > (U64_MAX as u256)) (U64_MAX as u64) else (adj as u64)
    }

    /// Advance the head past entries fully consumed by debt-funded opens.
    fun skip_empty_head(ex: &mut Exchange) {
        while (ex.queue_head < ex.queue_tail) {
            let h = ex.queue_head;
            if (table::borrow(&ex.queue, h).remaining != 0) return;
            table::remove(&mut ex.queue, h);
            ex.queue_head = h + 1;
        }
    }

    fun add_user_queued(v: &mut V2, owner: address, index: u64, amount: u64) {
        if (!table::contains(&v.user_queue, owner)) {
            table::add(&mut v.user_queue, owner, UserQueue { total: 0, indices: vector::empty() });
        };
        let uq = table::borrow_mut(&mut v.user_queue, owner);
        uq.total = uq.total + amount;
        vector::push_back(&mut uq.indices, index);
    }

    fun sub_user_queued(v: &mut V2, owner: address, index: u64, amount: u64, done: bool) {
        if (!table::contains(&v.user_queue, owner)) return; // entries from before V2
        let uq = table::borrow_mut(&mut v.user_queue, owner);
        uq.total = if (uq.total > amount) uq.total - amount else 0;
        if (done) {
            let (f, i) = vector::index_of(&uq.indices, &index);
            if (f) { vector::remove(&mut uq.indices, i); };
        };
        if (uq.total == 0) { table::remove(&mut v.user_queue, owner); };
    }

    #[view]
    public fun v2_enabled(): bool { exists<V2>(@papertrade) }

    #[view]
    /// (queued total owed to user, user's earliest queue index, USDC queued ahead of it,
    ///  number of user entries). index = U64_MAX when not queued.
    public fun queued_balance_of(user: address): (u64, u64, u128, u64) acquires Exchange, V2 {
        if (!exists<V2>(@papertrade)) return (0, (U64_MAX as u64), 0, 0);
        let v = borrow_global<V2>(@papertrade);
        if (!table::contains(&v.user_queue, user)) return (0, (U64_MAX as u64), 0, 0);
        let uq = table::borrow(&v.user_queue, user);
        let n = vector::length(&uq.indices);
        if (n == 0) return (uq.total, (U64_MAX as u64), 0, 0);
        let first = *vector::borrow(&uq.indices, 0);
        let ex = borrow_global<Exchange>(@papertrade);
        let ahead: u128 = 0;
        let i = ex.queue_head;
        while (i < first) {
            ahead = ahead + (table::borrow(&ex.queue, i).remaining as u128);
            i = i + 1;
        };
        (uq.total, first, ahead, n)
    }

    #[view]
    /// (debt-funded margin outstanding, seed removed, base_rate_bps, rate_mult, nref_usd, pos_mult_k)
    public fun v2_state(): (u128, u64, u64, u64, u64, vector<u64>) acquires V2 {
        let v = borrow_global<V2>(@papertrade);
        (v.debt_margin, v.seed_removed, v.base_rate_bps, v.rate_mult, v.nref_usd, v.pos_mult_k)
    }

    #[view]
    public fun is_debt_position(id: u64): bool acquires V2 {
        exists<V2>(@papertrade) && table::contains(&borrow_global<V2>(@papertrade).debt_positions, id)
    }

    #[view]
    /// Estimated (adjusted profit, win fee) if position `id` closed now (0,0 if not a win).
    public fun quote_close(id: u64): (u64, u64) acquires Exchange, V2 {
        let ex = borrow_global<Exchange>(@papertrade);
        let p = table::borrow(&ex.positions, id);
        let price = oracle::get_price(p.market);
        let (is_profit, f, _c) = compute_pnl(p, price);
        if (!is_profit) return (0, 0);
        let adj = if (exists<V2>(@papertrade)) impact_adjusted(p, price) else clamp_u64(f);
        (adj, (ceil_div((adj as u128) * FEE_BPS, BPS) as u64))
    }

    // =====================================================================
    // V3: Paper Trade risk parity. Hard-bust liquidation at a fixed price buffer
    // (~5 bp) before zero equity, $1K min / $10M max position notional, and
    // independent per-side OI caps in base-asset quantity moved by a market keeper.
    // Sources: docs.papertrade.xyz #/learn/liquidations, #/how/risk, #/intro/faq;
    // live params exchange.papertrade.xyz/state/trading (bustBuffer, min/max).
    // =====================================================================

    const E_V3_EXISTS: u64 = 29;
    const E_NOT_MARKET_KEEPER: u64 = 30;
    const E_NOTIONAL_TOO_SMALL: u64 = 31;
    const E_NOTIONAL_TOO_LARGE: u64 = 32;
    const E_SIDE_CAP_EXCEEDED: u64 = 33;
    const E_BAD_RISK_PARAM: u64 = 34;
    const WAD: u256 = 1_000_000_000_000_000_000;
    /// qty (1e-8 asset units) = notional (1e-6 USDC) * 1e10 / price (1e-8 USD).
    const QTY_SCALE: u256 = 10_000_000_000;
    const U128_MAX: u128 = 340282366920938463463374607431768211455;

    struct V3 has key {
        market_keeper: address,
        min_notional: u64,                 // $1,000
        max_notional: u64,                 // $10,000,000
        bust_buffer_wad: vector<u128>,     // BTC 0.047604%, ETH 0.048130% (1e18 = 100%)
        long_cap_qty: vector<u128>,
        short_cap_qty: vector<u128>,
        long_qty: vector<u128>,
        short_qty: vector<u128>,
        /// Positions with id < first_id were opened before V3 and are not in *_qty.
        first_id: u64,
    }

    #[event]
    struct SideCapsSet has drop, store { market: u8, long_cap_qty: u128, short_cap_qty: u128 }

    public entry fun init_v3(admin: &signer) acquires Exchange {
        let ex = borrow_global<Exchange>(@papertrade);
        assert_admin(ex, admin);
        assert!(signer::address_of(admin) == @papertrade, E_NOT_ADMIN);
        assert!(!exists<V3>(@papertrade), E_V3_EXISTS);
        let n = (oracle::num_markets() as u64);
        let buf = vector::empty<u128>();
        vector::push_back(&mut buf, 476_041_580_087_574);
        vector::push_back(&mut buf, 481_304_050_180_130);
        let caps = vector::empty<u128>();
        let zeros = vector::empty<u128>();
        let i = 0;
        while (i < n) { vector::push_back(&mut caps, U128_MAX); vector::push_back(&mut zeros, 0); i = i + 1; };
        move_to(admin, V3 {
            market_keeper: signer::address_of(admin),
            min_notional: 1_000_000_000, max_notional: 10_000_000_000_000,
            bust_buffer_wad: buf,
            long_cap_qty: caps, short_cap_qty: caps, long_qty: zeros, short_qty: zeros,
            first_id: ex.next_position_id,
        });
    }

    public entry fun set_market_keeper(admin: &signer, keeper: address) acquires Exchange, V3 {
        assert_admin(borrow_global<Exchange>(@papertrade), admin);
        borrow_global_mut<V3>(@papertrade).market_keeper = keeper;
    }

    /// Market keeper: per-side caps in base-asset quantity (1e-8 units). 0 pauses a side.
    public entry fun set_side_caps(keeper: &signer, market: u8, long_cap_qty: u128, short_cap_qty: u128) acquires V3, V4 {
        let v = borrow_global_mut<V3>(@papertrade);
        assert!(signer::address_of(keeper) == v.market_keeper, E_NOT_MARKET_KEEPER);
        assert!(market < oracle::num_markets(), E_INVALID_MARKET);
        let m = (market as u64);
        *vector::borrow_mut(&mut v.long_cap_qty, m) = long_cap_qty;
        *vector::borrow_mut(&mut v.short_cap_qty, m) = short_cap_qty;
        if (exists<V4>(@papertrade)) {
            *vector::borrow_mut(&mut borrow_global_mut<V4>(@papertrade).caps_updated_at, m) = timestamp::now_seconds();
        };
        event::emit(SideCapsSet { market, long_cap_qty, short_cap_qty });
    }

    /// Market keeper: minimum / maximum position value (margin x leverage).
    public entry fun set_position_limits(keeper: &signer, min_notional: u64, max_notional: u64) acquires V3 {
        let v = borrow_global_mut<V3>(@papertrade);
        assert!(signer::address_of(keeper) == v.market_keeper, E_NOT_MARKET_KEEPER);
        assert!(min_notional <= max_notional, E_BAD_RISK_PARAM);
        v.min_notional = min_notional; v.max_notional = max_notional;
    }

    /// Owner: bust buffers per market (WAD, must be < 1%).
    public entry fun set_bust_buffers(admin: &signer, bufs: vector<u128>) acquires Exchange, V3 {
        assert_admin(borrow_global<Exchange>(@papertrade), admin);
        assert!(vector::length(&bufs) == (oracle::num_markets() as u64), E_BAD_RISK_PARAM);
        let i = 0;
        // < 1/(MAX_LEVERAGE+1): otherwise a 1000x position is liquidatable the moment it opens (REVIEW L-8).
        while (i < vector::length(&bufs)) { assert!(*vector::borrow(&bufs, i) < ((WAD / ((MAX_LEVERAGE as u256) + 1)) as u128), E_BAD_RISK_PARAM); i = i + 1; };
        borrow_global_mut<V3>(@papertrade).bust_buffer_wad = bufs;
    }

    fun qty_of(notional: u128, price: u64): u128 {
        ((notional as u256) * QTY_SCALE / (price as u256) as u128)
    }

    fun v3_on_open(m: u64, is_long: bool, notional: u128, price: u64) acquires V3 {
        let v = borrow_global_mut<V3>(@papertrade);
        assert!(notional >= (v.min_notional as u128), E_NOTIONAL_TOO_SMALL);
        assert!(notional <= (v.max_notional as u128), E_NOTIONAL_TOO_LARGE);
        let q = qty_of(notional, price);
        let cap = if (is_long) *vector::borrow(&v.long_cap_qty, m) else *vector::borrow(&v.short_cap_qty, m);
        let oi = if (is_long) vector::borrow_mut(&mut v.long_qty, m) else vector::borrow_mut(&mut v.short_qty, m);
        assert!(*oi + q <= cap, E_SIDE_CAP_EXCEEDED);
        *oi = *oi + q;
    }

    fun v3_on_close(p: &Position) acquires V3 {
        let v = borrow_global_mut<V3>(@papertrade);
        if (p.id < v.first_id) return;
        let q = qty_of(p.notional, p.entry_price);
        let m = (p.market as u64);
        let oi = if (p.is_long) vector::borrow_mut(&mut v.long_qty, m) else vector::borrow_mut(&mut v.short_qty, m);
        *oi = if (*oi > q) *oi - q else 0;
    }

    /// Paper Trade hard-bust trigger. Long: p0 = ceil(e(L-1)/L), bust = floor(p0(1+buf));
    /// liquidatable at price <= bust. Short: p0 = floor(e(L+1)/L), bust = ceil(p0(1-buf));
    /// liquidatable at price >= bust.
    fun bust_price(p: &Position): u64 acquires V3 {
        let v = borrow_global<V3>(@papertrade);
        let buf = (*vector::borrow(&v.bust_buffer_wad, (p.market as u64)) as u256);
        let e = (p.entry_price as u256);
        let l = (p.leverage as u256);
        if (p.is_long) {
            let n = e * (l - 1);
            let p0 = if (n % l == 0) n / l else n / l + 1;
            ((p0 * (WAD + buf) / WAD) as u64)
        } else {
            let p0 = e * (l + 1) / l;
            let x = p0 * (WAD - buf);
            let b = if (x % WAD == 0) x / WAD else x / WAD + 1;
            if (b > (U64_MAX as u256)) (U64_MAX as u64) else (b as u64)
        }
    }

    #[view]
    /// (market_keeper, min_notional, max_notional, bust_buffer_wad)
    public fun risk_params(): (address, u64, u64, vector<u128>) acquires V3 {
        let v = borrow_global<V3>(@papertrade);
        (v.market_keeper, v.min_notional, v.max_notional, v.bust_buffer_wad)
    }

    #[view]
    /// (long_qty, short_qty, long_cap_qty, short_cap_qty) in 1e-8 asset units.
    public fun side_oi(market: u8): (u128, u128, u128, u128) acquires V3 {
        let v = borrow_global<V3>(@papertrade);
        let m = (market as u64);
        (*vector::borrow(&v.long_qty, m), *vector::borrow(&v.short_qty, m),
         *vector::borrow(&v.long_cap_qty, m), *vector::borrow(&v.short_cap_qty, m))
    }

    #[view]
    public fun v3_enabled(): bool { exists<V3>(@papertrade) }


    // =====================================================================
    // V4: AUDIT_2026-10-15 remediation.
    // * Signed price per trade (H-1): trades take a price signed by the oracle's price signer and
    //   verified on chain (oracle::verified_price, max age a few seconds). The legacy unsigned open
    //   paths are disabled; legacy closes stay as a fallback only while the stored keeper price is
    //   at most close_fallback_secs old.
    // * On-chain default OI cap (M-13): if the market keeper has not refreshed a market's side caps
    //   within cap_ttl_secs, the legacy per-side notional cap (oi_caps) applies.
    // * SEEDS minimum hold (I-9): losses on positions held < min_hold_secs mint no SEEDS.
    // * Delegation scope (L-5): session keys may only hedge or spend queued claims when the owner
    //   opted in (delegate_trading_with_scope); every delegation expires within 7 days.
    // =====================================================================

    const E_V4_EXISTS: u64 = 35;
    const E_SIGNED_PRICE_REQUIRED: u64 = 36;
    const E_SCOPE_DENIED: u64 = 37;
    const E_BAD_V4_PARAM: u64 = 38;
    const MAX_DELEGATION_SECS: u64 = 604_800; // 7 days
    const DELEGATION_SLACK_SECS: u64 = 3_600;

    struct V4 has key {
        caps_updated_at: vector<u64>,
        cap_ttl_secs: u64,
        min_hold_secs: u64,
        close_fallback_secs: u64,
    }

    struct DelegateScope has store, drop, copy { delegate: address, allow_hedge: bool, allow_queue: bool }

    /// Stored under the owner; only the owner's signer writes it.
    struct DelegateScopes has key { entries: vector<DelegateScope> }

    #[event]
    struct DelegateScopeSet has drop, store { owner: address, delegate: address, allow_hedge: bool, allow_queue: bool }

    public entry fun init_v4(admin: &signer) acquires Exchange {
        assert_admin(borrow_global<Exchange>(@papertrade), admin);
        assert!(signer::address_of(admin) == @papertrade, E_NOT_ADMIN);
        assert!(!exists<V4>(@papertrade), E_V4_EXISTS);
        let now = timestamp::now_seconds();
        let ts = vector::empty<u64>();
        let i = 0;
        while (i < (oracle::num_markets() as u64)) { vector::push_back(&mut ts, now); i = i + 1; };
        move_to(admin, V4 { caps_updated_at: ts, cap_ttl_secs: 900, min_hold_secs: 60, close_fallback_secs: 15 });
    }

    public entry fun set_v4_params(admin: &signer, cap_ttl_secs: u64, min_hold_secs: u64, close_fallback_secs: u64) acquires Exchange, V4 {
        assert_admin(borrow_global<Exchange>(@papertrade), admin);
        assert!(cap_ttl_secs >= 60 && min_hold_secs <= 86_400 && close_fallback_secs <= 60, E_BAD_V4_PARAM);
        let v = borrow_global_mut<V4>(@papertrade);
        v.cap_ttl_secs = cap_ttl_secs; v.min_hold_secs = min_hold_secs; v.close_fallback_secs = close_fallback_secs;
    }

    fun legacy_open_price(market: u8): u64 {
        assert!(!exists<V4>(@papertrade), E_SIGNED_PRICE_REQUIRED);
        oracle::get_price(market)
    }

    fun legacy_close_price(market: u8): u64 acquires V4 {
        let price = oracle::get_price(market);
        if (exists<V4>(@papertrade)) {
            assert!(oracle::price_age(market) <= borrow_global<V4>(@papertrade).close_fallback_secs, E_SIGNED_PRICE_REQUIRED);
        };
        price
    }

    fun side_caps_live(market: u8): bool acquires V4 {
        if (!exists<V4>(@papertrade) || market >= oracle::num_markets()) return true;
        let v = borrow_global<V4>(@papertrade);
        timestamp::now_seconds() <= *vector::borrow(&v.caps_updated_at, (market as u64)) + v.cap_ttl_secs
    }

    fun hold_ok(position_id: u64): bool acquires Exchange, V4 {
        if (!exists<V4>(@papertrade)) return true;
        let ex = borrow_global<Exchange>(@papertrade);
        if (!table::contains(&ex.positions, position_id)) return true;
        let opened = table::borrow(&ex.positions, position_id).opened_at;
        timestamp::now_seconds() >= opened + borrow_global<V4>(@papertrade).min_hold_secs
    }

    // ---- signed-price trading (owner) ----

    public entry fun open_position_px(
        user: &signer, market: u8, is_long: bool, margin: u64, leverage: u64, price: u64, publish_time: u64, signature: vector<u8>,
    ) acquires Exchange, V3, V4 {
        let px = oracle::verified_price(market, price, publish_time, signature);
        open_core(signer::address_of(user), market, is_long, margin, leverage, false, px);
    }

    public entry fun close_position_px(user: &signer, position_id: u64, price: u64, publish_time: u64, signature: vector<u8>) acquires Exchange, V2, V3, V4 {
        close_core(signer::address_of(user), position_id, true, price, publish_time, signature);
    }

    public entry fun open_position_from_queue_px(
        user: &signer, market: u8, is_long: bool, margin: u64, leverage: u64, price: u64, publish_time: u64, signature: vector<u8>,
    ) acquires Exchange, V2, V3, V4 {
        let px = oracle::verified_price(market, price, publish_time, signature);
        open_from_queue_core(signer::address_of(user), market, is_long, margin, leverage, px);
    }

    // ---- signed-price trading (session-key delegate) ----

    public entry fun open_position_as_delegate_px(
        delegate: &signer, owner: address, market: u8, is_long: bool, margin: u64, leverage: u64, price: u64, publish_time: u64, signature: vector<u8>,
    ) acquires Exchange, TradingDelegates, V3, V4 {
        assert_delegate(owner, signer::address_of(delegate));
        let px = oracle::verified_price(market, price, publish_time, signature);
        open_core(owner, market, is_long, margin, leverage, false, px);
    }

    public entry fun close_position_as_delegate_px(
        delegate: &signer, owner: address, position_id: u64, price: u64, publish_time: u64, signature: vector<u8>,
    ) acquires Exchange, TradingDelegates, V2, V3, V4 {
        assert_delegate(owner, signer::address_of(delegate));
        close_core(owner, position_id, true, price, publish_time, signature);
    }

    /// Spending queued claims needs the owner's explicit `allow_queue` opt-in for this delegate.
    public entry fun open_position_from_queue_as_delegate_px(
        delegate: &signer, owner: address, market: u8, is_long: bool, margin: u64, leverage: u64, price: u64, publish_time: u64, signature: vector<u8>,
    ) acquires Exchange, TradingDelegates, DelegateScopes, V2, V3, V4 {
        let d = signer::address_of(delegate);
        assert_delegate(owner, d);
        let (_, _, q) = scope_of(owner, d);
        assert!(q, E_SCOPE_DENIED);
        let px = oracle::verified_price(market, price, publish_time, signature);
        open_from_queue_core(owner, market, is_long, margin, leverage, px);
    }

    /// Owner: authorize a session key (expiry <= 7 days) and choose whether it may also open hedged
    /// positions (`allow_hedge`) and spend queued winnings (`allow_queue`). One signature.
    public entry fun delegate_trading_with_scope(
        owner: &signer, delegate: address, expires_at: u64, allow_hedge: bool, allow_queue: bool,
    ) acquires TradingDelegates, DelegateScopes {
        delegate_trading_to(owner, delegate, option::some(expires_at));
        let addr = signer::address_of(owner);
        if (!exists<DelegateScopes>(addr)) move_to(owner, DelegateScopes { entries: vector::empty() });
        let entries = &mut borrow_global_mut<DelegateScopes>(addr).entries;
        let (found, i) = find_scope(entries, delegate);
        if (found) { vector::swap_remove(entries, i); };
        // Keep the list bounded: drop scopes of delegates that are no longer registered.
        let ds = &borrow_global<TradingDelegates>(addr).entries;
        let j = 0;
        while (j < vector::length(entries)) {
            let (f, _) = find_delegate(ds, vector::borrow(entries, j).delegate);
            if (f) j = j + 1 else { vector::swap_remove(entries, j); };
        };
        vector::push_back(entries, DelegateScope { delegate, allow_hedge, allow_queue });
        event::emit(DelegateScopeSet { owner: addr, delegate, allow_hedge, allow_queue });
    }

    fun find_scope(entries: &vector<DelegateScope>, delegate: address): (bool, u64) {
        let i = 0;
        while (i < vector::length(entries)) {
            if (vector::borrow(entries, i).delegate == delegate) return (true, i);
            i = i + 1;
        };
        (false, 0)
    }

    fun clear_scope(owner: address, delegate: address) acquires DelegateScopes {
        if (!exists<DelegateScopes>(owner)) return;
        let entries = &mut borrow_global_mut<DelegateScopes>(owner).entries;
        let (found, i) = find_scope(entries, delegate);
        if (found) { vector::swap_remove(entries, i); };
    }

    #[view]
    /// (active delegation, allow_hedge, allow_queue)
    public fun scope_of(owner: address, delegate: address): (bool, bool, bool) acquires TradingDelegates, DelegateScopes {
        let (active, _) = delegation_of(owner, delegate);
        if (!active || !exists<DelegateScopes>(owner)) return (active, false, false);
        let entries = &borrow_global<DelegateScopes>(owner).entries;
        let (found, i) = find_scope(entries, delegate);
        if (!found) return (active, false, false);
        let e = vector::borrow(entries, i);
        (active, e.allow_hedge, e.allow_queue)
    }

    #[view]
    /// (caps_updated_at per market, cap_ttl_secs, min_hold_secs, close_fallback_secs)
    public fun v4_state(): (vector<u64>, u64, u64, u64) acquires V4 {
        let v = borrow_global<V4>(@papertrade);
        (v.caps_updated_at, v.cap_ttl_secs, v.min_hold_secs, v.close_fallback_secs)
    }

    #[view]
    public fun v4_enabled(): bool { exists<V4>(@papertrade) }

    #[view]
    /// Batched open-position scan for the keeper (one call instead of one view per trader/position).
    /// Walks ids in [start_id, min(start_id + max_ids, next_position_id)) and returns the open ones:
    /// (ids, owners, markets, is_long, margins, leverages, notionals, entry_prices, opened_at,
    ///  liquidation prices, next id to scan from, next_position_id).
    public fun open_positions(start_id: u64, max_ids: u64): (
        vector<u64>, vector<address>, vector<u8>, vector<bool>, vector<u64>, vector<u64>, vector<u128>,
        vector<u64>, vector<u64>, vector<u64>, u64, u64,
    ) acquires Exchange, V3 {
        let ex = borrow_global<Exchange>(@papertrade);
        let end = ex.next_position_id;
        if (start_id < end && end - start_id > max_ids) end = start_id + max_ids;
        let (ids, owners, markets, longs, margins, levs, nots, entries, opened, liqs) = (
            vector[], vector[], vector[], vector[], vector[], vector[], vector[], vector[], vector[], vector[],
        );
        let id = start_id;
        while (id < end) {
            if (table::contains(&ex.positions, id)) {
                let p = table::borrow(&ex.positions, id);
                vector::push_back(&mut ids, id);
                vector::push_back(&mut owners, p.owner);
                vector::push_back(&mut markets, p.market);
                vector::push_back(&mut longs, p.is_long);
                vector::push_back(&mut margins, p.margin);
                vector::push_back(&mut levs, p.leverage);
                vector::push_back(&mut nots, p.notional);
                vector::push_back(&mut entries, p.entry_price);
                vector::push_back(&mut opened, p.opened_at);
                vector::push_back(&mut liqs, liq_price_of(p));
            };
            id = id + 1;
        };
        let next = if (end > start_id) end else start_id;
        (ids, owners, markets, longs, margins, levs, nots, entries, opened, liqs, next, ex.next_position_id)
    }

    fun liq_price_of(p: &Position): u64 acquires V3 {
        if (exists<V3>(@papertrade)) return bust_price(p);
        let buffer = (p.margin as u128) - maintenance(p);
        let delta = ((buffer as u256) * (p.entry_price as u256) / (p.notional as u256) as u128);
        let entry = (p.entry_price as u128);
        if (p.is_long) { if (delta >= entry) 0 else ((entry - delta) as u64) } else clamp_u64(entry + delta)
    }

    // ---------------------------------------------------------------------
    // Test helpers
    // ---------------------------------------------------------------------

    #[test_only]
    public fun init_for_test(deployer: &signer) {
        init_module(deployer);
    }

    #[test_only]
    public fun auto_queue_steps(): u64 { AUTO_QUEUE_STEPS }
}
