/// 1:1 gateway between real Circle testnet USDC (arrives on Aptos via CCTP V2) and the
/// Tree Trade collateral token (test_usdc). Real USDC is locked in a keyless vault;
/// test_usdc is handed out from the vault's float first and only minted when the float
/// is empty, so `minted_backed` never exceeds locked real USDC. unwrap returns real USDC.
module papertrade::usdc_gateway {
    use std::signer;
    use std::vector;
    use aptos_std::table::{Self, Table};
    use aptos_framework::event;
    use aptos_framework::fungible_asset::Metadata;
    use aptos_framework::object::{Self, ExtendRef, Object};
    use aptos_framework::primary_fungible_store;
    use papertrade::test_usdc;
    use papertrade::exchange;

    const VAULT_SEED: vector<u8> = b"TREETRADE_USDC_GATEWAY";
    const VAULT_OWNER: address = @0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    /// Circle USDC on Aptos testnet (CCTP "Stablecoin" object).
    const CIRCLE_USDC_TESTNET: address = @0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832;

    const E_ZERO_AMOUNT: u64 = 1;
    const E_INSUFFICIENT_RESERVE: u64 = 2;

    struct Gateway has key {
        usdc: Object<Metadata>,
        vault: address,
        extend_ref: ExtendRef,
    }

    #[event]
    struct Wrapped has drop, store { user: address, amount: u64 }
    #[event]
    struct Unwrapped has drop, store { user: address, amount: u64 }

    fun init_module(deployer: &signer) {
        init_with(deployer, object::address_to_object<Metadata>(CIRCLE_USDC_TESTNET));
    }

    fun init_with(deployer: &signer, usdc: Object<Metadata>) {
        let cref = object::create_named_object(deployer, VAULT_SEED);
        let vault = object::address_from_constructor_ref(&cref);
        let extend_ref = object::generate_extend_ref(&cref);
        let transfer_ref = object::generate_transfer_ref(&cref);
        object::disable_ungated_transfer(&transfer_ref);
        object::transfer_with_ref(object::generate_linear_transfer_ref(&transfer_ref), VAULT_OWNER);
        primary_fungible_store::ensure_primary_store_exists(vault, usdc);
        primary_fungible_store::ensure_primary_store_exists(vault, test_usdc::metadata());
        move_to(deployer, Gateway { usdc, vault, extend_ref });
    }

    /// Lock `amount` real USDC, receive `amount` test_usdc.
    public entry fun wrap(user: &signer, amount: u64) acquires Gateway, Redeemable {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let g = borrow_global<Gateway>(@papertrade);
        let addr = signer::address_of(user);
        primary_fungible_store::transfer(user, g.usdc, g.vault, amount);
        let float = primary_fungible_store::balance(g.vault, test_usdc::metadata());
        let from_float = if (float >= amount) amount else float;
        if (from_float > 0) {
            let vs = object::generate_signer_for_extending(&g.extend_ref);
            primary_fungible_store::transfer(&vs, test_usdc::metadata(), addr, from_float);
        };
        if (amount > from_float) test_usdc::mint_for_gateway(addr, amount - from_float);
        if (exists<Redeemable>(@papertrade)) {
            let r = borrow_global_mut<Redeemable>(@papertrade);
            let c = table::borrow_mut_with_default(&mut r.credit, addr, 0);
            *c = *c + amount;
            r.total = r.total + (amount as u128);
        };
        event::emit(Wrapped { user: addr, amount });
    }

    /// Wrap real USDC and deposit it straight into Tree Trade as collateral.
    public entry fun wrap_and_deposit(user: &signer, amount: u64) acquires Gateway, Redeemable {
        wrap(user, amount);
        exchange::deposit(user, amount);
    }

