/// SEEDS mint curve, a 1:1 port of Paper Trade's PaperTokenomics "flat-then-ratchet"
/// curve (docs.papertrade.xyz/#/how/mint-curve):
///
///   tracked_lp  = pool - queue_owed            (signed; negative = underwater)
///   flat region : tracked_lp <  threshold  -> rate = flat_rate          (100 SEEDS / $1)
///   tail region : tracked_lp >= threshold  -> rate = flat_rate * (S / (S + H))^2
///   H = tail_progress: one-way high-water mark of cumulative LP gain earned while
///       tracked LP sits at/above the threshold. Payouts and staker sweeps never lower it.
///
/// Defaults equal Paper Trade's live on-chain values: flat_rate 100,
/// lpFlatThresholdUsd $2M, tailDecayScaleUsd $120M. All are admin-tunable.
/// The rate used for a mint is the marginal rate at the HWM before that loss is booked.
module papertrade::tokenomics {
    use std::signer;
    use aptos_framework::event;

    friend papertrade::exchange;

    const E_NOT_ADMIN: u64 = 1;
    const E_BAD_PARAM: u64 = 2;

    /// USDC base units (6 decimals).
    const DEFAULT_THRESHOLD: u64 = 2_000_000_000_000; // $2M
    const DEFAULT_SCALE: u64 = 120_000_000_000_000;   // $120M
    const DEFAULT_FLAT_RATE: u64 = 100;               // SEEDS per $1 (both 6 decimals)
    /// Fixed-point scale for reported rates (rate_e6 = SEEDS per $1 * 1e6).
    const RATE_PRECISION: u256 = 1_000_000;
    const U64_MAX: u256 = 18446744073709551615;
    /// 2^96 USDC base units, far beyond any reachable LP gain.
    const MAX_TAIL: u128 = 79228162514264337593543950336;

    struct Curve has key {
        admin: address,
        flat_rate: u64,
        threshold: u64,
        scale: u64,
        /// High-water mark of cumulative LP gain past the threshold (USDC base units).
        tail_progress: u128,
        total_minted: u128,
        total_basis: u128,
    }

    #[event]
    struct CurveParamsUpdated has drop, store { flat_rate: u64, threshold: u64, scale: u64, tail_progress: u128 }

    #[event]
    struct TailAdvanced has drop, store { gain: u64, tail_progress: u128 }

    fun init_module(deployer: &signer) {
        move_to(deployer, Curve {
            admin: signer::address_of(deployer),
            flat_rate: DEFAULT_FLAT_RATE,
            threshold: DEFAULT_THRESHOLD,
            scale: DEFAULT_SCALE,
            tail_progress: 0,
            total_minted: 0,
            total_basis: 0,
        });
    }

    // ---------------------------------------------------------------------
    // Pure math
    // ---------------------------------------------------------------------

    /// SEEDS base units for `basis` USDC base units of eligible loss.
    public fun compute_mint(basis: u64, tracked_lp: u128, tracked_neg: bool, flat_rate: u64, threshold: u64, scale: u64, tail: u128): u64 {
        let raw = (basis as u256) * (flat_rate as u256);
        if (!tracked_neg && tracked_lp >= (threshold as u128)) {
            let s = (scale as u256);
            let d = s + (tail as u256);
            raw = raw * s * s / (d * d);
        };
        if (raw > U64_MAX) (U64_MAX as u64) else (raw as u64)
    }

    /// Rate in SEEDS per $1, scaled by 1e6.
    public fun compute_rate_e6(tracked_lp: u128, tracked_neg: bool, flat_rate: u64, threshold: u64, scale: u64, tail: u128): u64 {
        let raw = (flat_rate as u256) * RATE_PRECISION;
        if (!tracked_neg && tracked_lp >= (threshold as u128)) {
            let s = (scale as u256);
            let d = s + (tail as u256);
            raw = raw * s * s / (d * d);
        };
        (raw as u64)
    }

    // ---------------------------------------------------------------------
    // Friend (exchange) API
    // ---------------------------------------------------------------------

    /// Mint amount for `basis` at the current state (before the LP gain is booked).
    public(friend) fun quote(basis: u64, tracked_lp: u128, tracked_neg: bool): u64 acquires Curve {
        let c = borrow_global_mut<Curve>(@papertrade);
        let amt = compute_mint(basis, tracked_lp, tracked_neg, c.flat_rate, c.threshold, c.scale, c.tail_progress);
        c.total_minted = c.total_minted + (amt as u128);
        c.total_basis = c.total_basis + (basis as u128);
        amt
    }

    /// Book an LP gain of `gain` that moved tracked LP from `before` (signed) upward.
    /// Only the part of the gain landing at/above the threshold advances the HWM.
    public(friend) fun on_lp_gain(before: u128, before_neg: bool, gain: u64) acquires Curve {
        if (gain == 0) return;
        let c = borrow_global_mut<Curve>(@papertrade);
        let th = (c.threshold as u128);
        let g = (gain as u128);
        let adv = if (!before_neg && before >= th) {
            g
        } else {
            // distance from `before` up to the threshold
            let dist = if (before_neg) th + before else th - before;
            if (g > dist) g - dist else 0
        };
        if (adv == 0) return;
        c.tail_progress = c.tail_progress + adv;
        event::emit(TailAdvanced { gain: (adv as u64), tail_progress: c.tail_progress });
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    public entry fun set_params(admin: &signer, flat_rate: u64, threshold: u64, scale: u64) acquires Curve {
        let c = borrow_global_mut<Curve>(@papertrade);
        assert!(signer::address_of(admin) == c.admin, E_NOT_ADMIN);
        assert!(flat_rate > 0 && scale > 0, E_BAD_PARAM);
        c.flat_rate = flat_rate; c.threshold = threshold; c.scale = scale;
        event::emit(CurveParamsUpdated { flat_rate, threshold, scale, tail_progress: c.tail_progress });
    }

    /// The HWM is one-way: admin may only raise it (e.g. to mirror a reference curve position).
    public entry fun raise_tail_progress(admin: &signer, new_tail: u128) acquires Curve {
        let c = borrow_global_mut<Curve>(@papertrade);
        assert!(signer::address_of(admin) == c.admin, E_NOT_ADMIN);
        // Bounded so (scale + tail)^2 can never overflow u256 and freeze loss settlement (REVIEW L-9).
        assert!(new_tail >= c.tail_progress && new_tail <= MAX_TAIL, E_BAD_PARAM);
        c.tail_progress = new_tail;
        event::emit(CurveParamsUpdated { flat_rate: c.flat_rate, threshold: c.threshold, scale: c.scale, tail_progress: new_tail });
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    #[view]
    /// (flat_rate, threshold, scale, tail_progress, total_minted, total_basis)
    public fun params(): (u64, u64, u64, u128, u128, u128) acquires Curve {
        let c = borrow_global<Curve>(@papertrade);
        (c.flat_rate, c.threshold, c.scale, c.tail_progress, c.total_minted, c.total_basis)
    }

    #[view]
    public fun tail_progress(): u128 acquires Curve { borrow_global<Curve>(@papertrade).tail_progress }

    #[view]
    /// Rate (SEEDS per $1 * 1e6) for a given tracked LP and hypothetical HWM.
    public fun rate_at(tracked_lp: u128, tracked_neg: bool, tail: u128): u64 acquires Curve {
        let c = borrow_global<Curve>(@papertrade);
        compute_rate_e6(tracked_lp, tracked_neg, c.flat_rate, c.threshold, c.scale, tail)
    }

    #[test_only]
    public fun init_for_test(deployer: &signer) { init_module(deployer); }
}
