#[test_only]
module papertrade::tests {
    use std::signer;
    use std::vector;
    use aptos_framework::fungible_asset;
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;
    use papertrade::exchange;
    use papertrade::hedge;
    use papertrade::oracle;
    use papertrade::paper;
    use papertrade::test_usdc;

    const START: u64 = 1_000_000;
    const USDC: u64 = 1_000_000;
    const BTC_50K: u64 = 5_000_000_000_000; // 50,000 * 1e8
    const ETH_3K: u64 = 300_000_000_000;
    const BTC: u8 = 0;
    const ETH: u8 = 1;
    const U64_MAX: u64 = 18446744073709551615;

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    fun setup(fw: &signer, admin: &signer) {
        timestamp::set_time_has_started_for_testing(fw);
        timestamp::update_global_time_for_test_secs(START);
        test_usdc::init_for_test(admin);
        oracle::init_for_test(admin);
        paper::init_for_test(admin);
        papertrade::tokenomics::init_for_test(admin);
        exchange::init_for_test(admin);
        hedge::init_for_test(admin);
        oracle::push_prices(admin, BTC_50K, ETH_3K, START);
    }

    public fun setup_for(fw: &signer, admin: &signer) { setup(fw, admin); }
    public fun seed_pool_for(admin: &signer, amount: u64) { seed_pool(admin, amount); }
    public fun fund_trader_for(user: &signer, amount: u64) { fund_trader(user, amount); }
    /// Open a 100 USDC 10x BTC long, move -5% (loss 50), close, restore price.
    public fun lose_for(user: &signer, admin: &signer, _n: u64) {
        exchange::open_position(user, BTC, true, 100 * USDC, 10);
        let id = last_position(signer::address_of(user));
        set_btc(admin, 4_750_000_000_000);
        exchange::close_position(user, id);
        set_btc(admin, BTC_50K);
    }

    fun set_btc(admin: &signer, price: u64) {
        oracle::push_price(admin, BTC, price, timestamp::now_seconds());
    }

    fun advance(secs: u64) {
        timestamp::fast_forward_seconds(secs);
    }

    fun fund_trader(user: &signer, amount: u64) {
        test_usdc::mint_for_test(signer::address_of(user), amount);
        exchange::deposit(user, amount);
    }

    fun seed_pool(admin: &signer, amount: u64) {
        test_usdc::mint_for_test(signer::address_of(admin), amount);
        exchange::fund_pool(admin, amount);
    }

    fun give_and_stake_paper(user: &signer, amount: u64) {
        paper::mint_for_test(signer::address_of(user), amount);
        paper::stake(user, amount);
    }

    fun last_position(user: address): u64 {
        let ids = exchange::user_positions(user);
        *vector::borrow(&ids, vector::length(&ids) - 1)
    }

    /// Exchange vault holds exactly the tracked buckets; reward vault holds exactly
    /// deposited - claimed.
    fun check_invariants() {
        let (vault, balances, margin, pool, dev) = exchange::accounting();
        assert!(vault == balances + margin + pool + dev, 900);
        let (deposited, claimed, reward_vault) = paper::reward_stats();
        assert!((reward_vault as u128) == deposited - claimed, 901);
    }

