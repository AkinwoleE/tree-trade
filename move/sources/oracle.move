/// Admin/keeper-pushed price oracle for the synthetic markets.
/// Markets: 0 = BTC, 1 = ETH. Prices are USD with 8 decimals (1e8 fixed point).
/// `get_price` aborts if the latest price is older than `max_staleness_secs`.
module papertrade::oracle {
    use std::bcs;
    use std::option::{Self, Option};
    use std::signer;
    use aptos_std::ed25519;
    use std::vector;
    use aptos_framework::event;
    use aptos_framework::timestamp;

    const MARKET_BTC: u8 = 0;
    const MARKET_ETH: u8 = 1;
    const NUM_MARKETS: u8 = 2;
    const PRICE_DECIMALS: u8 = 8;
    const DEFAULT_MAX_STALENESS_SECS: u64 = 60;
    const MAX_STALENESS_LIMIT_SECS: u64 = 86_400;
    const MAX_KEEPERS: u64 = 16;
    /// Sanity upper bound for prices: 1e18 raw (= 1e10 USD in 1e8 fixed point).
    const MAX_PRICE: u64 = 1_000_000_000_000_000_000;

    /// Caller is neither admin nor keeper.
    const E_NOT_AUTHORIZED: u64 = 1;
    /// Unknown market id.
    const E_INVALID_MARKET: u64 = 2;
    /// Price must be in (0, MAX_PRICE].
    const E_INVALID_PRICE: u64 = 3;
    /// Latest price is older than the staleness window.
    const E_STALE_PRICE: u64 = 4;
    /// No price has ever been pushed for this market.
    const E_NO_PRICE: u64 = 5;
    /// publish_time is in the future.
    const E_FUTURE_TIMESTAMP: u64 = 6;
    /// publish_time is older than the currently stored price.
    const E_OLD_TIMESTAMP: u64 = 7;
    /// Staleness window out of bounds.
    const E_INVALID_STALENESS: u64 = 8;
    /// Keeper already registered.
    const E_KEEPER_EXISTS: u64 = 9;
    /// Keeper not registered.
    const E_KEEPER_NOT_FOUND: u64 = 10;
    /// Keeper list is full.
    const E_TOO_MANY_KEEPERS: u64 = 11;
    /// Caller is not the pending admin.
    const E_NOT_PENDING_ADMIN: u64 = 12;
    /// Caller is not the admin.
    const E_NOT_ADMIN: u64 = 13;

    friend papertrade::exchange;

    struct PriceData has store, copy, drop {
        price: u64,
        publish_time: u64,
    }

    struct Oracle has key {
        admin: address,
        pending_admin: Option<address>,
        keepers: vector<address>,
        max_staleness_secs: u64,
        prices: vector<PriceData>,
    }

    #[event]
    struct PriceUpdated has drop, store {
        market: u8,
        price: u64,
        publish_time: u64,
        pusher: address,
    }

    #[event]
    struct KeeperUpdated has drop, store {
        keeper: address,
        added: bool,
    }

    #[event]
    struct AdminTransferred has drop, store {
        old_admin: address,
        new_admin: address,
    }

    fun init_module(deployer: &signer) {
        let prices = vector::empty<PriceData>();
        let i = 0;
        while (i < NUM_MARKETS) {
            vector::push_back(&mut prices, PriceData { price: 0, publish_time: 0 });
            i = i + 1;
        };
        move_to(deployer, Oracle {
            admin: signer::address_of(deployer),
            pending_admin: option::none(),
            keepers: vector::empty(),
            max_staleness_secs: DEFAULT_MAX_STALENESS_SECS,
            prices,
        });
    }

    // ---------------------------------------------------------------------
    // Price pushing
    // ---------------------------------------------------------------------

