#[test_only]
module papertrade::delegation_tests {
    use std::option;
    use std::signer;
    use std::vector;
    use aptos_framework::timestamp;
    use papertrade::exchange;
    use papertrade::oracle;
    use papertrade::tests;

    const USDC: u64 = 1_000_000;

    fun last(u: address): u64 { let ids = exchange::user_positions(u); *vector::borrow(&ids, vector::length(&ids) - 1) }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, sess = @0x5E55)]
    fun delegate_opens_and_closes_for_owner(fw: &signer, admin: &signer, alice: &signer, sess: &signer) {
        tests::setup_for(fw, admin);
        tests::seed_pool_for(admin, 100_000 * USDC);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let a = signer::address_of(alice);
        exchange::delegate_trading_to(alice, @0x5E55, option::some(timestamp::now_seconds() + 3600));
        let (ok, _) = exchange::delegation_of(a, @0x5E55);
        assert!(ok, 0);
        exchange::open_position_as_delegate(sess, a, 0, true, 100 * USDC, 10);
        let id = last(a);
        assert!(exchange::balance_of(a) == 900 * USDC, 1);
        assert!(vector::is_empty(&exchange::user_positions(@0x5E55)), 2);
        exchange::close_position_as_delegate(sess, a, id);
        assert!(exchange::balance_of(a) == 1_000 * USDC, 3);
        assert!(exchange::balance_of(@0x5E55) == 0, 4);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, sess = @0x5E55)]
    #[expected_failure(abort_code = 17, location = papertrade::exchange)]
    fun stranger_cannot_trade(fw: &signer, admin: &signer, alice: &signer, sess: &signer) {
        tests::setup_for(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        exchange::open_position_as_delegate(sess, signer::address_of(alice), 0, true, 100 * USDC, 10);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, sess = @0x5E55)]
    #[expected_failure(abort_code = 18, location = papertrade::exchange)]
    fun expired_delegate_fails(fw: &signer, admin: &signer, alice: &signer, sess: &signer) {
        tests::setup_for(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        exchange::delegate_trading_to(alice, @0x5E55, option::some(timestamp::now_seconds() + 60));
        timestamp::fast_forward_seconds(61);
        oracle::push_prices(admin, 5_000_000_000_000, 300_000_000_000, timestamp::now_seconds());
        exchange::open_position_as_delegate(sess, signer::address_of(alice), 0, true, 100 * USDC, 10);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, sess = @0x5E55)]
    #[expected_failure(abort_code = 17, location = papertrade::exchange)]
    fun revoked_delegate_fails(fw: &signer, admin: &signer, alice: &signer, sess: &signer) {
        tests::setup_for(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        exchange::delegate_trading_to(alice, @0x5E55, option::some(timestamp::now_seconds() + 3600));
        exchange::revoke_delegation(alice, @0x5E55);
        exchange::open_position_as_delegate(sess, signer::address_of(alice), 0, true, 100 * USDC, 10);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, sess = @0x5E55)]
    #[expected_failure(abort_code = 17, location = papertrade::exchange)]
    fun revoke_all_works(fw: &signer, admin: &signer, alice: &signer, sess: &signer) {
        tests::setup_for(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        exchange::delegate_trading_to(alice, @0x5E55, option::some(timestamp::now_seconds() + 3600));
        exchange::revoke_all_delegations(alice);
        exchange::open_position_as_delegate(sess, signer::address_of(alice), 0, true, 100 * USDC, 10);
    }

    /// Withdraw is keyed on the signer: the delegate can only withdraw its own (zero) balance.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, sess = @0x5E55)]
    #[expected_failure(abort_code = 3, location = papertrade::exchange)]
    fun delegate_cannot_withdraw(fw: &signer, admin: &signer, alice: &signer, sess: &signer) {
        tests::setup_for(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        exchange::delegate_trading_to(alice, @0x5E55, option::some(timestamp::now_seconds() + 3600));
        exchange::withdraw(sess, 1 * USDC);
    }

    /// Delegate of alice cannot close bob's position.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B, sess = @0x5E55)]
    #[expected_failure(abort_code = 9, location = papertrade::exchange)]
    fun delegate_cannot_close_other_users_position(fw: &signer, admin: &signer, alice: &signer, bob: &signer, sess: &signer) {
        tests::setup_for(fw, admin);
        tests::fund_trader_for(bob, 1_000 * USDC);
        exchange::open_position(bob, 0, true, 100 * USDC, 10);
        let id = last(@0xB0B);
        exchange::delegate_trading_to(alice, @0x5E55, option::some(timestamp::now_seconds() + 3600));
        exchange::close_position_as_delegate(sess, signer::address_of(alice), id);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 20, location = papertrade::exchange)]
    fun past_expiry_rejected(fw: &signer, admin: &signer, alice: &signer) {
        tests::setup_for(fw, admin);
        exchange::delegate_trading_to(alice, @0x5E55, option::some(timestamp::now_seconds()));
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 21, location = papertrade::exchange)]
    fun self_delegate_rejected(fw: &signer, admin: &signer, alice: &signer) {
        tests::setup_for(fw, admin);
        exchange::delegate_trading_to(alice, @0xA11CE, option::some(timestamp::now_seconds() + 3600));
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun redelegate_updates_and_prunes(fw: &signer, admin: &signer, alice: &signer) {
        tests::setup_for(fw, admin);
        let now = timestamp::now_seconds();
        exchange::delegate_trading_to(alice, @0x1001, option::some(now + 10));
        exchange::delegate_trading_to(alice, @0x1002, option::some(timestamp::now_seconds() + 3600));
        exchange::delegate_trading_to(alice, @0x1002, option::some(now + 500));
        let (ds, es) = exchange::delegates_of(@0xA11CE);
        assert!(vector::length(&ds) == 2 && *vector::borrow(&es, 1) == now + 500, 0);
        timestamp::fast_forward_seconds(20);
        exchange::delegate_trading_to(alice, @0x1003, option::some(timestamp::now_seconds() + 3600));
        let (ds2, _) = exchange::delegates_of(@0xA11CE);
        assert!(vector::length(&ds2) == 2, 1); // 0x1001 pruned
        let (ok, _) = exchange::delegation_of(@0xA11CE, @0x1001);
        assert!(!ok, 2);
    }
}