    /// Return `amount` test_usdc, receive `amount` real USDC from the locked reserve.
    public entry fun unwrap(user: &signer, amount: u64) acquires Gateway, Redeemable {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let g = borrow_global<Gateway>(@papertrade);
        assert!(primary_fungible_store::balance(g.vault, g.usdc) >= amount, E_INSUFFICIENT_RESERVE);
        let addr = signer::address_of(user);
        // AUDIT C-1: only real USDC this address bridged in can come back out. Faucet/admin-minted
        // collateral (and winnings paid from it) is a non-redeemable testnet balance.
        if (exists<Redeemable>(@papertrade)) {
            let r = borrow_global_mut<Redeemable>(@papertrade);
            assert!(table::contains(&r.credit, addr), E_NOT_REDEEMABLE);
            let c = table::borrow_mut(&mut r.credit, addr);
            assert!(*c >= amount, E_NOT_REDEEMABLE);
            *c = *c - amount;
            if (*c == 0) { table::remove(&mut r.credit, addr); };
            r.total = r.total - (amount as u128);
        };
        primary_fungible_store::transfer(user, test_usdc::metadata(), g.vault, amount);
        let vs = object::generate_signer_for_extending(&g.extend_ref);
        primary_fungible_store::transfer(&vs, g.usdc, addr, amount);
        event::emit(Unwrapped { user: addr, amount });
    }

    #[view]
    public fun reserve(): u64 acquires Gateway {
        let g = borrow_global<Gateway>(@papertrade);
        primary_fungible_store::balance(g.vault, g.usdc)
    }

    #[view]
    public fun usdc_metadata(): address acquires Gateway {
        object::object_address(&borrow_global<Gateway>(@papertrade).usdc)
    }


    // ---------------------------------------------------------------------
    // V2 (AUDIT_2026-10-15 C-1): per-address redeemable credit.
    // ---------------------------------------------------------------------

    const E_NOT_REDEEMABLE: u64 = 3;
    const E_NOT_ADMIN: u64 = 4;
    const E_EXISTS: u64 = 5;
    const E_BAD_MIGRATION: u64 = 6;

    struct Redeemable has key { credit: Table<address, u64>, total: u128, migrated: bool }

    public entry fun init_v2(admin: &signer) {
        assert!(signer::address_of(admin) == @papertrade && exchange::admin() == @papertrade, E_NOT_ADMIN);
        assert!(!exists<Redeemable>(@papertrade), E_EXISTS);
        move_to(admin, Redeemable { credit: table::new(), total: 0, migrated: false });
    }

    /// One-time: credit pre-V2 wrappers with their net wrapped amount (from Wrapped/Unwrapped events).
    /// Total credit can never exceed the locked reserve.
    public entry fun migrate_credit(admin: &signer, users: vector<address>, amounts: vector<u64>) acquires Gateway, Redeemable {
        assert!(signer::address_of(admin) == @papertrade && exchange::admin() == @papertrade, E_NOT_ADMIN);
        let r = borrow_global_mut<Redeemable>(@papertrade);
        assert!(!r.migrated && vector::length(&users) == vector::length(&amounts), E_BAD_MIGRATION);
        let i = 0;
        while (i < vector::length(&users)) {
            let a = *vector::borrow(&amounts, i);
            let c = table::borrow_mut_with_default(&mut r.credit, *vector::borrow(&users, i), 0);
            *c = *c + a;
            r.total = r.total + (a as u128);
            i = i + 1;
        };
        let g = borrow_global<Gateway>(@papertrade);
        assert!(r.total <= (primary_fungible_store::balance(g.vault, g.usdc) as u128), E_BAD_MIGRATION);
        r.migrated = true;
    }

    #[view]
    public fun redeemable_of(user: address): u64 acquires Redeemable {
        if (!exists<Redeemable>(@papertrade)) return 0;
        let r = borrow_global<Redeemable>(@papertrade);
        if (table::contains(&r.credit, user)) *table::borrow(&r.credit, user) else 0
    }

    #[view]
    public fun total_redeemable(): u128 acquires Redeemable {
        if (!exists<Redeemable>(@papertrade)) 0 else borrow_global<Redeemable>(@papertrade).total
    }

    #[test_only]
    public fun init_for_test(deployer: &signer, usdc: Object<Metadata>) { init_with(deployer, usdc); }
}