    /// Push a new price. Only admin or a registered keeper.
    /// `publish_time` must be <= now and >= the stored publish time (monotonic).
    public entry fun push_price(pusher: &signer, market: u8, price: u64, publish_time: u64) acquires Oracle, PriceGuard {
        let who = signer::address_of(pusher);
        let o = borrow_global_mut<Oracle>(@papertrade);
        assert!(who == o.admin || vector::contains(&o.keepers, &who), E_NOT_AUTHORIZED);
        assert!(market < NUM_MARKETS, E_INVALID_MARKET);
        assert!(price > 0 && price <= MAX_PRICE, E_INVALID_PRICE);
        assert!(publish_time <= timestamp::now_seconds(), E_FUTURE_TIMESTAMP);
        // On-chain move cap for keepers (admin pushes stay unbounded as the circuit-breaker reset).
        if (who != o.admin && exists<PriceGuard>(@papertrade)) {
            check_move(vector::borrow(&o.prices, (market as u64)), borrow_global<PriceGuard>(@papertrade), price, publish_time);
        };
        let slot = vector::borrow_mut(&mut o.prices, (market as u64));
        assert!(publish_time >= slot.publish_time, E_OLD_TIMESTAMP);
        slot.price = price;
        slot.publish_time = publish_time;
        event::emit(PriceUpdated { market, price, publish_time, pusher: who });
    }

    /// Convenience: push both markets at once with the same publish time.
    public entry fun push_prices(pusher: &signer, btc_price: u64, eth_price: u64, publish_time: u64) acquires Oracle, PriceGuard {
        push_price(pusher, MARKET_BTC, btc_price, publish_time);
        push_price(pusher, MARKET_ETH, eth_price, publish_time);
    }

