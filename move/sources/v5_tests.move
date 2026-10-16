#[test_only]
/// Batched keeper view `exchange::open_positions` (usage reduction, 2026-10-16).
module papertrade::v5_tests {
    use std::vector;
    use aptos_std::ed25519;
    use aptos_framework::timestamp;
    use papertrade::exchange;
    use papertrade::hedge;
    use papertrade::oracle;
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

    fun open(sk: &ed25519::SecretKey, who: &signer, long: bool, lev: u64): u64 {
        let now = timestamp::now_seconds();
        exchange::open_position_px(who, 0, long, 100 * USDC, lev, BTC_50K, now, sig(sk, 0, BTC_50K, now));
        let ids = exchange::user_positions(std::signer::address_of(who));
        *vector::borrow(&ids, vector::length(&ids) - 1)
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    fun lists_open_positions_with_liq_price(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 10_000 * USDC);
        tests::fund_trader_for(bob, 10_000 * USDC);
        let a = open(&sk, alice, true, 100);
        let b = open(&sk, bob, false, 1000);
        let c = open(&sk, alice, true, 10);
        // close b
        timestamp::fast_forward_seconds(1);
        let now = timestamp::now_seconds();
        exchange::close_position_px(bob, b, BTC_50K, now, sig(&sk, 0, BTC_50K, now));

        let (ids, owners, _m, longs, _mg, levs, _n, entries, _o, liqs, next, total) = exchange::open_positions(0, 1000);
        assert!(ids == vector[a, c], 0);
        assert!(owners == vector[@0xA11CE, @0xA11CE], 1);
        assert!(longs == vector[true, true] && levs == vector[100, 10], 2);
        assert!(*vector::borrow(&entries, 0) == BTC_50K, 3);
        assert!(*vector::borrow(&liqs, 0) == exchange::liquidation_price(a), 4);
        assert!(*vector::borrow(&liqs, 1) == exchange::liquidation_price(c), 5);
        assert!(next == total && total == c + 1, 6);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun paginates_by_id_budget(fw: &signer, admin: &signer, alice: &signer) {
        let sk = boot(fw, admin);
        tests::fund_trader_for(alice, 10_000 * USDC);
        let a = open(&sk, alice, true, 10);
        let b = open(&sk, alice, true, 10);
        let c = open(&sk, alice, false, 10);
        let (ids, _, _, _, _, _, _, _, _, _, next, total) = exchange::open_positions(a, 2);
        assert!(ids == vector[a, b] && next == a + 2 && total == c + 1, 0);
        let (ids2, _, _, _, _, _, _, _, _, _, next2, _) = exchange::open_positions(next, 2);
        assert!(ids2 == vector[c] && next2 == c + 1, 1);
        // start past the end: empty, cursor unchanged
        let (ids3, _, _, _, _, _, _, _, _, _, next3, _) = exchange::open_positions(total + 5, 10);
        assert!(vector::is_empty(&ids3) && next3 == total + 5, 2);
    }
}
