/// Hedge requests: per-position, owner-signed consent for the off-chain hedger service to mirror a
/// Tree Trade position with an opposite-side position on Decibel.
///
/// This module only records intent. It holds no funds and never touches Decibel. Trading authority on
/// Decibel comes from the user's own delegation on their Decibel Trading Account (subaccount), which they
/// grant and revoke on Decibel. The hedger only acts when both exist:
///   1. an active request here (position still open), and
///   2. a Decibel delegation from that subaccount to the hedger address.
///
/// Added as a new module in a compatible upgrade; `exchange` is unchanged.
module papertrade::hedge {
    use std::signer;
    use std::vector;
    use aptos_std::ordered_map::{Self, OrderedMap};
    use aptos_std::table::{Self, Table};
    use aptos_framework::event;
    use aptos_framework::object::{Self, ObjectCore};
    use aptos_framework::timestamp;
    use papertrade::exchange;

    /// Caller does not own the position.
    const E_NOT_POSITION_OWNER: u64 = 1;
    /// The subaccount is not an object owned by the caller.
    const E_NOT_SUBACCOUNT_OWNER: u64 = 2;
    /// A request for this position already exists.
    const E_ALREADY_REQUESTED: u64 = 3;
    /// No request for this position.
    const E_NO_REQUEST: u64 = 4;
    /// The position is still open, so the request cannot be pruned.
    const E_POSITION_OPEN: u64 = 5;
    /// Too many active requests.
    const E_TOO_MANY_REQUESTS: u64 = 6;

    /// Bounds the registry so `active_requests` stays a cheap single view.
    const MAX_ACTIVE: u64 = 1000;

    struct Request has store, copy, drop {
        owner: address,
        /// Decibel Trading Account (object owned by `owner`) the hedge is placed on.
        subaccount: address,
        requested_at: u64,
    }

    struct Registry has key {
        requests: OrderedMap<u64, Request>,
    }

    #[event]
    struct HedgeRequested has drop, store {
        position_id: u64,
        owner: address,
        subaccount: address,
    }

    #[event]
    /// `by_owner` is false when pruned after the position closed or was liquidated.
    struct HedgeCancelled has drop, store {
        position_id: u64,
        owner: address,
        by_owner: bool,
    }

    fun init_module(deployer: &signer) {
        move_to(deployer, Registry { requests: ordered_map::new() });
    }

    // ---------------------------------------------------------------------
    // Entry functions
    // ---------------------------------------------------------------------

    /// `exchange::open_position` plus a hedge request for the new position, in one transaction.
    public entry fun open_position_hedged(
        user: &signer,
        market: u8,
        is_long: bool,
        margin: u64,
        leverage: u64,
        subaccount: address,
    ) acquires Registry, OwnerCounts {
        exchange::open_position(user, market, is_long, margin, leverage);
        // open_position appends the new id, so it is the last entry right now.
        let ids = exchange::user_positions(signer::address_of(user));
        let id = *vector::borrow(&ids, vector::length(&ids) - 1);
        add_request(user, id, subaccount);
    }

    /// 1-click variant: a Tree Trade session key (an `exchange` trading delegate) opens a hedged position
    /// for `owner`. Authorization is `exchange::open_position_as_delegate`'s delegate check; the Trading
    /// Account must still be an object owned by `owner`, so a delegate can only point the hedge at the
    /// owner's own Decibel account.
    public entry fun open_position_hedged_as_delegate(
        delegate: &signer,
        owner: address,
        market: u8,
        is_long: bool,
        margin: u64,
        leverage: u64,
        subaccount: address,
    ) acquires Registry, OwnerCounts {
        exchange::open_position_as_delegate(delegate, owner, market, is_long, margin, leverage);
        let ids = exchange::user_positions(owner);
        let id = *vector::borrow(&ids, vector::length(&ids) - 1);
        add_request_for(owner, id, subaccount);
    }

