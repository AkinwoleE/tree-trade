#[test_only]
module papertrade::tokenomics_tests {
    use papertrade::tokenomics as t;
    use papertrade::tests;
    use papertrade::exchange;
    use papertrade::paper;

    const USDC: u64 = 1_000_000;
    const TH: u64 = 2_000_000_000_000;
    const S: u64 = 120_000_000_000_000;

    #[test]
    fun flat_region_and_underwater() {
        assert!(t::compute_mint(USDC, 0, false, 100, TH, S, 0) == 100 * USDC, 0);
        assert!(t::compute_mint(USDC, (TH as u128) - 1, false, 100, TH, S, 999_999_999_999_999) == 100 * USDC, 1);
        // underwater always flat, whatever the HWM
        assert!(t::compute_mint(USDC, 5_000_000_000_000, true, 100, TH, S, 1_000_000_000_000_000) == 100 * USDC, 2);
    }

    #[test]
    fun tail_region_formula() {
        let lp = (TH as u128);
        // H = 0 -> still 100
        assert!(t::compute_mint(USDC, lp, false, 100, TH, S, 0) == 100 * USDC, 0);
        // H = S -> 100 * 1/4 = 25
        assert!(t::compute_mint(USDC, lp, false, 100, TH, S, (S as u128)) == 25 * USDC, 1);
        // Docs example: H = $100M -> 100*(120/220)^2 = 29.752066 /$
        assert!(t::compute_rate_e6(lp, false, 100, TH, S, 100_000_000_000_000) == 29_752_066, 2);
        // Paper Trade live (Oct 2026): H = $171.2538M -> ~16.98 /$
        assert!(t::compute_rate_e6(lp, false, 100, TH, S, 171_253_796_482_173) == 16_975_372, 3);
        // H = 3S -> 100/16 = 6.25
        assert!(t::compute_rate_e6(lp, false, 100, TH, S, 3 * (S as u128)) == 6_250_000, 4);
        // saturates
        assert!(t::compute_mint(18446744073709551615, 0, false, 100, TH, S, 0) == 18446744073709551615, 5);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    fun hwm_ratchet_and_mint(fw: &signer, admin: &signer, alice: &signer) {
        tests::setup_for(fw, admin);
        // Small curve for test: threshold 100 USDC, S 1000 USDC.
        t::set_params(admin, 100, 100 * USDC, 1000 * USDC);
        tests::seed_pool_for(admin, 90 * USDC);
        tests::fund_trader_for(alice, 10_000 * USDC);
        // lose 50 (fee 1, basis 49): LP 90 < 100 -> flat 4900; gain 49 crosses th -> HWM 39
        tests::lose_for(alice, admin, 1);
        assert!(paper::balance_of(@0xA11CE) == 4900 * USDC, 0);
        assert!(t::tail_progress() == 39 * (USDC as u128), 1);
        // second loss at HWM 39: 49 * 100 * (1000/1039)^2
        let before = paper::balance_of(@0xA11CE);
        tests::lose_for(alice, admin, 2);
        let got = paper::balance_of(@0xA11CE) - before;
        let exp = ((49 * USDC as u256) * 100 * 1000 * 1000 / (1039 * 1039) as u64);
        assert!(got == exp, 2);
        assert!(t::tail_progress() == 88 * (USDC as u128), 3);
        let (_, neg, rate) = exchange::seeds_rate();
        assert!(!neg && rate == (100_000_000u256 * 1000 * 1000 / (1088 * 1088) as u64), 4);
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    fun admin_raise_only(fw: &signer, admin: &signer) {
        tests::setup_for(fw, admin);
        t::raise_tail_progress(admin, 5);
        assert!(t::tail_progress() == 5, 0);
    }

    #[test(fw = @aptos_framework, admin = @papertrade)]
    #[expected_failure(abort_code = 2, location = papertrade::tokenomics)]
    fun hwm_cannot_decrease(fw: &signer, admin: &signer) {
        tests::setup_for(fw, admin);
        t::raise_tail_progress(admin, 5);
        t::raise_tail_progress(admin, 4);
    }

    #[test(fw = @aptos_framework, admin = @papertrade, alice = @0xA11CE)]
    #[expected_failure(abort_code = 1, location = papertrade::tokenomics)]
    fun non_admin_params(fw: &signer, admin: &signer, alice: &signer) {
        tests::setup_for(fw, admin);
        t::set_params(alice, 1, 1, 1);
    }
}
