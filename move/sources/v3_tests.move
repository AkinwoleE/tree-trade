#[test_only]
/// Paper Trade risk parity (exchange V3): hard-bust trigger, position size limits, per-side OI caps.
module papertrade::v3_tests {
    use std::vector;
    use papertrade::exchange;
    use papertrade::oracle;
    use papertrade::tests;

    const USDC: u64 = 1_000_000;
    const BTC: u8 = 0;
    const E50K: u64 = 5_000_000_000_000;

    fun btc(admin: &signer, p: u64) { oracle::push_price(admin, BTC, p, aptos_framework::timestamp::now_seconds()); }
    fun last(user: address): u64 { let ids = exchange::user_positions(user); *vector::borrow(&ids, vector::length(&ids) - 1) }
    fun setup(fw: &signer, admin: &signer, alice: &signer) {
        tests::setup_for(fw, admin);
        tests::seed_pool_for(admin, 100_000 * USDC);
        exchange::init_v2(admin);
        exchange::init_v3(admin);
        tests::fund_trader_for(alice, 30_000 * USDC);
    }

    // $1K minimum position value (margin x leverage).
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 31, location = papertrade::exchange)]
    fun below_min_notional(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin, alice);
        exchange::open_position(alice, BTC, true, 10 * USDC, 99); // $990
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun min_and_max_notional_ok(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin, alice);
        exchange::open_position(alice, BTC, true, 10 * USDC, 100);        // $1,000
        exchange::open_position(alice, BTC, true, 10_000 * USDC, 1000);   // $10,000,000
    }

    // $10M maximum position value.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 32, location = papertrade::exchange)]
    fun above_max_notional(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin, alice);
        exchange::open_position(alice, BTC, true, 10_001 * USDC, 1000);
    }

    // Independent per-side caps in base-asset quantity; closes free capacity.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun side_caps(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin, alice);
        exchange::set_side_caps(admin, BTC, 100_000_000, 0); // 1 BTC long, short paused
        exchange::open_position(alice, BTC, true, 100 * USDC, 500); // $50k = 1 BTC exactly
        let (lq, sq, lc, sc) = exchange::side_oi(BTC);
        assert!(lq == 100_000_000 && sq == 0 && lc == 100_000_000 && sc == 0, 0);
        exchange::close_position(alice, last(@0xA11CE));
        let (lq2, _, _, _) = exchange::side_oi(BTC);
        assert!(lq2 == 0, 1);
        exchange::open_position(alice, BTC, true, 100 * USDC, 500);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 33, location = papertrade::exchange)]
    fun long_cap_rejects(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin, alice);
        exchange::set_side_caps(admin, BTC, 100_000_000, 1_000_000_000);
        exchange::open_position(alice, BTC, true, 100 * USDC, 500);
        exchange::open_position(alice, BTC, true, 10 * USDC, 100);  // over the long cap
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 33, location = papertrade::exchange)]
    fun paused_short_side_rejects(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin, alice);
        exchange::set_side_caps(admin, BTC, 1_000_000_000, 0);
        exchange::open_position(alice, BTC, false, 10 * USDC, 100);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 30, location = papertrade::exchange)]
    fun only_market_keeper_sets_caps(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin, alice);
        exchange::set_side_caps(alice, BTC, 0, 0);
    }

    // Hard bust: long p0 = ceil(e(L-1)/L), bust = floor(p0(1+buf)); short mirrored.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun bust_trigger_long_short(fw: &signer, admin: &signer, alice: &signer) {
        setup(fw, admin, alice);
        exchange::open_position(alice, BTC, true, 100 * USDC, 100);
        let l = last(@0xA11CE);
        exchange::open_position(alice, BTC, false, 100 * USDC, 100);
        let s = last(@0xA11CE);
        exchange::open_position(alice, BTC, true, 10 * USDC, 1000);
        let l1k = last(@0xA11CE);
        assert!(exchange::liquidation_price(l) == 4_952_356_405_821, 0);
        assert!(exchange::liquidation_price(s) == 5_047_595_990_021, 1);
        assert!(exchange::liquidation_price(l1k) == 4_997_377_827_692, 2); // 0.0524% at 1000x
        btc(admin, 4_952_356_405_822);
        assert!(!exchange::is_liquidatable(l), 3);  // 0.95% loss: old 0.5% rule would liquidate
        btc(admin, 4_952_356_405_821);
        assert!(exchange::is_liquidatable(l), 4);
        exchange::liquidate(admin, l);
        btc(admin, 5_047_595_990_020);
        assert!(!exchange::is_liquidatable(s), 5);
        btc(admin, 5_047_595_990_021);
        assert!(exchange::is_liquidatable(s), 6);
    }

    // Positions opened before V3 keep working (not counted in side qty, no underflow).
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun pre_v3_position_closes(fw: &signer, admin: &signer, alice: &signer) {
        tests::setup_for(fw, admin);
        tests::seed_pool_for(admin, 100_000 * USDC);
        tests::fund_trader_for(alice, 1_000 * USDC);
        exchange::open_position(alice, BTC, true, 10 * USDC, 10);  // $100, legal pre-V3
        exchange::init_v2(admin);
        exchange::init_v3(admin);
        exchange::close_position(alice, 1);
        let (lq, _, _, _) = exchange::side_oi(BTC);
        assert!(lq == 0, 0);
    }
}
