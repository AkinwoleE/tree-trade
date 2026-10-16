#[test_only]
module papertrade::hedge_delegate_tests {
    use std::option;
    use std::signer;
    use std::vector;
    use aptos_framework::object;
    use aptos_framework::timestamp;
    use papertrade::exchange;
    use papertrade::hedge;
    use papertrade::tests;

    const USDC: u64 = 1_000_000;

    fun sub_of(owner: address): address {
        let cref = object::create_object(owner);
        object::address_from_constructor_ref(&cref)
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, sess = @0x5E55)]
    fun session_key_opens_hedged(fw: &signer, admin: &signer, alice: &signer, sess: &signer) {
        tests::setup_for(fw, admin);
        tests::seed_pool_for(admin, 100_000 * USDC);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let a = signer::address_of(alice);
        let sub = sub_of(a);
        exchange::delegate_trading_to(alice, @0x5E55, option::some(timestamp::now_seconds() + 3600));
        hedge::open_position_hedged_as_delegate(sess, a, 0, true, 100 * USDC, 10, sub);
        let ids = exchange::user_positions(a);
        let id = *vector::borrow(&ids, vector::length(&ids) - 1);
        let (exists, owner, s, _) = hedge::request_of(id);
        assert!(exists && owner == a && s == sub, 0);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, sess = @0x5E55)]
    #[expected_failure(abort_code = 17, location = papertrade::exchange)]
    fun stranger_cannot_open_hedged(fw: &signer, admin: &signer, alice: &signer, sess: &signer) {
        tests::setup_for(fw, admin);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let a = signer::address_of(alice);
        hedge::open_position_hedged_as_delegate(sess, a, 0, true, 100 * USDC, 10, sub_of(a));
    }

    // A delegate cannot point the hedge at a Trading Account the owner does not own.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, sess = @0x5E55)]
    #[expected_failure(abort_code = 2, location = papertrade::hedge)]
    fun delegate_cannot_use_foreign_subaccount(fw: &signer, admin: &signer, alice: &signer, sess: &signer) {
        tests::setup_for(fw, admin);
        tests::seed_pool_for(admin, 100_000 * USDC);
        tests::fund_trader_for(alice, 1_000 * USDC);
        let a = signer::address_of(alice);
        exchange::delegate_trading_to(alice, @0x5E55, option::some(timestamp::now_seconds() + 3600));
        hedge::open_position_hedged_as_delegate(sess, a, 0, true, 100 * USDC, 10, sub_of(@0x5E55));
    }
}