    /// Hedge an already open position.
    public entry fun request_hedge(user: &signer, position_id: u64, subaccount: address) acquires Registry, OwnerCounts {
        let (owner, _, _, _, _, _, _, _) = exchange::get_position(position_id);
        assert!(owner == signer::address_of(user), E_NOT_POSITION_OWNER);
        add_request(user, position_id, subaccount);
    }

    /// Stop hedging; the hedger then closes the Decibel side.
    public entry fun cancel_hedge(user: &signer, position_id: u64) acquires Registry, OwnerCounts {
        let reg = borrow_global_mut<Registry>(@papertrade);
        assert!(reg.requests.contains(&position_id), E_NO_REQUEST);
        let req = *reg.requests.borrow(&position_id);
        assert!(req.owner == signer::address_of(user), E_NOT_POSITION_OWNER);
        reg.requests.remove(&position_id);
        dec_owner(req.owner);
        event::emit(HedgeCancelled { position_id, owner: req.owner, by_owner: true });
    }

    /// Permissionless cleanup once the position is closed or liquidated. The hedger calls this after
    /// it has flattened the Decibel side, which also marks the hedge as settled on-chain.
    public entry fun prune(_caller: &signer, position_id: u64) acquires Registry, OwnerCounts {
        assert!(!exchange::position_exists(position_id), E_POSITION_OPEN);
        let reg = borrow_global_mut<Registry>(@papertrade);
        assert!(reg.requests.contains(&position_id), E_NO_REQUEST);
        let req = reg.requests.remove(&position_id);
        dec_owner(req.owner);
        event::emit(HedgeCancelled { position_id, owner: req.owner, by_owner: false });
    }

    fun add_request(user: &signer, position_id: u64, subaccount: address) acquires Registry, OwnerCounts {
        add_request_for(signer::address_of(user), position_id, subaccount);
    }

