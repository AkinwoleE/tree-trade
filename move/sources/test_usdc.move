/// Mock "test USDC" fungible asset (6 decimals) used as collateral by the papertrade
/// casino. Anyone can claim a fixed amount from the rate-limited faucet; the admin can
/// mint arbitrary amounts. It is a plain (non-dispatchable) fungible asset, so transfers
/// cannot call back into papertrade code.
module papertrade::test_usdc {
    use std::option;
    use std::signer;
    use std::string::utf8;
    use aptos_std::table::{Self, Table};
    use aptos_framework::event;
    use aptos_framework::fungible_asset::{Self, MintRef, Metadata};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    friend papertrade::usdc_gateway;

    const ASSET_SEED: vector<u8> = b"PAPERTRADE_TEST_USDC";
    const DECIMALS: u8 = 6;
    const ONE_USDC: u64 = 1_000_000;
    const DEFAULT_FAUCET_AMOUNT: u64 = 10_000_000_000; // 10,000 USDC
    const DEFAULT_FAUCET_COOLDOWN_SECS: u64 = 86_400;
    const MAX_FAUCET_AMOUNT: u64 = 1_000_000_000_000; // 1,000,000 USDC
    const MAX_FAUCET_COOLDOWN_SECS: u64 = 31_536_000; // 1 year

    /// Caller is not the admin.
    const E_NOT_ADMIN: u64 = 1;
    /// Faucet cooldown has not elapsed for this address.
    const E_FAUCET_COOLDOWN: u64 = 2;
    /// Amount must be > 0.
    const E_ZERO_AMOUNT: u64 = 3;
    /// Faucet configuration out of bounds.
    const E_INVALID_FAUCET_CONFIG: u64 = 4;

    /// Stored at the metadata object address.
    struct Refs has key {
        mint_ref: MintRef,
    }

    /// Stored at @papertrade.
    struct Faucet has key {
        admin: address,
        amount: u64,
        cooldown_secs: u64,
        last_claim: Table<address, u64>,
    }

    #[event]
    struct FaucetClaimed has drop, store {
        user: address,
        amount: u64,
        timestamp: u64,
    }

    #[event]
    struct AdminMinted has drop, store {
        to: address,
        amount: u64,
    }

    fun init_module(deployer: &signer) {
        let cref = object::create_named_object(deployer, ASSET_SEED);
        primary_fungible_store::create_primary_store_enabled_fungible_asset(
            &cref,
            option::none(),
            utf8(b"Test USDC"),
            utf8(b"tUSDC"),
            DECIMALS,
            utf8(b""),
            utf8(b""),
        );
        let mint_ref = fungible_asset::generate_mint_ref(&cref);
        move_to(&object::generate_signer(&cref), Refs { mint_ref });
        move_to(deployer, Faucet {
            admin: signer::address_of(deployer),
            amount: DEFAULT_FAUCET_AMOUNT,
            cooldown_secs: DEFAULT_FAUCET_COOLDOWN_SECS,
            last_claim: table::new(),
        });
    }

    // ---------------------------------------------------------------------
    // Public / entry
    // ---------------------------------------------------------------------

    /// Claim `Faucet.amount` test USDC. Each address may claim once per `cooldown_secs`.
    public entry fun faucet(user: &signer) acquires Faucet, Refs {
        let addr = signer::address_of(user);
        let f = borrow_global_mut<Faucet>(@papertrade);
        let now = timestamp::now_seconds();
        if (table::contains(&f.last_claim, addr)) {
            let last = table::borrow_mut(&mut f.last_claim, addr);
            // cooldown_secs is bounded, so no overflow.
            assert!(now >= *last + f.cooldown_secs, E_FAUCET_COOLDOWN);
            *last = now;
        } else {
            table::add(&mut f.last_claim, addr, now);
        };
        let amount = f.amount;
        mint_internal(addr, amount);
        event::emit(FaucetClaimed { user: addr, amount, timestamp: now });
    }

    /// Admin-only unrestricted mint.
    public entry fun mint(admin: &signer, to: address, amount: u64) acquires Faucet, Refs {
        assert_admin(admin);
        assert!(amount > 0, E_ZERO_AMOUNT);
        mint_internal(to, amount);
        event::emit(AdminMinted { to, amount });
    }

    public entry fun set_faucet_config(admin: &signer, amount: u64, cooldown_secs: u64) acquires Faucet {
        assert_admin(admin);
        assert!(amount > 0 && amount <= MAX_FAUCET_AMOUNT, E_INVALID_FAUCET_CONFIG);
        assert!(cooldown_secs <= MAX_FAUCET_COOLDOWN_SECS, E_INVALID_FAUCET_CONFIG);
        let f = borrow_global_mut<Faucet>(@papertrade);
        f.amount = amount;
        f.cooldown_secs = cooldown_secs;
    }

    public entry fun set_admin(admin: &signer, new_admin: address) acquires Faucet {
        assert_admin(admin);
        borrow_global_mut<Faucet>(@papertrade).admin = new_admin;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    #[view]
    public fun metadata(): Object<Metadata> {
        object::address_to_object<Metadata>(object::create_object_address(&@papertrade, ASSET_SEED))
    }

    #[view]
    public fun balance(owner: address): u64 {
        primary_fungible_store::balance(owner, metadata())
    }

    #[view]
    /// Seconds until `user` may claim from the faucet again (0 = now).
    public fun faucet_cooldown_remaining(user: address): u64 acquires Faucet {
        let f = borrow_global<Faucet>(@papertrade);
        if (!table::contains(&f.last_claim, user)) return 0;
        let next = *table::borrow(&f.last_claim, user) + f.cooldown_secs;
        let now = timestamp::now_seconds();
        if (now >= next) 0 else next - now
    }

    #[view]
    public fun faucet_config(): (u64, u64) acquires Faucet {
        let f = borrow_global<Faucet>(@papertrade);
        (f.amount, f.cooldown_secs)
    }

    public fun one_usdc(): u64 { ONE_USDC }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    fun assert_admin(s: &signer) acquires Faucet {
        assert!(signer::address_of(s) == borrow_global<Faucet>(@papertrade).admin, E_NOT_ADMIN);
    }

    /// Mint backed 1:1 by real Circle USDC locked in usdc_gateway.
    public(friend) fun mint_for_gateway(to: address, amount: u64) acquires Refs {
        mint_internal(to, amount);
    }

    fun mint_internal(to: address, amount: u64) acquires Refs {
        let refs = borrow_global<Refs>(object::object_address(&metadata()));
        primary_fungible_store::mint(&refs.mint_ref, to, amount);
    }

    #[test_only]
    public fun init_for_test(deployer: &signer) {
        init_module(deployer);
    }

    #[test_only]
    public fun mint_for_test(to: address, amount: u64) acquires Refs {
        mint_internal(to, amount);
    }
}
