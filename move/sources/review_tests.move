#[test_only]
/// Regression / PoC tests from REVIEW_2026-10-15 and AUDIT_2026-10-15.
module papertrade::review_tests {
    use std::vector;
    use aptos_framework::timestamp;
    use papertrade::exchange;
    use papertrade::oracle;
    use papertrade::tests;

    const USDC: u64 = 1_000_000;
    const BTC: u8 = 0;
    const E50K: u64 = 5_000_000_000_000;

    fun btc(admin: &signer, p: u64) { oracle::push_price(admin, BTC, p, timestamp::now_seconds()); }
    fun last(user: address): u64 { let ids = exchange::user_positions(user); *vector::borrow(&ids, vector::length(&ids) - 1) }
    fun check_inv() {
        let (vault, bal, margin, pool, dev) = exchange::accounting();
        assert!((vault as u128) == (bal as u128) + (margin as u128) + (pool as u128) + (dev as u128), 900);
    }

    /// A-1 PoC: the oracle accepts trades on a price up to max_staleness (60s) old. A trader who sees the
    /// off-chain price already 0.1% higher opens 1000x long on the stale on-chain price and closes after
    /// the next push: ~+80% of margin, risk-free. Documents the exposure (needs decision, see audit).
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun stale_price_latency_arb(fw: &signer, admin: &signer, alice: &signer) {
        tests::setup_for(fw, admin);
        tests::seed_pool_for(admin, 100_000 * USDC);
        exchange::init_v2(admin);
        exchange::init_v3(admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let before = exchange::balance_of(@0xA11CE);
        timestamp::fast_forward_seconds(50); // on-chain price is 50s old but still "fresh"
        exchange::open_position(alice, BTC, true, 100 * USDC, 1000);
        btc(admin, E50K + E50K / 1000); // keeper catches up (+0.1%)
        exchange::close_position(alice, last(@0xA11CE));
        let after = exchange::balance_of(@0xA11CE);
        assert!(after > before + 70 * USDC, 1);
        check_inv();
    }

    /// Accounting invariant holds through queue, debt-funded opens, liquidation and fees.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    fun invariant_through_queue_and_debt(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        tests::setup_for(fw, admin);
        tests::seed_pool_for(admin, 1_000 * USDC);
        exchange::init_v2(admin);
        exchange::init_v3(admin);
        tests::fund_trader_for(alice, 5_000 * USDC);
        tests::fund_trader_for(bob, 5_000 * USDC);
        exchange::open_position(alice, BTC, true, 1_000 * USDC, 100);
        btc(admin, E50K + E50K / 20); // +5%: big win, pool can't cover -> queue
        exchange::close_position(alice, last(@0xA11CE));
        check_inv();
        let (h, t, owed) = exchange::queue_state();
        assert!(t > h && owed > 0, 2);
        // Alice re-uses queued winnings as margin; bob loses into the pool.
        exchange::open_position_from_queue(alice, BTC, false, 100 * USDC, 10);
        check_inv();
        exchange::open_position(bob, BTC, false, 1_000 * USDC, 10);
        btc(admin, E50K + E50K / 10);
        exchange::close_position(bob, last(@0xB0B));
        check_inv();
        // Debt-funded short goes bust and is liquidated.
        btc(admin, E50K * 2);
        exchange::liquidate(bob, last(@0xA11CE));
        check_inv();
        exchange::process_queue(bob, 50);
        check_inv();
    }

    /// M-11 (Claude Code): an entry emptied by open_position_from_queue behind the head stays after the head
    /// entry is paid off with pool == 0, so the queue looks active (fees waived, sweeps blocked) with nothing owed.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B, carol = @0xCA401)]
    fun emptied_entry_behind_head_is_skipped(fw: &signer, admin: &signer, alice: &signer, bob: &signer, carol: &signer) {
        tests::setup_for(fw, admin);
        exchange::init_v2(admin);
        exchange::init_v3(admin);
        tests::fund_trader_for(alice, 5_000 * USDC);
        tests::fund_trader_for(bob, 5_000 * USDC);
        tests::fund_trader_for(carol, 5_000 * USDC);
        // Pool is empty: both winners are fully queued (A = alice, B = bob).
        exchange::open_position(alice, BTC, true, 100 * USDC, 100);
        exchange::open_position(bob, BTC, true, 100 * USDC, 100);
        btc(admin, E50K + E50K / 100);
        exchange::close_position(alice, last(@0xA11CE));
        exchange::close_position(bob, last(@0xB0B));
        btc(admin, E50K);
        let (h, _, _) = exchange::queue_state();
        let (_, _, _, rem_a) = exchange::queue_entry(h);
        let (_, _, _, rem_b) = exchange::queue_entry(h + 1);
        // Bob turns his whole claim into margin: entry B (not head) drops to 0.
        exchange::open_position_from_queue(bob, BTC, true, rem_b, 100);
        // Carol loses exactly A's remaining via liquidation (fee waived while queued): pool ends at 0.
        exchange::open_position(carol, BTC, false, rem_a, 100);
        btc(admin, E50K + E50K / 50);
        exchange::liquidate(admin, last(@0xCA401));
        let (h2, t2, owed) = exchange::queue_state();
        assert!(owed == 0, 10);
        assert!(h2 == t2, 11); // fails before the fix: head stuck on emptied entry B
        check_inv();
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 28, location = papertrade::exchange)]
    fun impact_params_zero_multiplier_rejected(fw: &signer, admin: &signer) {
        tests::setup_for(fw, admin);
        exchange::init_v2(admin);
        let k = vector::empty<u64>(); vector::push_back(&mut k, 0); vector::push_back(&mut k, 483_979);
        exchange::set_impact_params(admin, 1000, 15_000, 100_000, k);
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 34, location = papertrade::exchange)]
    fun bust_buffer_above_one_over_leverage_rejected(fw: &signer, admin: &signer) {
        tests::setup_for(fw, admin);
        exchange::init_v2(admin);
        exchange::init_v3(admin);
        let b = vector::empty<u128>(); vector::push_back(&mut b, 1_000_000_000_000_000); vector::push_back(&mut b, 1); // 0.1%
        exchange::set_bust_buffers(admin, b);
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 2, location = papertrade::tokenomics)]
    fun tail_progress_bounded(fw: &signer, admin: &signer) {
        tests::setup_for(fw, admin);
        papertrade::tokenomics::raise_tail_progress(admin, 340282366920938463463374607431768211455);
    }
}