    fun add_request_for(owner: address, position_id: u64, subaccount: address) acquires Registry, OwnerCounts {
        // AUDIT M-12: per-owner cap so no single account can fill the shared registry.
        if (exists<OwnerCounts>(@papertrade)) {
            let oc = borrow_global_mut<OwnerCounts>(@papertrade);
            let c = table::borrow_mut_with_default(&mut oc.counts, owner, 0);
            assert!(*c < oc.max_per_owner, E_OWNER_CAP);
            *c = *c + 1;
        };
        // A Decibel Trading Account is an object owned by the wallet that created it.
        assert!(
            object::is_object(subaccount)
                && object::is_owner(object::address_to_object<ObjectCore>(subaccount), owner),
            E_NOT_SUBACCOUNT_OWNER,
        );
        let reg = borrow_global_mut<Registry>(@papertrade);
        assert!(!reg.requests.contains(&position_id), E_ALREADY_REQUESTED);
        assert!(reg.requests.length() < MAX_ACTIVE, E_TOO_MANY_REQUESTS);
        reg.requests.add(position_id, Request { owner, subaccount, requested_at: timestamp::now_seconds() });
        event::emit(HedgeRequested { position_id, owner, subaccount });
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    #[view]
    /// All active requests as parallel vectors: (position_ids, owners, subaccounts).
    /// Includes requests whose position has closed but which are not pruned yet.
    public fun active_requests(): (vector<u64>, vector<address>, vector<address>) acquires Registry {
        let reg = borrow_global<Registry>(@papertrade);
        let ids = reg.requests.keys();
        let owners = vector::empty<address>();
        let subs = vector::empty<address>();
        reg.requests.values().for_each(|r| {
            let r: Request = r;
            owners.push_back(r.owner);
            subs.push_back(r.subaccount);
        });
        (ids, owners, subs)
    }

    #[view]
    /// (exists, owner, subaccount, requested_at)
    public fun request_of(position_id: u64): (bool, address, address, u64) acquires Registry {
        let reg = borrow_global<Registry>(@papertrade);
        if (reg.requests.contains(&position_id)) {
            let r = reg.requests.borrow(&position_id);
            (true, r.owner, r.subaccount, r.requested_at)
        } else (false, @0x0, @0x0, 0)
    }


    // ---------------------------------------------------------------------
    // V2 (AUDIT_2026-10-15): per-owner request cap, signed-price hedged opens, delegate hedge scope.
    // ---------------------------------------------------------------------

    const E_OWNER_CAP: u64 = 7;
    const E_V2_EXISTS: u64 = 8;
    const E_NOT_ADMIN: u64 = 9;
    const E_SCOPE_DENIED: u64 = 10;

    struct OwnerCounts has key { counts: Table<address, u64>, max_per_owner: u64 }

    public entry fun init_v2(admin: &signer) {
        assert!(signer::address_of(admin) == @papertrade && exchange::admin() == @papertrade, E_NOT_ADMIN);
        assert!(!exists<OwnerCounts>(@papertrade), E_V2_EXISTS);
        move_to(admin, OwnerCounts { counts: table::new(), max_per_owner: 16 });
    }

    public entry fun set_max_per_owner(admin: &signer, max: u64) acquires OwnerCounts {
        assert!(signer::address_of(admin) == exchange::admin(), E_NOT_ADMIN);
        assert!(max > 0 && max <= MAX_ACTIVE, E_OWNER_CAP);
        borrow_global_mut<OwnerCounts>(@papertrade).max_per_owner = max;
    }

    fun dec_owner(owner: address) acquires OwnerCounts {
        if (!exists<OwnerCounts>(@papertrade)) return;
        let oc = borrow_global_mut<OwnerCounts>(@papertrade);
        if (!table::contains(&oc.counts, owner)) return; // requests from before V2
        let c = table::borrow_mut(&mut oc.counts, owner);
        if (*c <= 1) { table::remove(&mut oc.counts, owner); } else { *c = *c - 1; };
    }

    /// `exchange::open_position_px` (signed price) plus a hedge request, in one transaction.
    public entry fun open_position_hedged_px(
        user: &signer, market: u8, is_long: bool, margin: u64, leverage: u64, subaccount: address,
        price: u64, publish_time: u64, signature: vector<u8>,
    ) acquires Registry, OwnerCounts {
        exchange::open_position_px(user, market, is_long, margin, leverage, price, publish_time, signature);
        let ids = exchange::user_positions(signer::address_of(user));
        let id = *vector::borrow(&ids, vector::length(&ids) - 1);
        add_request(user, id, subaccount);
    }

    /// 1-click hedged open: the session key must have the owner's `allow_hedge` scope.
    public entry fun open_position_hedged_as_delegate_px(
        delegate: &signer, owner: address, market: u8, is_long: bool, margin: u64, leverage: u64, subaccount: address,
        price: u64, publish_time: u64, signature: vector<u8>,
    ) acquires Registry, OwnerCounts {
        let (_, allow_hedge, _) = exchange::scope_of(owner, signer::address_of(delegate));
        assert!(allow_hedge, E_SCOPE_DENIED);
        exchange::open_position_as_delegate_px(delegate, owner, market, is_long, margin, leverage, price, publish_time, signature);
        let ids = exchange::user_positions(owner);
        let id = *vector::borrow(&ids, vector::length(&ids) - 1);
        add_request_for(owner, id, subaccount);
    }

    #[view]
    /// (active requests of `owner` counted since V2, per-owner cap)
    public fun owner_requests(owner: address): (u64, u64) acquires OwnerCounts {
        if (!exists<OwnerCounts>(@papertrade)) return (0, MAX_ACTIVE);
        let oc = borrow_global<OwnerCounts>(@papertrade);
        (if (table::contains(&oc.counts, owner)) *table::borrow(&oc.counts, owner) else 0, oc.max_per_owner)
    }

    #[test_only]
    public fun init_for_test(deployer: &signer) {
        init_module(deployer);
    }
}
