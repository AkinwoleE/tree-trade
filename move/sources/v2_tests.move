#[test_only]
/// One test per Paper Trade rule implemented by exchange V2 (see PARITY.md / LP_QUEUE.md).
module papertrade::v2_tests {
    use std::signer;
    use std::vector;
    use papertrade::exchange;
    use papertrade::oracle;
    use papertrade::paper;
    use papertrade::test_usdc;
    use papertrade::tests;

    const USDC: u64 = 1_000_000;
    const BTC: u8 = 0;
    const E50K: u64 = 5_000_000_000_000;

    fun btc(admin: &signer, p: u64) { oracle::push_price(admin, BTC, p, aptos_framework::timestamp::now_seconds()); }
    fun last(user: address): u64 { let ids = exchange::user_positions(user); *vector::borrow(&ids, vector::length(&ids) - 1) }
    fun inv() {
        let (vault, b, m, pool, dev) = exchange::accounting();
        assert!(vault == b + m + pool + dev, 900);
    }

    // Rule: LP can't be deposited into once V2 is active.
    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 22, location = papertrade::exchange)]
    fun no_lp_deposits(fw: &signer, admin: &signer) {
        tests::setup_for(fw, admin);
        exchange::init_v2(admin);
        tests::seed_pool_for(admin, 10 * USDC);
    }

    // Rule: the bootstrap donation can be removed (only up to the recorded 50k, queue empty).
    #[test(fw = @aptos_framework, admin = @papertrade)]
    fun remove_seed(fw: &signer, admin: &signer) {
        tests::setup_for(fw, admin);
        tests::seed_pool_for(admin, 60_000 * USDC);
        exchange::init_v2(admin);
        exchange::remove_pool_seed(admin, 50_000 * USDC);
        assert!(exchange::pool_balance() == 10_000 * USDC, 0);
        assert!(test_usdc::balance(@papertrade) == 50_000 * USDC, 1);
        inv();
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 26, location = papertrade::exchange)]
    fun remove_seed_capped(fw: &signer, admin: &signer) {
        tests::setup_for(fw, admin);
        tests::seed_pool_for(admin, 60_000 * USDC);
        exchange::init_v2(admin);
        exchange::remove_pool_seed(admin, 50_000 * USDC + 1);
    }

    // Rule: asymmetric impact. BTC keeps ~88.1% of a 1% move, ~73.9% of a 0.1% move,
    // a move inside the 0.2 bps deadband pays 0 (margin back, no fee, no SEEDS).
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun asymmetric_impact(fw: &signer, admin: &signer, alice: &signer) {
        tests::setup_for(fw, admin);
        tests::seed_pool_for(admin, 10_000 * USDC);
        exchange::init_v2(admin);
        tests::fund_trader_for(alice, 3_000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10); // notional 1000
        btc(admin, E50K * 101 / 100);
        let (adj, fee) = exchange::quote_close(last(@0xA11CE));
        assert!(adj == 8_814_691 && fee == 176_294, 0); // 88.15% of raw 10 USDC
        exchange::close_position(alice, last(@0xA11CE));
        assert!(exchange::balance_of(@0xA11CE) == 3_000 * USDC + adj - fee, 1);
        btc(admin, E50K);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        btc(admin, E50K * 1001 / 1000);
        let (adj2, _) = exchange::quote_close(last(@0xA11CE));
        assert!(adj2 == 739_131, 2); // 73.9% of raw 1 USDC
        exchange::close_position(alice, last(@0xA11CE));
        // deadband: +0.2 bps exactly
        btc(admin, E50K);
        let before = exchange::balance_of(@0xA11CE);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        btc(admin, E50K + E50K / 50_000);
        exchange::close_position(alice, last(@0xA11CE));
        assert!(exchange::balance_of(@0xA11CE) == before, 3);
        inv();
    }

    // Rules: winner paid min(LP cash, owed), rest queued FIFO, fee waived when not fully
    // paid; new winners never paid ahead of the queue; later losses pay the queue FIFO
    // before the LP; loss fee waived while queued; SEEDS on the full loss; queue position.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B, carol = @0xCA401, dave = @0xDA7E)]
    fun partial_payout_queue_fifo(fw: &signer, admin: &signer, alice: &signer, bob: &signer, carol: &signer, dave: &signer) {
        tests::setup_for(fw, admin);
        exchange::init_v2(admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        tests::fund_trader_for(bob, 100 * USDC);
        tests::fund_trader_for(carol, 200 * USDC);
        tests::fund_trader_for(dave, 1_000 * USDC);
        exchange::open_position(bob, BTC, false, 100 * USDC, 10);
        exchange::open_position(alice, BTC, true, 1_000 * USDC, 10);
        exchange::open_position(carol, BTC, true, 200 * USDC, 10);
        btc(admin, E50K * 105 / 100);
        exchange::close_position(bob, 1);                  // loss 50, fee 1 -> LP 49
        assert!(exchange::pool_balance() == 49 * USDC, 0);
        exchange::close_position(alice, 2);                // net 439.159165: 49 now, rest queued
        assert!(exchange::balance_of(@0xA11CE) == 1_049 * USDC, 1);
        assert!(exchange::pool_balance() == 0, 2);
        let (h, t, owed) = exchange::queue_state();
        assert!(h == 0 && t == 1 && owed == 390_159_165, 3);
        let (_, dev_before) = exchange::fee_stats();
        exchange::close_position(carol, 3);                // queue active -> all queued
        assert!(exchange::balance_of(@0xCA401) == 200 * USDC, 4);
        let (_, _, owed2) = exchange::queue_state();
        assert!(owed2 == 390_159_165 + 87_831_832, 5);
        let (_, dev_after) = exchange::fee_stats();
        assert!(dev_after == dev_before, 6);               // win fees never paid ahead of queue
        let (q, idx, ahead, n) = exchange::queued_balance_of(@0xCA401);
        assert!(q == 87_831_832 && idx == 1 && ahead == 390_159_165 && n == 1, 7);
        let (lp, neg, _) = exchange::seeds_rate();
        assert!(neg && lp == 477_990_997, 8);              // tracked LP = pool - queue
        // dave loses 400 (-4%) while queued: fee waived, 400 pays alice first, then carol.
        btc(admin, E50K * 105 / 100);
        exchange::open_position(dave, BTC, true, 1_000 * USDC, 10);
        btc(admin, 5_040_000_000_000);
        exchange::close_position(dave, 4);
        assert!(exchange::balance_of(@0xA11CE) == 1_049 * USDC + 390_159_165, 9);
        assert!(exchange::balance_of(@0xCA401) == 200 * USDC + 9_840_835, 10);
        let (h2, _, owed3) = exchange::queue_state();
        assert!(h2 == 1 && owed3 == 77_991_000 - 3, 11);
        let (_, dev_end) = exchange::fee_stats();
        assert!(dev_end == dev_before, 12);                // loss fee waived
        assert!(paper::balance_of(@0xDA7E) == 400 * USDC * 100, 13); // full-loss basis
        inv();
    }

    // Rule: liquidation fee waived while the queue is active (USD-funded).
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    fun liq_fee_waived_when_queued(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        tests::setup_for(fw, admin);
        exchange::init_v2(admin);
        tests::fund_trader_for(alice, 100 * USDC);
        tests::fund_trader_for(bob, 100 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        exchange::open_position(bob, BTC, false, 100 * USDC, 100);
        btc(admin, E50K * 105 / 100);
        exchange::close_position(alice, 1);    // all queued (LP 0)
        exchange::liquidate(alice, 2);         // 100 in, no fee
        let (_, dev) = exchange::fee_stats();
        assert!(dev == 0, 0);
        assert!(exchange::balance_of(@0xA11CE) == 100 * USDC + 43_915_915, 1);
        assert!(exchange::pool_balance() == 100 * USDC - 43_915_915, 2);
        assert!(paper::balance_of(@0xB0B) == 100 * USDC * 100, 3);
        inv();
    }

    // Rule: 2% fee split half stakers (USDC) / half dev when queue empty and LP covers it.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, st = @0x57A)]
    fun fee_split_when_solvent(fw: &signer, admin: &signer, alice: &signer, st: &signer) {
        tests::setup_for(fw, admin);
        tests::seed_pool_for(admin, 1_000 * USDC);
        exchange::init_v2(admin);
        paper::mint_for_test(signer::address_of(st), 1_000);
        paper::stake(st, 1_000);
        tests::fund_trader_for(alice, 100 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        btc(admin, E50K * 105 / 100);
        exchange::close_position(alice, 1);
        let (to_st, to_dev) = exchange::fee_stats();
        assert!(to_st == 448_122 && to_dev == 448_122, 0); // fee 896_244
        assert!(exchange::pool_balance() == 1_000 * USDC - 44_812_159, 1);
        inv();
    }

    // Rule: queued balance can be used as margin (debt-funded). A liquidation destroys
    // the claim, charges no fee and mints SEEDS on the full margin; tracked LP counts the
    // consumed claim as still owed until it settles.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun debt_funded_liquidation(fw: &signer, admin: &signer, alice: &signer) {
        tests::setup_for(fw, admin);
        exchange::init_v2(admin);
        tests::fund_trader_for(alice, 100 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        btc(admin, E50K * 105 / 100);
        exchange::close_position(alice, 1);           // queued 43.915915
        let (lp0, neg0, _) = exchange::seeds_rate();
        exchange::open_position_from_queue(alice, BTC, true, 20 * USDC, 100);
        let id = last(@0xA11CE);
        assert!(exchange::is_debt_position(id), 0);
        let (q, _, _, _) = exchange::queued_balance_of(@0xA11CE);
        assert!(q == 23_915_915, 1);
        let (lp1, neg1, _) = exchange::seeds_rate();
        assert!(lp1 == lp0 && neg1 == neg0, 2);        // contingent claim still owed
        assert!(exchange::balance_of(@0xA11CE) == 100 * USDC, 3); // cash untouched
        btc(admin, E50K * 105 / 100 * 98 / 100);
        exchange::liquidate(alice, id);
        let (_, dev) = exchange::fee_stats();
        assert!(dev == 0, 4);
        assert!(paper::balance_of(@0xA11CE) == 20 * USDC * 100, 5);
        let (_, _, owed) = exchange::queue_state();
        assert!(owed == 23_915_915, 6);
        let (lp2, neg2, _) = exchange::seeds_rate();
        assert!(neg2 && lp2 == 23_915_915, 7);
        inv();
    }

    // Debt-funded win while the queue is active: whole surviving claim (margin + net)
    // is re-queued; fee waived.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun debt_funded_win_requeued(fw: &signer, admin: &signer, alice: &signer) {
        tests::setup_for(fw, admin);
        exchange::init_v2(admin);
        tests::fund_trader_for(alice, 100 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        btc(admin, E50K * 105 / 100);
        exchange::close_position(alice, 1);           // queued 43.915915 (entry 0)
        exchange::open_position_from_queue(alice, BTC, true, 40 * USDC, 10);
        let id = last(@0xA11CE);
        btc(admin, E50K * 105 / 100 * 101 / 100);
        let (adj, fee) = exchange::quote_close(id);
        exchange::close_position(alice, id);
        let (q, _, _, n) = exchange::queued_balance_of(@0xA11CE);
        assert!(q == 3_915_915 + 40 * USDC + adj - fee && n == 2, 0);
        let (_, dev) = exchange::fee_stats();
        assert!(dev == 0, 1);
        inv();
    }

    // Debt-funded loss with an empty queue and enough LP cash: surviving claim paid now,
    // fee paid from free LP cash.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    fun debt_funded_loss_paid(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        tests::setup_for(fw, admin);
        exchange::init_v2(admin);
        tests::fund_trader_for(alice, 100 * USDC);
        tests::fund_trader_for(bob, 1_000 * USDC);
        exchange::open_position(alice, BTC, true, 100 * USDC, 10);
        btc(admin, E50K * 105 / 100);
        exchange::close_position(alice, 1);           // queued 43.915915
        exchange::open_position_from_queue(alice, BTC, true, 40 * USDC, 10); // id 2, notional 400
        exchange::open_position(bob, BTC, true, 1_000 * USDC, 10);           // id 3
        btc(admin, E50K * 105 / 100 * 99 / 100);      // -1%
        exchange::close_position(bob, 3);             // loss 100, queue active: pays alice's 3.915915
        let (_, _, owed) = exchange::queue_state();
        assert!(owed == 0, 0);
        let pool = exchange::pool_balance();
        assert!(pool == 100 * USDC - 3_915_915, 1);
        let bal = exchange::balance_of(@0xA11CE);
        exchange::close_position(alice, 2);           // loss 4 -> surviving 36 paid, fee 0.08
        assert!(exchange::balance_of(@0xA11CE) == bal + 36 * USDC, 2);
        assert!(exchange::pool_balance() == pool - 36 * USDC - 80_000, 3);
        let (_, dev) = exchange::fee_stats();
        assert!(dev == 80_000 + 0, 4);                // no stakers -> all to dev
        assert!(paper::balance_of(@0xA11CE) == (4 * USDC - 80_000) * 100, 5);
        inv();
    }
}