    /// Fresh price for `market` (aborts if missing or stale).
    public fun get_price(market: u8): u64 acquires Oracle {
        assert!(market < NUM_MARKETS, E_INVALID_MARKET);
        let o = borrow_global<Oracle>(@papertrade);
        let p = vector::borrow(&o.prices, (market as u64));
        assert!(p.price > 0, E_NO_PRICE);
        // publish_time <= now always holds (enforced at push), staleness bounded => no overflow.
        assert!(timestamp::now_seconds() <= p.publish_time + o.max_staleness_secs, E_STALE_PRICE);
        p.price
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    public entry fun add_keeper(admin: &signer, keeper: address) acquires Oracle {
        let o = borrow_global_mut<Oracle>(@papertrade);
        assert!(signer::address_of(admin) == o.admin, E_NOT_ADMIN);
        assert!(!vector::contains(&o.keepers, &keeper), E_KEEPER_EXISTS);
        assert!(vector::length(&o.keepers) < MAX_KEEPERS, E_TOO_MANY_KEEPERS);
        vector::push_back(&mut o.keepers, keeper);
        event::emit(KeeperUpdated { keeper, added: true });
    }

    public entry fun remove_keeper(admin: &signer, keeper: address) acquires Oracle {
        let o = borrow_global_mut<Oracle>(@papertrade);
        assert!(signer::address_of(admin) == o.admin, E_NOT_ADMIN);
        let (found, idx) = vector::index_of(&o.keepers, &keeper);
        assert!(found, E_KEEPER_NOT_FOUND);
        vector::swap_remove(&mut o.keepers, idx);
        event::emit(KeeperUpdated { keeper, added: false });
    }

    public entry fun set_max_staleness(admin: &signer, secs: u64) acquires Oracle {
        let o = borrow_global_mut<Oracle>(@papertrade);
        assert!(signer::address_of(admin) == o.admin, E_NOT_ADMIN);
        assert!(secs > 0 && secs <= MAX_STALENESS_LIMIT_SECS, E_INVALID_STALENESS);
        o.max_staleness_secs = secs;
    }

    /// Two-step admin transfer, step 1.
    public entry fun transfer_admin(admin: &signer, new_admin: address) acquires Oracle {
        let o = borrow_global_mut<Oracle>(@papertrade);
        assert!(signer::address_of(admin) == o.admin, E_NOT_ADMIN);
        o.pending_admin = option::some(new_admin);
    }

    /// Two-step admin transfer, step 2.
    public entry fun accept_admin(new_admin: &signer) acquires Oracle {
        let o = borrow_global_mut<Oracle>(@papertrade);
        let who = signer::address_of(new_admin);
        assert!(o.pending_admin == option::some(who), E_NOT_PENDING_ADMIN);
        let old_admin = o.admin;
        o.admin = who;
        o.pending_admin = option::none();
        event::emit(AdminTransferred { old_admin, new_admin: who });
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    #[view]
    /// Raw stored (price, publish_time); does not check staleness.
    public fun price_info(market: u8): (u64, u64) acquires Oracle {
        assert!(market < NUM_MARKETS, E_INVALID_MARKET);
        let p = vector::borrow(&borrow_global<Oracle>(@papertrade).prices, (market as u64));
        (p.price, p.publish_time)
    }

    #[view]
    public fun is_fresh(market: u8): bool acquires Oracle {
        assert!(market < NUM_MARKETS, E_INVALID_MARKET);
        let o = borrow_global<Oracle>(@papertrade);
        let p = vector::borrow(&o.prices, (market as u64));
        p.price > 0 && timestamp::now_seconds() <= p.publish_time + o.max_staleness_secs
    }

    #[view]
    public fun max_staleness(): u64 acquires Oracle {
        borrow_global<Oracle>(@papertrade).max_staleness_secs
    }

    #[view]
    public fun keepers(): vector<address> acquires Oracle {
        borrow_global<Oracle>(@papertrade).keepers
    }

    #[view]
    public fun admin(): address acquires Oracle {
        borrow_global<Oracle>(@papertrade).admin
    }

    public fun num_markets(): u8 { NUM_MARKETS }
    public fun price_decimals(): u8 { PRICE_DECIMALS }


    // =====================================================================
    // V2 (AUDIT_2026-10-15 H-1/H-2): price guard.
    // * Signed prices: every trade carries a price signed off-chain (ed25519) by the price signer key
    //   registered here, verified on chain and accepted only if <= max_age_secs old (pull-oracle style,
    //   like Pyth/Decibel price updates). A fresher signed price also refreshes the stored price.
    // * Move cap: a keeper push or signed price may move at most
    //   min(base_move_bps + move_bps_per_sec * elapsed, max_move_bps) from the stored price.
    // =====================================================================

    const E_NO_GUARD: u64 = 14;
    const E_GUARD_EXISTS: u64 = 15;
    const E_BAD_SIGNATURE: u64 = 16;
    const E_PRICE_TOO_OLD: u64 = 17;
    const E_PRICE_MOVE_TOO_LARGE: u64 = 18;
    const E_BAD_GUARD_PARAM: u64 = 19;
    const SIGNED_PRICE_DOMAIN: vector<u8> = b"TREETRADE_PRICE_V1";

    struct PriceGuard has key {
        signer_pk: vector<u8>,
        max_age_secs: u64,
        max_skew_secs: u64,
        base_move_bps: u64,
        move_bps_per_sec: u64,
        max_move_bps: u64,
    }

    /// BCS layout signed off-chain: domain (vector<u8>), package address, market (u8), price (u64), publish_time (u64).
    struct SignedPriceMsg has drop {
        domain: vector<u8>,
        package: address,
        market: u8,
        price: u64,
        publish_time: u64,
    }

    #[event]
    struct PriceSignerSet has drop, store { signer_pk: vector<u8> }

    public entry fun init_guard(admin: &signer, signer_pk: vector<u8>) acquires Oracle {
        let o = borrow_global<Oracle>(@papertrade);
        assert!(signer::address_of(admin) == o.admin && signer::address_of(admin) == @papertrade, E_NOT_ADMIN);
        assert!(!exists<PriceGuard>(@papertrade), E_GUARD_EXISTS);
        assert_pk(&signer_pk);
        move_to(admin, PriceGuard {
            signer_pk, max_age_secs: 10, max_skew_secs: 3, base_move_bps: 50, move_bps_per_sec: 10, max_move_bps: 1000,
        });
        event::emit(PriceSignerSet { signer_pk });
    }

    /// Rotate the price signer key.
    public entry fun set_price_signer(admin: &signer, signer_pk: vector<u8>) acquires Oracle, PriceGuard {
        assert!(signer::address_of(admin) == borrow_global<Oracle>(@papertrade).admin, E_NOT_ADMIN);
        assert_pk(&signer_pk);
        borrow_global_mut<PriceGuard>(@papertrade).signer_pk = signer_pk;
        event::emit(PriceSignerSet { signer_pk });
    }

    public entry fun set_guard_params(
        admin: &signer, max_age_secs: u64, max_skew_secs: u64, base_move_bps: u64, move_bps_per_sec: u64, max_move_bps: u64,
    ) acquires Oracle, PriceGuard {
        assert!(signer::address_of(admin) == borrow_global<Oracle>(@papertrade).admin, E_NOT_ADMIN);
        assert!(max_age_secs > 0 && max_age_secs <= 60 && max_skew_secs <= 10, E_BAD_GUARD_PARAM);
        assert!(base_move_bps <= max_move_bps && max_move_bps > 0 && max_move_bps <= 5000, E_BAD_GUARD_PARAM);
        let g = borrow_global_mut<PriceGuard>(@papertrade);
        g.max_age_secs = max_age_secs; g.max_skew_secs = max_skew_secs;
        g.base_move_bps = base_move_bps; g.move_bps_per_sec = move_bps_per_sec; g.max_move_bps = max_move_bps;
    }

    fun assert_pk(pk: &vector<u8>) {
        assert!(vector::length(pk) == 32, E_BAD_SIGNATURE);
        let v = ed25519::new_validated_public_key_from_bytes(*pk);
        assert!(option::is_some(&v), E_BAD_SIGNATURE);
    }

    fun check_move(slot: &PriceData, g: &PriceGuard, price: u64, publish_time: u64) {
        if (slot.price == 0) return;
        let elapsed = if (publish_time > slot.publish_time) publish_time - slot.publish_time else 0;
        let allowed = (g.base_move_bps as u128) + (g.move_bps_per_sec as u128) * (elapsed as u128);
        if (allowed > (g.max_move_bps as u128)) allowed = (g.max_move_bps as u128);
        let old = (slot.price as u128);
        let p = (price as u128);
        let diff = if (p > old) p - old else old - p;
        assert!(diff * 10_000 <= allowed * old, E_PRICE_MOVE_TOO_LARGE);
    }

    /// Verify a signed price for `market` and return it. Refreshes the stored price when newer.
    public(friend) fun verified_price(market: u8, price: u64, publish_time: u64, signature: vector<u8>): u64 acquires Oracle, PriceGuard {
        assert!(exists<PriceGuard>(@papertrade), E_NO_GUARD);
        assert!(market < NUM_MARKETS, E_INVALID_MARKET);
        assert!(price > 0 && price <= MAX_PRICE, E_INVALID_PRICE);
        let g = borrow_global<PriceGuard>(@papertrade);
        let now = timestamp::now_seconds();
        assert!(publish_time <= now + g.max_skew_secs, E_FUTURE_TIMESTAMP);
        assert!(now <= publish_time + g.max_age_secs, E_PRICE_TOO_OLD);
        let msg = bcs::to_bytes(&SignedPriceMsg { domain: SIGNED_PRICE_DOMAIN, package: @papertrade, market, price, publish_time });
        let sig = ed25519::new_signature_from_bytes(signature);
        let pk = ed25519::new_unvalidated_public_key_from_bytes(g.signer_pk);
        assert!(ed25519::signature_verify_strict(&sig, &pk, msg), E_BAD_SIGNATURE);
        let o = borrow_global_mut<Oracle>(@papertrade);
        let slot = vector::borrow_mut(&mut o.prices, (market as u64));
        check_move(slot, g, price, publish_time);
        let t = if (publish_time > now) now else publish_time;
        if (t > slot.publish_time) {
            slot.price = price;
            slot.publish_time = t;
            event::emit(PriceUpdated { market, price, publish_time: t, pusher: @0x0 });
        };
        price
    }

    #[view]
    /// (signer_pk, max_age_secs, max_skew_secs, base_move_bps, move_bps_per_sec, max_move_bps)
    public fun guard_params(): (vector<u8>, u64, u64, u64, u64, u64) acquires PriceGuard {
        let g = borrow_global<PriceGuard>(@papertrade);
        (g.signer_pk, g.max_age_secs, g.max_skew_secs, g.base_move_bps, g.move_bps_per_sec, g.max_move_bps)
    }

    #[view]
    public fun signed_message(market: u8, price: u64, publish_time: u64): vector<u8> {
        bcs::to_bytes(&SignedPriceMsg { domain: SIGNED_PRICE_DOMAIN, package: @papertrade, market, price, publish_time })
    }

    #[view]
    /// Stored price age in seconds (U64_MAX if never pushed).
    public fun price_age(market: u8): u64 acquires Oracle {
        let p = vector::borrow(&borrow_global<Oracle>(@papertrade).prices, (market as u64));
        if (p.publish_time == 0) 18446744073709551615 else timestamp::now_seconds() - p.publish_time
    }

    #[test_only]
    public fun init_for_test(deployer: &signer) {
        init_module(deployer);
    }
}
