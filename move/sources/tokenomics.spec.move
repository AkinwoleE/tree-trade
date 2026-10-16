spec papertrade::tokenomics {
    /// The SEEDS curve never aborts for admin-reachable parameters (scale > 0) and never exceeds the flat rate.
    spec compute_mint(basis: u64, tracked_lp: u128, tracked_neg: bool, flat_rate: u64, threshold: u64, scale: u64, tail: u128): u64 {
        pragma verify_duration_estimate = 120;
        requires scale > 0;
        requires tail <= MAX_TAIL;
        aborts_if false;
        ensures result <= (if (basis * flat_rate > U64_MAX) U64_MAX else basis * flat_rate);
    }
    spec quote {
        requires global<Curve>(@papertrade).scale > 0;
        requires global<Curve>(@papertrade).tail_progress <= MAX_TAIL;
        pragma aborts_if_is_partial;
    }
    spec on_lp_gain {
        pragma aborts_if_is_partial;
    }
}
