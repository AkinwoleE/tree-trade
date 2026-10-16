#[test_only]
/// Phase B fixes (AUDIT_2026-10-15 decisions 1-8).
module papertrade::v4_tests {
    use std::signer;
    use std::vector;
    use aptos_std::ed25519;
    use aptos_framework::object;
    use aptos_framework::timestamp;
    use papertrade::exchange;
    use papertrade::hedge;
    use papertrade::oracle;
    use papertrade::paper;
    use papertrade::tests;

    const USDC: u64 = 1_000_000;
    const BTC_50K: u64 = 5_000_000_000_000;

    fun boot(fw: &signer, admin: &signer): ed25519::SecretKey {
        tests::setup_for(fw, admin);
        tests::seed_pool_for(admin, 1_000_000 * USDC);
        let (sk, vpk) = ed25519::generate_keys();
        oracle::init_guard(admin, ed25519::validated_public_key_to_bytes(&vpk));
        exchange::init_v4(admin);
        hedge::init_v2(admin);
        sk
    }

    fun sig(sk: &ed25519::SecretKey, market: u8, price: u64, ts: u64): vector<u8> {
        ed25519::signature_to_bytes(&ed25519::sign_arbitrary_bytes(sk, oracle::signed_message(market, price, ts)))
    }

    fun last(user: address): u64 { let ids = exchange::user_positions(user); *vector::borrow(&ids, vector::length(&ids) - 1) }

    fun sub_of(owner: address): address { object::address_from_constructor_ref(&object::create_object(owner)) }

