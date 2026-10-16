#[test_only]
module papertrade::gateway_tests {
    use std::option;
    use std::signer;
    use std::string::utf8;
    use aptos_framework::fungible_asset::{Self, MintRef, Metadata};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;
    use papertrade::exchange;
    use papertrade::hedge;
    use papertrade::oracle;
    use papertrade::paper;
    use papertrade::test_usdc;
    use papertrade::usdc_gateway;

    fun setup(fw: &signer, admin: &signer): (Object<Metadata>, MintRef) {
        timestamp::set_time_has_started_for_testing(fw);
        timestamp::update_global_time_for_test_secs(1_000_000);
        test_usdc::init_for_test(admin);
        oracle::init_for_test(admin);
        paper::init_for_test(admin);
        exchange::init_for_test(admin);
        hedge::init_for_test(admin);
        let cref = object::create_named_object(admin, b"FAKE_CIRCLE");
        primary_fungible_store::create_primary_store_enabled_fungible_asset(
            &cref, option::none(), utf8(b"USDC"), utf8(b"USDC"), 6, utf8(b""), utf8(b""));
        let md = object::object_from_constructor_ref<Metadata>(&cref);
        let mint = fungible_asset::generate_mint_ref(&cref);
        usdc_gateway::init_for_test(admin, md);
        (md, mint)
    }

    #[test(fw = @aptos_framework, admin = @papertrade, user = @0xB0B)]
    fun wrap_unwrap_roundtrip(fw: &signer, admin: &signer, user: &signer) {
        let (md, mint) = setup(fw, admin);
        let u = signer::address_of(user);
        primary_fungible_store::mint(&mint, u, 100_000_000);
        usdc_gateway::wrap(user, 40_000_000);
        assert!(test_usdc::balance(u) == 40_000_000, 0);
        assert!(primary_fungible_store::balance(u, md) == 60_000_000, 1);
        assert!(usdc_gateway::reserve() == 40_000_000, 2);
        usdc_gateway::unwrap(user, 15_000_000);
        assert!(usdc_gateway::reserve() == 25_000_000, 3);
        assert!(primary_fungible_store::balance(u, md) == 75_000_000, 4);
        // float reused before minting
        usdc_gateway::wrap(user, 10_000_000);
        assert!(test_usdc::balance(u) == 35_000_000, 5);
        usdc_gateway::wrap_and_deposit(user, 20_000_000);
        assert!(exchange::balance_of(u) == 20_000_000, 6);
        assert!(test_usdc::balance(u) == 35_000_000, 7);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, user = @0xB0B)]
    #[expected_failure(abort_code = 2, location = papertrade::usdc_gateway)]
    fun unwrap_cannot_exceed_reserve(fw: &signer, admin: &signer, user: &signer) {
        let (_md, _mint) = setup(fw, admin);
        test_usdc::mint_for_test(signer::address_of(user), 5_000_000);
        usdc_gateway::unwrap(user, 1);
    }

    /// AUDIT C-1 PoC: faucet tUSDC (unbacked) redeems the real USDC another user locked.
    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, mallory = @0xBAD)]
    #[expected_failure(abort_code = 3, location = papertrade::usdc_gateway)]
    fun poc_faucet_tusdc_drains_reserve(fw: &signer, admin: &signer, alice: &signer, mallory: &signer) {
        let (md, mint) = setup(fw, admin);
        usdc_gateway::init_v2(admin);
        primary_fungible_store::mint(&mint, @0xA11CE, 10_000_000_000);
        usdc_gateway::wrap(alice, 10_000_000_000);           // alice locks 10,000 real USDC
        test_usdc::faucet(mallory);                           // mallory gets 10,000 free tUSDC
        usdc_gateway::unwrap(mallory, 10_000_000_000);        // ...and redeems alice's real USDC
        assert!(primary_fungible_store::balance(@0xBAD, md) == 10_000_000_000, 0);
        assert!(usdc_gateway::reserve() == 0, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun v2_wrapper_can_redeem_own(fw: &signer, admin: &signer, alice: &signer) {
        let (_md, mint) = setup(fw, admin);
        usdc_gateway::init_v2(admin);
        primary_fungible_store::mint(&mint, @0xA11CE, 5_000_000);
        usdc_gateway::wrap(alice, 5_000_000);
        assert!(usdc_gateway::redeemable_of(@0xA11CE) == 5_000_000, 0);
        usdc_gateway::unwrap(alice, 2_000_000);
        assert!(usdc_gateway::redeemable_of(@0xA11CE) == 3_000_000, 1);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE, bob = @0xB0B)]
    #[expected_failure(abort_code = 3, location = papertrade::usdc_gateway)]
    fun v2_cannot_redeem_more_than_wrapped(fw: &signer, admin: &signer, alice: &signer, bob: &signer) {
        let (_md, mint) = setup(fw, admin);
        usdc_gateway::init_v2(admin);
        primary_fungible_store::mint(&mint, @0xB0B, 5_000_000);
        usdc_gateway::wrap(bob, 5_000_000);
        primary_fungible_store::mint(&mint, @0xA11CE, 5_000_000);
        usdc_gateway::wrap(alice, 5_000_000);
        test_usdc::faucet(alice);
        usdc_gateway::unwrap(alice, 5_000_001);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun v2_migration_credits_prior_wrappers(fw: &signer, admin: &signer, alice: &signer) {
        let (_md, mint) = setup(fw, admin);
        primary_fungible_store::mint(&mint, @0xA11CE, 5_000_000);
        usdc_gateway::wrap(alice, 5_000_000);
        usdc_gateway::init_v2(admin);
        usdc_gateway::migrate_credit(admin, vector[@0xA11CE], vector[5_000_000]);
        usdc_gateway::unwrap(alice, 5_000_000);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 6, location = papertrade::usdc_gateway)]
    fun v2_migration_bounded_by_reserve(fw: &signer, admin: &signer, alice: &signer) {
        let (_md, mint) = setup(fw, admin);
        primary_fungible_store::mint(&mint, @0xA11CE, 5_000_000);
        usdc_gateway::wrap(alice, 5_000_000);
        usdc_gateway::init_v2(admin);
        usdc_gateway::migrate_credit(admin, vector[@0xA11CE], vector[5_000_001]);
    }
}