    // ---------------------------------------------------------------------
    // test_usdc
    // ---------------------------------------------------------------------

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_faucet_and_cooldown(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        test_usdc::faucet(alice);
        assert!(test_usdc::balance(@0xA11CE) == 10_000 * USDC, 0);
        assert!(test_usdc::faucet_cooldown_remaining(@0xA11CE) == 86_400, 1);
        advance(86_400);
        assert!(test_usdc::faucet_cooldown_remaining(@0xA11CE) == 0, 2);
        test_usdc::faucet(alice);
        assert!(test_usdc::balance(@0xA11CE) == 20_000 * USDC, 3);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 2, location = papertrade::test_usdc)]
    fun test_faucet_cooldown_abort(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        test_usdc::faucet(alice);
        advance(86_399);
        test_usdc::faucet(alice);
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    fun test_admin_mint_and_config(fw: &signer, admin: &signer) {
        setup(fw, admin);
        test_usdc::mint(admin, @0xB0B, 123 * USDC);
        assert!(test_usdc::balance(@0xB0B) == 123 * USDC, 0);
        test_usdc::set_faucet_config(admin, 5 * USDC, 60);
        let (amount, cooldown) = test_usdc::faucet_config();
        assert!(amount == 5 * USDC && cooldown == 60, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 1, location = papertrade::test_usdc)]
    fun test_non_admin_mint_abort(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        test_usdc::mint(alice, @0xA11CE, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 1, location = papertrade::test_usdc)]
    fun test_non_admin_faucet_config_abort(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        test_usdc::set_faucet_config(alice, 1, 0);
    }

    // ---------------------------------------------------------------------
    // oracle
    // ---------------------------------------------------------------------

    #[test(fw = @aptos_framework, admin = @papertrade, keeper = @0xBEEF)]
    fun test_oracle_keeper_push(fw: &signer, admin: &signer, keeper: &signer) {
        setup(fw, admin);
        oracle::add_keeper(admin, @0xBEEF);
        advance(10);
        oracle::push_price(keeper, ETH, 310_000_000_000, START + 10);
        assert!(oracle::get_price(ETH) == 310_000_000_000, 0);
        let (p, t) = oracle::price_info(ETH);
        assert!(p == 310_000_000_000 && t == START + 10, 1);
        assert!(oracle::is_fresh(ETH), 2);
        // Same publish time is accepted (monotonic, not strictly increasing).
        oracle::push_price(keeper, ETH, 311_000_000_000, START + 10);
        assert!(oracle::get_price(ETH) == 311_000_000_000, 3);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, mallory = @0xBAD)]
    #[expected_failure(abort_code = 1, location = papertrade::oracle)]
    fun test_oracle_unauthorized_push(fw: &signer, admin: &signer, mallory: &signer) {
        setup(fw, admin);
        oracle::push_price(mallory, BTC, 1, START);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, keeper = @0xBEEF)]
    #[expected_failure(abort_code = 1, location = papertrade::oracle)]
    fun test_oracle_removed_keeper_abort(fw: &signer, admin: &signer, keeper: &signer) {
        setup(fw, admin);
        oracle::add_keeper(admin, @0xBEEF);
        oracle::remove_keeper(admin, @0xBEEF);
        oracle::push_price(keeper, BTC, BTC_50K, START);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, mallory = @0xBAD)]
    #[expected_failure(abort_code = 13, location = papertrade::oracle)]
    fun test_oracle_non_admin_add_keeper(fw: &signer, admin: &signer, mallory: &signer) {
        setup(fw, admin);
        oracle::add_keeper(mallory, @0xBAD);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, mallory = @0xBAD)]
    #[expected_failure(abort_code = 13, location = papertrade::oracle)]
    fun test_oracle_non_admin_staleness(fw: &signer, admin: &signer, mallory: &signer) {
        setup(fw, admin);
        oracle::set_max_staleness(mallory, 1000);
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 8, location = papertrade::oracle)]
    fun test_oracle_invalid_staleness(fw: &signer, admin: &signer) {
        setup(fw, admin);
        oracle::set_max_staleness(admin, 0);
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 4, location = papertrade::oracle)]
    fun test_oracle_stale_abort(fw: &signer, admin: &signer) {
        setup(fw, admin);
        assert!(oracle::get_price(BTC) == BTC_50K, 0);
        advance(60);
        assert!(oracle::get_price(BTC) == BTC_50K, 1); // boundary still fresh
        advance(1);
        assert!(!oracle::is_fresh(BTC), 2);
        oracle::get_price(BTC);
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    fun test_oracle_configurable_staleness(fw: &signer, admin: &signer) {
        setup(fw, admin);
        oracle::set_max_staleness(admin, 600);
        advance(600);
        assert!(oracle::get_price(BTC) == BTC_50K, 0);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 4, location = papertrade::oracle)]
    fun test_open_with_stale_price_aborts(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        advance(61);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 4, location = papertrade::oracle)]
    fun test_close_with_stale_price_aborts(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        advance(61);
        exchange::close_position(alice, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 3, location = papertrade::oracle)]
    fun test_oracle_zero_price(fw: &signer, admin: &signer) {
        setup(fw, admin);
        set_btc(admin, 0);
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 2, location = papertrade::oracle)]
    fun test_oracle_invalid_market(fw: &signer, admin: &signer) {
        setup(fw, admin);
        oracle::push_price(admin, 2, BTC_50K, START);
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 6, location = papertrade::oracle)]
    fun test_oracle_future_timestamp(fw: &signer, admin: &signer) {
        setup(fw, admin);
        oracle::push_price(admin, BTC, BTC_50K, START + 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 7, location = papertrade::oracle)]
    fun test_oracle_old_timestamp(fw: &signer, admin: &signer) {
        setup(fw, admin);
        advance(5);
        oracle::push_price(admin, BTC, BTC_50K, START + 5);
        oracle::push_price(admin, BTC, BTC_50K, START + 4);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, new_admin = @0xAD)]
    fun test_oracle_admin_transfer(fw: &signer, admin: &signer, new_admin: &signer) {
        setup(fw, admin);
        oracle::transfer_admin(admin, @0xAD);
        assert!(oracle::admin() == @papertrade, 0);
        oracle::accept_admin(new_admin);
        assert!(oracle::admin() == @0xAD, 1);
        oracle::push_price(new_admin, BTC, BTC_50K, START);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, mallory = @0xBAD)]
    #[expected_failure(abort_code = 12, location = papertrade::oracle)]
    fun test_oracle_accept_admin_wrong_signer(fw: &signer, admin: &signer, mallory: &signer) {
        setup(fw, admin);
        oracle::transfer_admin(admin, @0xAD);
        oracle::accept_admin(mallory);
    }

    // ---------------------------------------------------------------------
    // Deposits / withdrawals
    // ---------------------------------------------------------------------

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_deposit_withdraw(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        test_usdc::mint_for_test(@0xA11CE, 500 * USDC);
        exchange::deposit(alice, 300 * USDC);
        assert!(exchange::balance_of(@0xA11CE) == 300 * USDC, 0);
        assert!(test_usdc::balance(@0xA11CE) == 200 * USDC, 1);
        exchange::withdraw(alice, 300 * USDC);
        assert!(exchange::balance_of(@0xA11CE) == 0, 2);
        assert!(test_usdc::balance(@0xA11CE) == 500 * USDC, 3);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 3, location = papertrade::exchange)]
    fun test_withdraw_more_than_balance(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 100 * USDC);
        exchange::withdraw(alice, 100 * USDC + 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 3, location = papertrade::exchange)]
    fun test_withdraw_locked_margin_aborts(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 100 * USDC);
        exchange::open_position(alice, BTC, true, 60 * USDC, 2);
        exchange::withdraw(alice, 41 * USDC);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 3, location = papertrade::exchange)]
    fun test_withdraw_without_account_aborts(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        exchange::withdraw(alice, 1);
    }

    // ---------------------------------------------------------------------
    // Open: bounds
    // ---------------------------------------------------------------------

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_leverage_bounds_ok(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 10 * USDC, 1);
        exchange::open_position(alice, ETH, false, 10 * USDC, 1000);
        let (owner, market, is_long, margin, lev, notional, entry, _) = exchange::get_position(2);
        assert!(owner == @0xA11CE && market == ETH && !is_long, 0);
        assert!(margin == 10 * USDC && lev == 1000 && notional == 10_000 * (USDC as u128), 1);
        assert!(entry == ETH_3K, 2);
        // 1000x position must not be liquidatable at open.
        assert!(!exchange::is_liquidatable(2), 3);
        let (long_oi, short_oi, _) = exchange::open_interest(ETH);
        assert!(long_oi == 0 && short_oi == 10_000 * (USDC as u128), 4);
        assert!(exchange::balance_of(@0xA11CE) == 980 * USDC, 5);
        assert!(vector::length(&exchange::user_positions(@0xA11CE)) == 2, 6);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 5, location = papertrade::exchange)]
    fun test_leverage_zero(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 10 * USDC, 0);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 5, location = papertrade::exchange)]
    fun test_leverage_too_high(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 10 * USDC, 1001);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 6, location = papertrade::exchange)]
    fun test_margin_too_small(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 10 * USDC - 1, 10);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 2, location = papertrade::oracle)]
    fun test_open_invalid_market(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, 2, true, 10 * USDC, 10);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 3, location = papertrade::exchange)]
    fun test_open_margin_exceeds_balance(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 50 * USDC);
        exchange::open_position(alice, BTC, true, 51 * USDC, 10);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 7, location = papertrade::exchange)]
    fun test_oi_cap(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        exchange::set_oi_cap(admin, BTC, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10); // exactly at cap
        exchange::open_position(alice, BTC, false, 100 * USDC, 10); // other side independent
        exchange::open_position(alice, BTC, true, 10 * USDC, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_oi_released_on_close(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        exchange::set_oi_cap(admin, BTC, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        exchange::close_position(alice, 1);
        let (l, _, _) = exchange::open_interest(BTC);
        assert!(l == 0, 0);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 12, location = papertrade::exchange)]
    fun test_max_positions_per_user(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        let i = 0;
        while (i < 33) {
            exchange::open_position(alice, BTC, true, 10 * USDC, 1);
            i = i + 1;
        };
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 1, location = papertrade::exchange)]
    fun test_non_admin_set_oi_cap(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        exchange::set_oi_cap(alice, BTC, 0);
    }

    // ---------------------------------------------------------------------
    // Close: win / loss
    // ---------------------------------------------------------------------

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_win_long_no_stakers(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        seed_pool(admin, 1_000_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 5_500_000_000_000); // +10%
        let (is_profit, pnl) = exchange::unrealized_pnl(1);
        assert!(is_profit && pnl == 100 * USDC, 0);
        exchange::close_position(alice, 1);
        // margin 100 + profit 100 - fee 2
        assert!(exchange::balance_of(@0xA11CE) == 1098 * USDC, 1);
        assert!(exchange::pool_balance() == 1_000_000 * USDC - 100 * USDC, 2);
        // No stakers: whole fee to dev.
        assert!(exchange::dev_fees() == 2 * USDC, 3);
        assert!(paper::balance_of(@0xA11CE) == 0, 4);
        assert!(!exchange::position_exists(1), 5);
        assert!(vector::length(&exchange::user_positions(@0xA11CE)) == 0, 6);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_win_short(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        seed_pool(admin, 1_000_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, false, 100 * USDC, 10);
        set_btc(admin, 4_500_000_000_000); // -10%
        exchange::close_position(alice, 1);
        assert!(exchange::balance_of(@0xA11CE) == 1098 * USDC, 0);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    fun test_fee_split_with_staker(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        seed_pool(admin, 1_000_000 * USDC);
        give_and_stake_paper(bob, 1000);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 5_500_000_000_000);
        exchange::close_position(alice, 1);
        // fee 2 USDC: 1 to stakers, 1 to dev
        assert!(exchange::dev_fees() == 1 * USDC, 0);
        let (to_stakers, to_dev) = exchange::fee_stats();
        assert!(to_stakers == (USDC as u128) && to_dev == (USDC as u128), 1);
        assert!(paper::pending_rewards(@0xB0B) == 1 * USDC, 2);
        paper::claim(bob);
        assert!(test_usdc::balance(@0xB0B) == 1 * USDC, 3);
        assert!(paper::pending_rewards(@0xB0B) == 0, 4);
        // Loss side: 2% of loss split too (odd fee -> dev gets the extra unit).
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 5_225_000_000_000); // -5% from 55k
        exchange::close_position(alice, 2);
        // loss 50 -> fee 1 -> 0.5 / 0.5
        assert!(exchange::dev_fees() == 1_500_000, 5);
        assert!(paper::pending_rewards(@0xB0B) == 500_000, 6);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    fun test_withdraw_dev_fees(fw: &signer, admin: &signer) {
        setup(fw, admin);
        let alice = &aptos_framework::account::create_signer_for_test(@0xA11CE);
        seed_pool(admin, 1_000_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 5_500_000_000_000);
        exchange::close_position(alice, 1);
        exchange::withdraw_dev_fees(admin, @0xDE5, 2 * USDC);
        assert!(test_usdc::balance(@0xDE5) == 2 * USDC, 0);
        assert!(exchange::dev_fees() == 0, 1);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 16, location = papertrade::exchange)]
    fun test_withdraw_dev_fees_too_much(fw: &signer, admin: &signer) {
        setup(fw, admin);
        exchange::withdraw_dev_fees(admin, @0xDE5, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 1, location = papertrade::exchange)]
    fun test_withdraw_dev_fees_non_admin(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        exchange::withdraw_dev_fees(alice, @0xA11CE, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_loss_mints_paper(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        seed_pool(admin, 1_000_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 4_750_000_000_000); // -5%
        let (is_profit, pnl) = exchange::unrealized_pnl(1);
        assert!(!is_profit && pnl == 50 * USDC, 0);
        exchange::close_position(alice, 1);
        assert!(exchange::balance_of(@0xA11CE) == 950 * USDC, 1);
        // loss 50: fee 1 (to dev, no stakers), pool +49
        assert!(exchange::pool_balance() == 1_000_049 * USDC, 2);
        assert!(exchange::dev_fees() == 1 * USDC, 3);
        // 100 SEEDS per USDC of basis (loss - fee = 49) while LP < 2M => 4900
        assert!(paper::balance_of(@0xA11CE) == 4900 * 1_000_000, 4);
        assert!(paper::total_supply() == 4900 * 1_000_000, 5);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_loss_short_and_eth(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        seed_pool(admin, 1_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, ETH, false, 200 * USDC, 5);
        oracle::push_price(admin, ETH, 330_000_000_000, START); // +10%
        exchange::close_position(alice, 1);
        // notional 1000, +10% => loss 100
        assert!(exchange::balance_of(@0xA11CE) == 900 * USDC, 0);
        assert!(exchange::pool_balance() == 1_098 * USDC, 1);
        assert!(paper::balance_of(@0xA11CE) == 9_800 * 1_000_000, 2);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    fun test_paper_mint_rate_decay(fw: &signer, admin: &signer) {
        setup(fw, admin);
        let two_m = 2_000_000 * USDC;
        assert!(paper::mint_amount(USDC, 0) == 100 * USDC, 0);
        assert!(paper::mint_amount(USDC, two_m - 1) == 100 * USDC, 1);
        assert!(paper::mint_amount(USDC, two_m) == 100 * USDC, 2);
        assert!(paper::mint_amount(USDC, 2 * two_m) == 50 * USDC, 3);
        assert!(paper::mint_amount(USDC, 5_000_000 * USDC) == 40 * USDC, 4);
        // Saturates instead of overflowing.
        assert!(paper::mint_amount(U64_MAX, 0) == U64_MAX, 5);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_loss_paper_decayed_at_large_pool(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        seed_pool(admin, 4_000_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 4_750_000_000_000);
        exchange::close_position(alice, 1);
        // LP 4M is in the tail region but the HWM is still 0 (donations don't advance
        // it) => full 100/$ on basis 49 => 4900; HWM advances by the 49 LP gain.
        assert!(paper::balance_of(@0xA11CE) == 4900 * 1_000_000, 0);
        assert!(papertrade::tokenomics::tail_progress() == 49 * (USDC as u128), 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_rounding_favors_pool(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        seed_pool(admin, 1_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        // notional 30 USDC = 3e7 units; a 1-raw price move is worth 3e7/5e12 < 1 unit.
        exchange::open_position(alice, BTC, true, 10 * USDC, 3);
        set_btc(admin, BTC_50K + 1);
        let (is_profit, pnl) = exchange::unrealized_pnl(1);
        // Tiny profit floors to zero.
        assert!(pnl == 0, 0);
        let _ = is_profit;
        exchange::close_position(alice, 1);
        assert!(exchange::balance_of(@0xA11CE) == 1000 * USDC, 1);
        assert!(exchange::pool_balance() == 1_000 * USDC, 2);

        exchange::open_position(alice, BTC, true, 10 * USDC, 3);
        set_btc(admin, BTC_50K);
        // Tiny loss ceils to one unit.
        exchange::close_position(alice, 2);
        assert!(exchange::balance_of(@0xA11CE) == 1000 * USDC - 1, 3);
        assert!(exchange::pool_balance() == 1_000 * USDC + 1, 4); // fee floor(0.02) = 0
        assert!(paper::balance_of(@0xA11CE) == 100, 5);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_close_flat(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 100 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 1000);
        exchange::close_position(alice, 1);
        assert!(exchange::balance_of(@0xA11CE) == 100 * USDC, 0);
        assert!(paper::balance_of(@0xA11CE) == 0, 1);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    #[expected_failure(abort_code = 9, location = papertrade::exchange)]
    fun test_close_not_owner(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        fund_trader(alice, 100 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        exchange::close_position(bob, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 8, location = papertrade::exchange)]
    fun test_close_twice(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 100 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        exchange::close_position(alice, 1);
        exchange::close_position(alice, 1);
    }

    // ---------------------------------------------------------------------
    // Liquidation
    // ---------------------------------------------------------------------

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    fun test_liquidation(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        seed_pool(admin, 1_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        // margin 100, 100x => notional 10,000, maint = min(50, 50) = 50
        exchange::open_position(alice, BTC, true, 100 * USDC, 100);
        assert!(exchange::liquidation_price(1) == 4_975_000_000_000, 0);
        set_btc(admin, 4_980_000_000_000); // -0.4% => loss 40, equity 60
        assert!(!exchange::is_liquidatable(1), 1);
        set_btc(admin, 4_975_000_000_000); // -0.5% => loss 50, equity 50 == maint
        assert!(exchange::is_liquidatable(1), 2);
        exchange::liquidate(bob, 1);
        // Entire margin lost: fee 2, pool +98
        assert!(exchange::balance_of(@0xA11CE) == 900 * USDC, 3);
        assert!(exchange::pool_balance() == 1_098 * USDC, 4);
        assert!(exchange::dev_fees() == 2 * USDC, 5);
        assert!(paper::balance_of(@0xA11CE) == 10_000 * 1_000_000, 6);
        assert!(exchange::balance_of(@0xB0B) == 0, 7);
        assert!(!exchange::position_exists(1), 8);
        let (l, _, _) = exchange::open_interest(BTC);
        assert!(l == 0, 9);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    #[expected_failure(abort_code = 10, location = papertrade::exchange)]
    fun test_liquidation_healthy_aborts(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 100);
        set_btc(admin, 4_980_000_000_000);
        exchange::liquidate(bob, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    #[expected_failure(abort_code = 10, location = papertrade::exchange)]
    fun test_liquidation_profitable_aborts(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, false, 100 * USDC, 1000);
        set_btc(admin, 4_000_000_000_000);
        exchange::liquidate(bob, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, bob = @0xB0B)]
    #[expected_failure(abort_code = 8, location = papertrade::exchange)]
    fun test_liquidate_missing_position(fw: &signer, admin: &signer, bob: &signer) {
        setup(fw, admin);
        exchange::liquidate(bob, 42);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    fun test_liquidation_1000x(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        fund_trader(alice, 10 * USDC);
        // margin 10, notional 10,000; maint = min(50, 5) = 5 (margin cap binds)
        exchange::open_position(alice, BTC, true, 10 * USDC, 1000);
        set_btc(admin, 4_998_000_000_000); // -0.04% => loss 4, equity 6
        assert!(!exchange::is_liquidatable(1), 0);
        set_btc(admin, 4_997_500_000_000); // -0.05% => loss 5, equity 5
        assert!(exchange::is_liquidatable(1), 1);
        exchange::liquidate(bob, 1);
        assert!(exchange::pool_balance() == 9_800_000, 2);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    fun test_liquidation_bankrupt_gap(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        seed_pool(admin, 1_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 4_000_000_000_000); // -20% gap: loss 200 > margin 100
        let (is_profit, pnl) = exchange::unrealized_pnl(1);
        assert!(!is_profit && pnl == 100 * USDC, 0); // capped at margin
        exchange::liquidate(bob, 1);
        // Pool only gains the margin (minus fee); trader owes nothing more.
        assert!(exchange::pool_balance() == 1_098 * USDC, 1);
        assert!(exchange::balance_of(@0xA11CE) == 900 * USDC, 2);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_owner_close_bankrupt(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, false, 100 * USDC, 10);
        set_btc(admin, 7_500_000_000_000); // +50%: loss 500 > margin
        exchange::close_position(alice, 1);
        assert!(exchange::balance_of(@0xA11CE) == 900 * USDC, 0);
        assert!(exchange::pool_balance() == 98 * USDC, 1);
        assert!(paper::balance_of(@0xA11CE) == 9_800 * 1_000_000, 2);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_liquidation_price_views(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        // 10x long: maint = min(5, 50) = 5; buffer 95 => move 9.5% => 45,250
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        assert!(exchange::liquidation_price(1) == 4_525_000_000_000, 0);
        // 10x short => 54,750
        exchange::open_position(alice, BTC, false, 100 * USDC, 10);
        assert!(exchange::liquidation_price(2) == 5_475_000_000_000, 1);
        // 1x long: buffer 99.5% of notional => 250
        exchange::open_position(alice, BTC, true, 100 * USDC, 1);
        assert!(exchange::liquidation_price(3) == 25_000_000_000, 2);
    }

    // ---------------------------------------------------------------------
    // FIFO payout queue
    // ---------------------------------------------------------------------

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B, carol = @0xCA401)]
    fun test_fifo_queue_partial_fills(
        fw: &signer, admin: &signer, alice: &signer, bob: &signer, carol: &signer
    ) {
        setup(fw, admin);
        seed_pool(admin, 100 * USDC);
        fund_trader(alice, 1000 * USDC);
        fund_trader(bob, 1000 * USDC);
        fund_trader(carol, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);  // id 1
        exchange::open_position(bob, BTC, true, 100 * USDC, 10);    // id 2
        exchange::open_position(carol, BTC, false, 100 * USDC, 10); // id 3
        set_btc(admin, 6_000_000_000_000); // +20% => profit 200 each long

        // Alice: net 196, pool 100 => paid 100, 96 queued; fee not collected.
        exchange::close_position(alice, 1);
        assert!(exchange::balance_of(@0xA11CE) == 900 * USDC + 100 * USDC + 100 * USDC, 0);
        assert!(exchange::pool_balance() == 0, 1);
        let (head, tail, owed) = exchange::queue_state();
        assert!(head == 0 && tail == 1 && owed == 96 * (USDC as u128), 2);
        let (o, pid, orig, rem) = exchange::queue_entry(0);
        assert!(o == @0xA11CE && pid == 1 && orig == 96 * USDC && rem == 96 * USDC, 3);
        assert!(exchange::dev_fees() == 0, 4);

        // Bob: pool empty => fully queued behind Alice.
        exchange::close_position(bob, 2);
        assert!(exchange::balance_of(@0xB0B) == 1000 * USDC, 5);
        let (head, tail, owed) = exchange::queue_state();
        assert!(head == 0 && tail == 2 && owed == 292 * (USDC as u128), 6);

        // Carol's short loses 200 capped at margin 100 while the queue is active: no
        // fee (Paper Trade rule), inflow 100 => Alice's 96 fully paid, Bob gets 4.
        exchange::close_position(carol, 3);
        assert!(exchange::balance_of(@0xCA401) == 900 * USDC, 7);
        assert!(exchange::balance_of(@0xA11CE) == 1196 * USDC, 8);
        assert!(exchange::balance_of(@0xB0B) == 1004 * USDC, 9);
        let (head, tail, owed) = exchange::queue_state();
        assert!(head == 1 && tail == 2 && owed == 192 * (USDC as u128), 10);
        let (_, _, orig, rem) = exchange::queue_entry(1);
        assert!(orig == 196 * USDC && rem == 192 * USDC, 11);
        assert!(exchange::pool_balance() == 0, 12);
        assert!(exchange::dev_fees() == 0, 13);
        assert!(paper::balance_of(@0xCA401) == 10_000 * 1_000_000, 17); // full loss basis
        check_invariants();

        // A donation pays the rest of the queue first; leftover stays in pool.
        seed_pool(admin, 200 * USDC);
        assert!(exchange::balance_of(@0xB0B) == 1196 * USDC, 14);
        let (head, tail, owed) = exchange::queue_state();
        assert!(head == 2 && tail == 2 && owed == 0, 15);
        assert!(exchange::pool_balance() == 8 * USDC, 16);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_win_against_empty_pool(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 100 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 5_500_000_000_000);
        exchange::close_position(alice, 1);
        // Margin returned; entire net profit queued.
        assert!(exchange::balance_of(@0xA11CE) == 100 * USDC, 0);
        let (_, tail, owed) = exchange::queue_state();
        assert!(tail == 1 && owed == 98 * (USDC as u128), 1);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B, carol = @0xCA401, dave = @0xDA7E)]
    fun test_queue_many_entries_step_bound(
        fw: &signer, admin: &signer, alice: &signer, bob: &signer, carol: &signer, dave: &signer
    ) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        fund_trader(dave, 1000 * USDC);
        fund_trader(bob, 1000 * USDC);
        fund_trader(carol, 1000 * USDC);
        let i = 0;
        while (i < 20) {
            exchange::open_position(alice, BTC, true, 10 * USDC, 10);
            exchange::open_position(dave, BTC, true, 10 * USDC, 10);
            i = i + 1;
        };
        exchange::open_position(bob, BTC, false, 1000 * USDC, 10); // id 41
        exchange::open_position(carol, BTC, true, 100 * USDC, 10); // id 42
        set_btc(admin, 5_500_000_000_000); // +10%

        // 40 winners against an empty pool: each profit 10, net 9.8 queued.
        let id = 1;
        while (id <= 40) {
            let owner = if (id % 2 == 1) alice else dave;
            exchange::close_position(owner, id);
            id = id + 1;
        };
        let (head, tail, owed) = exchange::queue_state();
        assert!(head == 0 && tail == 40 && owed == 392 * (USDC as u128), 0);

        // Bob loses 1000 while queue active: no fee, inflow 1000 but only AUTO_QUEUE_STEPS entries processed.
        exchange::close_position(bob, 41);
        let steps = exchange::auto_queue_steps();
        let (head, _, owed) = exchange::queue_state();
        assert!(head == steps, 1);
        assert!(owed == ((40 - steps) * 9_800_000 as u128), 2);
        assert!(exchange::pool_balance() == 1000 * USDC - steps * 9_800_000, 3);

        // Carol wins while entries remain beyond the step budget: she is queued at the
        // back even though the pool has funds (FIFO fairness).
        exchange::close_position(carol, 42);
        let (head, tail, _) = exchange::queue_state();
        assert!(head == 2 * steps && tail == 41, 4);
        let (o, _, _, rem) = exchange::queue_entry(40);
        assert!(o == @0xCA401 && rem == 98 * USDC, 5);
        assert!(exchange::balance_of(@0xCA401) == 1000 * USDC, 6);
        check_invariants();

        // Permissionless crank clears the rest.
        exchange::process_queue(bob, 200);
        let (head, tail, owed) = exchange::queue_state();
        assert!(head == 41 && tail == 41 && owed == 0, 7);
        assert!(exchange::balance_of(@0xCA401) == 1098 * USDC, 8);
        assert!(exchange::balance_of(@0xA11CE) == 1000 * USDC + 20 * 9_800_000, 9);
        assert!(exchange::balance_of(@0xDA7E) == 1000 * USDC + 20 * 9_800_000, 10);
        assert!(exchange::pool_balance() == 1000 * USDC - 392 * USDC - 98 * USDC, 11);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 14, location = papertrade::exchange)]
    fun test_crank_zero_steps(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        exchange::process_queue(alice, 0);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 14, location = papertrade::exchange)]
    fun test_crank_too_many_steps(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        exchange::process_queue(alice, 201);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_crank_on_empty_queue_noop(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        exchange::process_queue(alice, 10);
        let (h, t, o) = exchange::queue_state();
        assert!(h == 0 && t == 0 && o == 0, 0);
    }

    // ---------------------------------------------------------------------
    // Staking
    // ---------------------------------------------------------------------

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B, carol = @0xCA401)]
    fun test_staking_rewards_and_late_staker(
        fw: &signer, admin: &signer, alice: &signer, bob: &signer, carol: &signer
    ) {
        setup(fw, admin);
        seed_pool(admin, 1_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        give_and_stake_paper(bob, 1000 * USDC);
        paper::mint_for_test(@0xCA401, 1000 * USDC);
        assert!(paper::total_staked() == 1000 * USDC, 0);
        assert!(paper::staked_of(@0xB0B) == 1000 * USDC && paper::balance_of(@0xB0B) == 0, 1);

        // Loss of 50 => fee 1 => 0.5 to stakers (all Bob).
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 4_750_000_000_000);
        exchange::close_position(alice, 1);
        assert!(paper::pending_rewards(@0xB0B) == 500_000, 2);

        // Carol stakes after rewards: she gets none of them.
        paper::stake(carol, 1000 * USDC);
        assert!(paper::pending_rewards(@0xCA401) == 0, 3);

        // Second loss of 50 (from 47.5k, -5% => 45.125k): 0.5 split equally.
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 4_512_500_000_000);
        exchange::close_position(alice, 2);
        assert!(paper::pending_rewards(@0xB0B) == 750_000, 4);
        assert!(paper::pending_rewards(@0xCA401) == 250_000, 5);

        // Bob unstakes everything: keeps his accrued rewards, earns nothing more.
        paper::unstake(bob, 1000 * USDC);
        assert!(paper::balance_of(@0xB0B) == 1000 * USDC, 6);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 4_286_875_000_000); // -5%
        exchange::close_position(alice, 3);
        assert!(paper::pending_rewards(@0xB0B) == 750_000, 7);
        assert!(paper::pending_rewards(@0xCA401) == 750_000, 8);

        paper::claim(bob);
        paper::claim(carol);
        assert!(test_usdc::balance(@0xB0B) == 750_000, 9);
        assert!(test_usdc::balance(@0xCA401) == 750_000, 10);
        let (dep, claimed, vault) = paper::reward_stats();
        assert!(dep == 1_500_000 && claimed == 1_500_000 && vault == 0, 11);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    fun test_rewards_go_to_dev_when_nothing_staked(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        seed_pool(admin, 1_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        give_and_stake_paper(bob, 1000);
        paper::unstake(bob, 1000);
        assert!(paper::total_staked() == 0, 0);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 4_750_000_000_000);
        exchange::close_position(alice, 1);
        assert!(exchange::dev_fees() == 1 * USDC, 1);
        let (to_stakers, _) = exchange::fee_stats();
        assert!(to_stakers == 0, 2);
        // Re-staking later does not capture past fees.
        paper::stake(bob, 1000);
        assert!(paper::pending_rewards(@0xB0B) == 0, 3);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, b1 = @0xB1, b2 = @0xB2, b3 = @0xB3)]
    fun test_reward_rounding_never_insolvent(
        fw: &signer, admin: &signer, alice: &signer, b1: &signer, b2: &signer, b3: &signer
    ) {
        setup(fw, admin);
        seed_pool(admin, 1_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        give_and_stake_paper(b1, 1);
        give_and_stake_paper(b2, 1);
        give_and_stake_paper(b3, 7);
        // Many small odd losses => odd staker fees.
        let i = 0;
        let price = BTC_50K;
        while (i < 5) {
            exchange::open_position(alice, BTC, true, 13 * USDC, 7);
            price = price - 1_234_567_891;
            set_btc(admin, price);
            exchange::close_position(alice, i + 1);
            set_btc(admin, BTC_50K);
            price = BTC_50K;
            i = i + 1;
        };
        let (_, _, vault) = paper::reward_stats();
        let total_pending = paper::pending_rewards(@0xB1) + paper::pending_rewards(@0xB2)
            + paper::pending_rewards(@0xB3);
        assert!(total_pending <= vault, 0);
        // Dust is bounded by the number of stakers.
        assert!(vault - total_pending <= 3, 1);
        paper::claim(b1);
        paper::claim(b2);
        paper::claim(b3);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, bob = @0xB0B)]
    #[expected_failure(abort_code = 2, location = papertrade::paper)]
    fun test_stake_more_than_balance(fw: &signer, admin: &signer, bob: &signer) {
        setup(fw, admin);
        paper::mint_for_test(@0xB0B, 10);
        paper::stake(bob, 11);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, bob = @0xB0B)]
    #[expected_failure(abort_code = 3, location = papertrade::paper)]
    fun test_unstake_more_than_staked(fw: &signer, admin: &signer, bob: &signer) {
        setup(fw, admin);
        give_and_stake_paper(bob, 10);
        paper::unstake(bob, 11);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, bob = @0xB0B)]
    #[expected_failure(abort_code = 3, location = papertrade::paper)]
    fun test_unstake_without_account(fw: &signer, admin: &signer, bob: &signer) {
        setup(fw, admin);
        paper::unstake(bob, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, bob = @0xB0B)]
    #[expected_failure(abort_code = 5, location = papertrade::paper)]
    fun test_claim_nothing(fw: &signer, admin: &signer, bob: &signer) {
        setup(fw, admin);
        give_and_stake_paper(bob, 10);
        paper::claim(bob);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, bob = @0xB0B)]
    #[expected_failure(abort_code = 1, location = papertrade::paper)]
    fun test_stake_zero(fw: &signer, admin: &signer, bob: &signer) {
        setup(fw, admin);
        paper::stake(bob, 0);
    }

    // ---------------------------------------------------------------------
    // Pool cap
    // ---------------------------------------------------------------------

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    fun test_lp_cap_sweep_to_stakers(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        seed_pool(admin, 5_000_000 * USDC);
        give_and_stake_paper(bob, 1000);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 4_750_000_000_000);
        exchange::close_position(alice, 1);
        // fee 1 (0.5 stakers / 0.5 dev), pool gain 49 swept to stakers.
        assert!(exchange::pool_balance() == 5_000_000 * USDC, 0);
        assert!(paper::pending_rewards(@0xB0B) == 49_500_000, 1);
        assert!(exchange::dev_fees() == 500_000, 2);
        // HWM 0 => 100/$ on basis 49.
        assert!(paper::balance_of(@0xA11CE) == 4900 * 1_000_000, 3);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_lp_cap_sweep_without_stakers_goes_to_dev(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        seed_pool(admin, 5_000_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 4_750_000_000_000);
        exchange::close_position(alice, 1);
        assert!(exchange::pool_balance() == 5_000_000 * USDC, 0);
        assert!(exchange::dev_fees() == 50 * USDC, 1);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 13, location = papertrade::exchange)]
    fun test_fund_pool_above_cap(fw: &signer, admin: &signer) {
        setup(fw, admin);
        seed_pool(admin, 5_000_000 * USDC);
        seed_pool(admin, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_fund_pool_room_includes_queue(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 100 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 5_500_000_000_000);
        exchange::close_position(alice, 1); // 98 queued
        // Can donate cap + owed in one go.
        seed_pool(admin, 5_000_000 * USDC + 98 * USDC);
        assert!(exchange::pool_balance() == 5_000_000 * USDC, 0);
        assert!(exchange::balance_of(@0xA11CE) == 198 * USDC, 1);
        check_invariants();
    }

    // ---------------------------------------------------------------------
    // Overflow / extreme values
    // ---------------------------------------------------------------------

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    fun test_extreme_values_no_overflow(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        exchange::set_oi_cap(admin, BTC, U64_MAX);
        // margin ~1.8e16 units, 1000x => notional ~1.8e19 (near u64::MAX)
        let margin = U64_MAX / 1000;
        fund_trader(alice, margin);
        fund_trader(bob, margin);
        set_btc(admin, 1); // minimum price
        exchange::open_position(alice, BTC, true, margin, 1000);
        exchange::open_position(bob, BTC, false, margin, 1000);
        set_btc(admin, 1_000_000_000_000_000_000); // max price: x1e18 move
        // notional * diff ~ 1.8e37 fits u256; result clamped to u64::MAX.
        let (is_profit, pnl) = exchange::unrealized_pnl(1);
        assert!(is_profit && pnl == U64_MAX, 0);
        let (is_profit, pnl) = exchange::unrealized_pnl(2);
        assert!(!is_profit && pnl == margin, 1);
        assert!(exchange::is_liquidatable(2), 2);
        let _ = exchange::liquidation_price(1);
        // Bob's short is bankrupt: loses exactly the margin.
        exchange::liquidate(alice, 2);
        assert!(exchange::balance_of(@0xB0B) == 0, 3);
        // Alice's absurd profit: pool pays what it has, the rest is queued.
        exchange::close_position(alice, 1);
        let (_, _, owed) = exchange::queue_state();
        assert!(owed > 0, 4);
        assert!(exchange::pool_balance() == 0, 5);
        check_invariants();
    }

    // ---------------------------------------------------------------------
    // Admin / pause
    // ---------------------------------------------------------------------

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 11, location = papertrade::exchange)]
    fun test_paused_blocks_open(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 100 * USDC);
        exchange::set_paused(admin, true);
        exchange::open_position(alice, BTC, true, 10 * USDC, 10);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_paused_allows_close_and_withdraw(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 100 * USDC);
        exchange::open_position(alice, BTC, true, 10 * USDC, 10);
        exchange::set_paused(admin, true);
        assert!(exchange::is_paused(), 0);
        exchange::close_position(alice, 1);
        exchange::withdraw(alice, 100 * USDC);
        assert!(test_usdc::balance(@0xA11CE) == 100 * USDC, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 1, location = papertrade::exchange)]
    fun test_non_admin_pause(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        exchange::set_paused(alice, true);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, new_admin = @0xAD)]
    fun test_exchange_admin_transfer(fw: &signer, admin: &signer, new_admin: &signer) {
        setup(fw, admin);
        exchange::transfer_admin(admin, @0xAD);
        exchange::accept_admin(new_admin);
        assert!(exchange::admin() == @0xAD, 0);
        exchange::set_paused(new_admin, true);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, new_admin = @0xAD)]
    #[expected_failure(abort_code = 1, location = papertrade::exchange)]
    fun test_old_admin_loses_rights(fw: &signer, admin: &signer, new_admin: &signer) {
        setup(fw, admin);
        exchange::transfer_admin(admin, @0xAD);
        exchange::accept_admin(new_admin);
        exchange::set_paused(admin, true);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, mallory = @0xBAD)]
    #[expected_failure(abort_code = 15, location = papertrade::exchange)]
    fun test_exchange_accept_admin_wrong_signer(fw: &signer, admin: &signer, mallory: &signer) {
        setup(fw, admin);
        exchange::transfer_admin(admin, @0xAD);
        exchange::accept_admin(mallory);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_last_position_helper(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 100 * USDC);
        exchange::open_position(alice, BTC, true, 10 * USDC, 10);
        exchange::open_position(alice, ETH, true, 10 * USDC, 10);
        assert!(last_position(@0xA11CE) == 2, 0);
        exchange::close_position(alice, 1);
        assert!(exchange::user_positions(@0xA11CE) == vector[2], 1);
    }

    // ---------------------------------------------------------------------
    // Review regressions
    // ---------------------------------------------------------------------

    // The deployer must not be able to pull funds out of the exchange vault directly
    // (object ownership is transitive, so owning the vault object would allow it).
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 327688, location = aptos_framework::fungible_asset)]
    fun test_deployer_cannot_drain_exchange_vault(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        let store = primary_fungible_store::primary_store(exchange::vault_address(), test_usdc::metadata());
        let fa = fungible_asset::withdraw(admin, store, 1000 * USDC);
        primary_fungible_store::deposit(@papertrade, fa);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    #[expected_failure(abort_code = 327688, location = aptos_framework::fungible_asset)]
    fun test_deployer_cannot_drain_reward_vault(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        seed_pool(admin, 1_000 * USDC);
        give_and_stake_paper(bob, 1000);
        fund_trader(alice, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        set_btc(admin, 4_750_000_000_000);
        exchange::close_position(alice, 1);
        let store = primary_fungible_store::primary_store(paper::vault_address(), test_usdc::metadata());
        let fa = fungible_asset::withdraw(admin, store, 1);
        primary_fungible_store::deposit(@papertrade, fa);
    }

    // Liquidation proceeds are a pool inflow and must pay the FIFO queue first.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    fun test_liquidation_pays_queue(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1000 * USDC);
        fund_trader(bob, 1000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);  // winner
        exchange::open_position(bob, BTC, false, 100 * USDC, 100);  // gets liquidated
        set_btc(admin, 5_500_000_000_000);
        exchange::close_position(alice, 1); // 98 queued, pool empty
        exchange::liquidate(alice, 2);      // +100 inflow (liq fee waived: queue active)
        let (head, tail, owed) = exchange::queue_state();
        assert!(head == 1 && tail == 1 && owed == 0, 0);
        assert!(exchange::balance_of(@0xA11CE) == 1098 * USDC, 1);
        assert!(exchange::pool_balance() == 2 * USDC, 2);
        check_invariants();
    }

    // Every fee unit is accounted exactly once: dev + stakers == sum of charged fees,
    // and total USDC is conserved across wallets + vaults.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B, carol = @0xCA401)]
    fun test_fee_accounting_and_conservation(
        fw: &signer, admin: &signer, alice: &signer, bob: &signer, carol: &signer
    ) {
        setup(fw, admin);
        seed_pool(admin, 10_000 * USDC);
        fund_trader(alice, 1000 * USDC);
        fund_trader(carol, 1000 * USDC);
        give_and_stake_paper(bob, 777);
        // Win: profit 100 => fee 2
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        // Loss: short, +10% => loss 100 => fee 2
        exchange::open_position(carol, BTC, false, 100 * USDC, 10);
        // Liquidation: 100x long margin 50 => fee 1
        exchange::open_position(carol, ETH, true, 50 * USDC, 100);
        set_btc(admin, 5_500_000_000_000);
        oracle::push_price(admin, ETH, 270_000_000_000, START);
        exchange::close_position(alice, 1);
        exchange::close_position(carol, 2);
        exchange::liquidate(bob, 3);
        let (to_stakers, to_dev) = exchange::fee_stats();
        assert!(to_stakers + to_dev == 5 * (USDC as u128), 0);
        assert!(to_stakers == 2_500_000, 1); // 1 + 1 + 0.5 (split floors in base units)
        assert!((exchange::dev_fees() as u128) == to_dev, 2);
        let (deposited, _, _) = paper::reward_stats();
        assert!(deposited == to_stakers, 3);
        // Pool: 10,000 - 100 (win payout incl. fee) + 98 + 49
        assert!(exchange::pool_balance() == 10_047 * USDC, 4);
        paper::claim(bob);
        exchange::withdraw(alice, exchange::balance_of(@0xA11CE));
        exchange::withdraw(carol, exchange::balance_of(@0xCA401));
        let (vault, _, _, _, _) = exchange::accounting();
        let (_, _, reward_vault) = paper::reward_stats();
        let total = test_usdc::balance(@0xA11CE) + test_usdc::balance(@0xB0B)
            + test_usdc::balance(@0xCA401) + vault + reward_vault;
        assert!(total == 12_000 * USDC, 5);
        check_invariants();
    }

    // Vault objects are detached from the deployer and cannot be moved.
    #[test(fw = @aptos_framework, admin = @papertrade)]
    fun test_vaults_not_owned_by_deployer(fw: &signer, admin: &signer) {
        setup(fw, admin);
        let ex_vault = aptos_framework::object::address_to_object<aptos_framework::object::ObjectCore>(
            exchange::vault_address()
        );
        let rw_vault = aptos_framework::object::address_to_object<aptos_framework::object::ObjectCore>(
            paper::vault_address()
        );
        assert!(!aptos_framework::object::owns(ex_vault, @papertrade), 0);
        assert!(!aptos_framework::object::owns(rw_vault, @papertrade), 1);
        assert!(!aptos_framework::object::ungated_transfer_allowed(ex_vault), 2);
        assert!(!aptos_framework::object::ungated_transfer_allowed(rw_vault), 3);
    }

    // ---------------------------------------------------------------------
    // hedge
    // ---------------------------------------------------------------------

    /// Stand-in for a Decibel Trading Account: an object owned by `owner`.
    fun make_subaccount(owner: &signer): address {
        let cref = aptos_framework::object::create_object(signer::address_of(owner));
        aptos_framework::object::address_from_constructor_ref(&cref)
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_hedge_open_position_hedged(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1_000 * USDC);
        let sub = make_subaccount(alice);
        exchange::open_position(alice, ETH, false, 10 * USDC, 2); // id 1, not hedged
        hedge::open_position_hedged(alice, BTC, true, 100 * USDC, 10, sub); // id 2
        assert!(last_position(@0xA11CE) == 2, 0);
        let (ids, owners, subs) = hedge::active_requests();
        assert!(ids == vector[2] && owners == vector[@0xA11CE] && subs == vector[sub], 1);
        let (exists, owner, s, at) = hedge::request_of(2);
        assert!(exists && owner == @0xA11CE && s == sub && at == START, 2);
        let (exists1, _, _, _) = hedge::request_of(1);
        assert!(!exists1, 3);
        check_invariants();
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun test_hedge_request_existing_and_cancel(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1_000 * USDC);
        let sub = make_subaccount(alice);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        hedge::request_hedge(alice, 1, sub);
        let (exists, _, _, _) = hedge::request_of(1);
        assert!(exists, 0);
        hedge::cancel_hedge(alice, 1);
        let (ids, _, _) = hedge::active_requests();
        assert!(ids.is_empty(), 1);
        // Can request again after cancelling.
        hedge::request_hedge(alice, 1, sub);
        let (ids2, _, _) = hedge::active_requests();
        assert!(ids2 == vector[1], 2);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    #[expected_failure(abort_code = 1, location = papertrade::hedge)]
    fun test_hedge_request_not_position_owner(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1_000 * USDC);
        let bob_sub = make_subaccount(bob);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        hedge::request_hedge(bob, 1, bob_sub);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    #[expected_failure(abort_code = 2, location = papertrade::hedge)]
    fun test_hedge_subaccount_owned_by_someone_else(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1_000 * USDC);
        // Alice must not be able to point her hedge at Bob's (delegated) Trading Account.
        let bob_sub = make_subaccount(bob);
        hedge::open_position_hedged(alice, BTC, true, 100 * USDC, 10, bob_sub);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 2, location = papertrade::hedge)]
    fun test_hedge_subaccount_not_an_object(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1_000 * USDC);
        hedge::open_position_hedged(alice, BTC, true, 100 * USDC, 10, @0xA11CE);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 3, location = papertrade::hedge)]
    fun test_hedge_duplicate_request(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1_000 * USDC);
        let sub = make_subaccount(alice);
        hedge::open_position_hedged(alice, BTC, true, 100 * USDC, 10, sub);
        hedge::request_hedge(alice, 1, sub);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    #[expected_failure(abort_code = 1, location = papertrade::hedge)]
    fun test_hedge_cancel_not_owner(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1_000 * USDC);
        let sub = make_subaccount(alice);
        hedge::open_position_hedged(alice, BTC, true, 100 * USDC, 10, sub);
        hedge::cancel_hedge(bob, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 4, location = papertrade::hedge)]
    fun test_hedge_cancel_missing(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin);
        hedge::cancel_hedge(alice, 7);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    #[expected_failure(abort_code = 5, location = papertrade::hedge)]
    fun test_hedge_prune_open_position(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        fund_trader(alice, 1_000 * USDC);
        let sub = make_subaccount(alice);
        hedge::open_position_hedged(alice, BTC, true, 100 * USDC, 10, sub);
        hedge::prune(bob, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    fun test_hedge_prune_after_close_and_liquidation(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        setup(fw, admin);
        seed_pool(admin, 1_000 * USDC);
        fund_trader(alice, 1_000 * USDC);
        let sub = make_subaccount(alice);
        hedge::open_position_hedged(alice, BTC, true, 100 * USDC, 10, sub); // 1: closed by owner
        hedge::open_position_hedged(alice, BTC, true, 10 * USDC, 1000, sub); // 2: liquidated
        exchange::close_position(alice, 1);
        set_btc(admin, 4_997_500_000_000);
        exchange::liquidate(bob, 2);
        // Requests survive the close until pruned, so the hedger can still find and flatten them.
        let (ids, _, _) = hedge::active_requests();
        assert!(ids == vector[1, 2], 0);
        hedge::prune(bob, 2);
        hedge::prune(bob, 1);
        let (ids2, _, _) = hedge::active_requests();
        assert!(ids2.is_empty(), 1);
        check_invariants();
    }
}