    // ---- 2. fresh signed price per trade ----
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun signed_open_close_roundtrip(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let now = timestamp::now_seconds();
        exchange::open_position_px(alice, 0, true, 100 * USDC, 10, BTC_50K, now, sig(&sk, 0, BTC_50K, now));
        let id = last(@0xA11CE);
        timestamp::fast_forward_seconds(5);
        let p2 = BTC_50K + BTC_50K / 500; // +0.2% in 5s: within the move cap
        exchange::close_position_px(alice, id, p2, now + 5, sig(&sk, 0, p2, now + 5));
        assert!(exchange::balance_of(@0xA11CE) > 1_000 * USDC, 0);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 36, location = papertrade::exchange)]
    fun legacy_open_disabled_under_v4(fw: &signer, admin: &signer, alice: &signer) {
        boot(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        exchange::open_position(alice, 0, true, 100 * USDC, 10);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 16, location = papertrade::oracle)]
    fun forged_signature_rejected(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let now = timestamp::now_seconds();
        exchange::open_position_px(alice, 0, true, 100 * USDC, 10, BTC_50K - 1, now, sig(&sk, 0, BTC_50K, now));
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 17, location = papertrade::oracle)]
    fun stale_signed_price_rejected(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let now = timestamp::now_seconds();
        let s = sig(&sk, 0, BTC_50K, now);
        timestamp::fast_forward_seconds(11);
        exchange::open_position_px(alice, 0, true, 100 * USDC, 10, BTC_50K, now, s);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 16, location = papertrade::oracle)]
    fun signature_not_replayable_across_markets(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let now = timestamp::now_seconds();
        exchange::open_position_px(alice, 1, true, 100 * USDC, 10, BTC_50K, now, sig(&sk, 0, BTC_50K, now));
    }

    // Fallback: legacy close works only while the keeper price is fresh.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 36, location = papertrade::exchange)]
    fun legacy_close_needs_fresh_keeper_price(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let now = timestamp::now_seconds();
        exchange::open_position_px(alice, 0, true, 100 * USDC, 10, BTC_50K, now, sig(&sk, 0, BTC_50K, now));
        timestamp::fast_forward_seconds(30);
        exchange::close_position(alice, last(@0xA11CE));
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun legacy_close_ok_with_fresh_keeper_price(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let now = timestamp::now_seconds();
        exchange::open_position_px(alice, 0, true, 100 * USDC, 10, BTC_50K, now, sig(&sk, 0, BTC_50K, now));
        timestamp::fast_forward_seconds(5);
        exchange::close_position(alice, last(@0xA11CE));
    }

    // ---- 4. on-chain per-update move cap ----
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 18, location = papertrade::oracle)]
    fun signed_price_move_capped(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        timestamp::fast_forward_seconds(1);
        let now = timestamp::now_seconds();
        let p = BTC_50K + BTC_50K / 50; // +2% in 1s > 0.5% + 0.1%/s
        exchange::open_position_px(alice, 0, true, 100 * USDC, 10, p, now, sig(&sk, 0, p, now));
    }

    #[test(fw = @aptos_framework, admin = @papertrade, keeper = @0xBEEF)]
    #[expected_failure(abort_code = 18, location = papertrade::oracle)]
    fun keeper_push_move_capped(fw: &signer, admin: &signer, keeper: &signer) {
        boot(fw, admin);
        oracle::add_keeper(admin, @0xBEEF);
        timestamp::fast_forward_seconds(1);
        oracle::push_price(keeper, 0, BTC_50K / 2, timestamp::now_seconds());
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    fun admin_push_unbounded_circuit_breaker(fw: &signer, admin: &signer) {
        boot(fw, admin);
        timestamp::fast_forward_seconds(1);
        oracle::push_price(admin, 0, BTC_50K / 2, timestamp::now_seconds());
    }

    // ---- 5. per-owner hedge request cap ----
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 7, location = papertrade::hedge)]
    fun hedge_requests_capped_per_owner(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        hedge::set_max_per_owner(admin, 2);
        tests::fund_trader_for(alice, 10_000 * USDC);
        let sub = sub_of(@0xA11CE);
        let now = timestamp::now_seconds();
        let i = 0;
        while (i < 3) {
            hedge::open_position_hedged_px(alice, 0, true, 100 * USDC, 10, sub, BTC_50K, now, sig(&sk, 0, BTC_50K, now));
            i = i + 1;
        };
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun hedge_count_tracks(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 10_000 * USDC);
        let now = timestamp::now_seconds();
        hedge::open_position_hedged_px(alice, 0, true, 100 * USDC, 10, sub_of(@0xA11CE), BTC_50K, now, sig(&sk, 0, BTC_50K, now));
        let (n, cap) = hedge::owner_requests(@0xA11CE);
        assert!(n == 1 && cap == 16, 0);
    }

    // ---- 6. default OI cap when keeper caps go stale ----
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 7, location = papertrade::exchange)]
    fun default_oi_cap_applies_when_keeper_silent(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        exchange::init_v3(admin);
        exchange::set_side_caps(admin, 0, 1_000_000_000_000_000, 1_000_000_000_000_000);
        exchange::set_oi_cap(admin, 0, 500 * USDC);
        tests::fund_trader_for(alice, 1_000 * USDC);
        timestamp::fast_forward_seconds(901);
        oracle::push_price(admin, 0, BTC_50K, timestamp::now_seconds());
        let now = timestamp::now_seconds();
        exchange::open_position_px(alice, 0, true, 100 * USDC, 10, BTC_50K, now, sig(&sk, 0, BTC_50K, now));
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun live_keeper_caps_override_default(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        exchange::init_v3(admin);
        exchange::set_side_caps(admin, 0, 1_000_000_000_000_000, 1_000_000_000_000_000);
        exchange::set_oi_cap(admin, 0, 500 * USDC);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let now = timestamp::now_seconds();
        exchange::open_position_px(alice, 0, true, 100 * USDC, 10, BTC_50K, now, sig(&sk, 0, BTC_50K, now));
    }

    // ---- 7. session-key scope + 7-day expiry ----
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, sess = @0x5E55)]
    #[expected_failure(abort_code = 10, location = papertrade::hedge)]
    fun session_key_hedge_needs_scope(fw: &signer, admin: &signer, alice: &signer, sess: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let now = timestamp::now_seconds();
        exchange::delegate_trading_with_scope(alice, @0x5E55, now + 3600, false, false);
        hedge::open_position_hedged_as_delegate_px(sess, @0xA11CE, 0, true, 100 * USDC, 10, sub_of(@0xA11CE), BTC_50K, now, sig(&sk, 0, BTC_50K, now));
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, sess = @0x5E55)]
    fun session_key_hedge_with_scope(fw: &signer, admin: &signer, alice: &signer, sess: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let now = timestamp::now_seconds();
        exchange::delegate_trading_with_scope(alice, @0x5E55, now + 3600, true, false);
        hedge::open_position_hedged_as_delegate_px(sess, @0xA11CE, 0, true, 100 * USDC, 10, sub_of(@0xA11CE), BTC_50K, now, sig(&sk, 0, BTC_50K, now));
        timestamp::fast_forward_seconds(2);
        let n2 = timestamp::now_seconds();
        exchange::close_position_as_delegate_px(sess, @0xA11CE, last(@0xA11CE), BTC_50K, n2, sig(&sk, 0, BTC_50K, n2));
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, sess = @0x5E55)]
    #[expected_failure(abort_code = 37, location = papertrade::exchange)]
    fun session_key_queue_needs_scope(fw: &signer, admin: &signer, alice: &signer, sess: &signer) {
        let sk = boot(fw, admin);
        let now = timestamp::now_seconds();
        exchange::delegate_trading_with_scope(alice, @0x5E55, now + 3600, true, false);
        exchange::open_position_from_queue_as_delegate_px(sess, @0xA11CE, 0, true, 100 * USDC, 10, BTC_50K, now, sig(&sk, 0, BTC_50K, now));
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 20, location = papertrade::exchange)]
    fun session_expiry_max_7_days(fw: &signer, admin: &signer, alice: &signer) {
        boot(fw, admin);
        exchange::delegate_trading_with_scope(alice, @0x5E55, timestamp::now_seconds() + 8 * 86400, true, true);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, sess = @0x5E55)]
    #[expected_failure(abort_code = 18, location = papertrade::exchange)]
    fun session_expires(fw: &signer, admin: &signer, alice: &signer, sess: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        exchange::delegate_trading_with_scope(alice, @0x5E55, timestamp::now_seconds() + 60, true, true);
        timestamp::fast_forward_seconds(61);
        oracle::push_price(admin, 0, BTC_50K, timestamp::now_seconds());
        let now = timestamp::now_seconds();
        exchange::open_position_as_delegate_px(sess, @0xA11CE, 0, true, 100 * USDC, 10, BTC_50K, now, sig(&sk, 0, BTC_50K, now));
    }

    // ---- 8. SEEDS minimum hold ----
    fun lose(alice: &signer, sk: &ed25519::SecretKey, hold: u64) {
        let now = timestamp::now_seconds();
        exchange::open_position_px(alice, 0, true, 100 * USDC, 10, BTC_50K, now, sig(sk, 0, BTC_50K, now));
        let id = last(signer::address_of(alice));
        timestamp::fast_forward_seconds(hold);
        let t = timestamp::now_seconds();
        let p = BTC_50K - BTC_50K / 200; // -0.5%
        exchange::close_position_px(alice, id, p, t, sig(sk, 0, p, t));
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun no_seeds_for_quick_loss(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        lose(alice, &sk, 5);
        assert!(paper::balance_of(@0xA11CE) == 0, 0);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun seeds_after_min_hold(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        lose(alice, &sk, 61);
        assert!(paper::balance_of(@0xA11CE) > 0, 0);
    }
}
