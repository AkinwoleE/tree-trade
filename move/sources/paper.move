/// PAPER: a non-transferable points token minted to traders on realized losses.
/// Balances live in a global table (no coin/FA, no transfer function), so PAPER can
/// only be minted (by the exchange), staked and unstaked.
///
/// Stakers earn test-USDC rewards through a reward-per-share accumulator. Rewards are
/// held in a dedicated vault object owned by this module.
module papertrade::paper {
    use std::signer;
    use aptos_std::table::{Self, Table};
    use aptos_framework::event;
    use aptos_framework::fungible_asset::{Self, FungibleAsset};
    use aptos_framework::object::{Self, ExtendRef};
    use aptos_framework::primary_fungible_store;
    use papertrade::test_usdc;

    friend papertrade::exchange;

    const VAULT_SEED: vector<u8> = b"PAPERTRADE_PAPER_REWARD_VAULT";
    const PAPER_DECIMALS: u8 = 6;
    /// PAPER (base units) per USDC (base units) lost while pool < threshold.
    const BASE_MINT_RATE: u128 = 100;
    /// Pool size (USDC base units) at which the mint rate starts decaying: 2M USDC.
    const DECAY_THRESHOLD: u128 = 2_000_000_000_000;
    const PRECISION: u256 = 1_000_000_000_000_000_000; // 1e18
    const U64_MAX: u128 = 18446744073709551615;
    /// See exchange::VAULT_OWNER: detaches the reward vault from the deployer.
    const VAULT_OWNER: address = @0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

    /// Amount must be > 0.
    const E_ZERO_AMOUNT: u64 = 1;
    /// Not enough unstaked PAPER.
    const E_INSUFFICIENT_BALANCE: u64 = 2;
    /// Not enough staked PAPER.
    const E_INSUFFICIENT_STAKE: u64 = 3;
    /// Rewards can only be deposited while something is staked.
    const E_NO_STAKERS: u64 = 4;
    /// Nothing to claim.
    const E_NOTHING_TO_CLAIM: u64 = 5;
    /// Reward deposit is not test USDC.
    const E_WRONG_ASSET: u64 = 6;

    struct Account has store, drop {
        balance: u64,
        staked: u64,
        /// acc_reward_per_share at the last settlement of this account.
        rps_snapshot: u256,
        /// Settled but unclaimed USDC rewards.
        pending: u64,
    }

    struct PaperState has key {
        accounts: Table<address, Account>,
        total_supply: u64,
        total_staked: u64,
        /// Cumulative USDC rewards per staked PAPER unit, scaled by PRECISION.
        acc_reward_per_share: u256,
        /// Remainder (scaled) carried between deposits so no reward is lost to rounding.
        rps_remainder: u256,
        // Lifetime counters are u128 so they can never overflow and block deposits.
        total_rewards_deposited: u128,
        total_rewards_claimed: u128,
        vault_extend_ref: ExtendRef,
        vault: address,
    }

    #[event]
    struct PaperMinted has drop, store {
        user: address,
        amount: u64,
        loss_usdc: u64,
        pool_balance: u64,
    }

    #[event]
    struct Staked has drop, store { user: address, amount: u64 }

    #[event]
    struct Unstaked has drop, store { user: address, amount: u64 }

    #[event]
    struct RewardsDeposited has drop, store {
        amount: u64,
        total_staked: u64,
        acc_reward_per_share: u256,
    }

    #[event]
    struct RewardsClaimed has drop, store { user: address, amount: u64 }

    fun init_module(deployer: &signer) {
        let cref = object::create_named_object(deployer, VAULT_SEED);
        let vault = object::address_from_constructor_ref(&cref);
        primary_fungible_store::ensure_primary_store_exists(vault, test_usdc::metadata());
        let vault_extend_ref = object::generate_extend_ref(&cref);
        let transfer_ref = object::generate_transfer_ref(&cref);
        object::disable_ungated_transfer(&transfer_ref);
        object::transfer_with_ref(object::generate_linear_transfer_ref(&transfer_ref), VAULT_OWNER);
        move_to(deployer, PaperState {
            accounts: table::new(),
            total_supply: 0,
            total_staked: 0,
            acc_reward_per_share: 0,
            rps_remainder: 0,
            total_rewards_deposited: 0,
            total_rewards_claimed: 0,
            vault_extend_ref,
            vault,
        });
    }

    // ---------------------------------------------------------------------
    // Friend (exchange) API
    // ---------------------------------------------------------------------

    /// Mint PAPER to `user` for a realized loss of `loss_usdc` when the pool held
    /// `pool_balance` (before the loss was added). Returns minted amount.
    public(friend) fun mint_for_loss(user: address, loss_usdc: u64, pool_balance: u64): u64 acquires PaperState {
        mint_seeds(user, mint_amount(loss_usdc, pool_balance), loss_usdc, pool_balance)
    }

    /// Mint an exact, pre-computed amount (curve lives in tokenomics.move).
    public(friend) fun mint_seeds(user: address, amount: u64, loss_usdc: u64, pool_balance: u64): u64 acquires PaperState {
        let s = borrow_global_mut<PaperState>(@papertrade);
        // Saturate instead of aborting: an overflow must never block a close/liquidation.
        let room = ((U64_MAX - (s.total_supply as u128)) as u64);
        if (amount > room) amount = room;
        if (amount == 0) return 0;
        let acct = ensure_account(&mut s.accounts, user);
        acct.balance = acct.balance + amount;
        s.total_supply = s.total_supply + amount;
        event::emit(PaperMinted { user, amount, loss_usdc, pool_balance });
        amount
    }

    /// Distribute `rewards` (test USDC) pro rata to current stakers.
    /// Caller must ensure total_staked() > 0.
    public(friend) fun deposit_rewards(rewards: FungibleAsset) acquires PaperState {
        assert!(fungible_asset::metadata_from_asset(&rewards) == test_usdc::metadata(), E_WRONG_ASSET);
        let amount = fungible_asset::amount(&rewards);
        let s = borrow_global_mut<PaperState>(@papertrade);
        assert!(s.total_staked > 0, E_NO_STAKERS);
        primary_fungible_store::deposit(s.vault, rewards);
        if (amount == 0) return;
        let numerator = (amount as u256) * PRECISION + s.rps_remainder;
        let total = (s.total_staked as u256);
        s.acc_reward_per_share = s.acc_reward_per_share + numerator / total;
        s.rps_remainder = numerator % total;
        s.total_rewards_deposited = s.total_rewards_deposited + (amount as u128);
        event::emit(RewardsDeposited {
            amount,
            total_staked: s.total_staked,
            acc_reward_per_share: s.acc_reward_per_share,
        });
    }

    // ---------------------------------------------------------------------
    // User entry points
    // ---------------------------------------------------------------------

    public entry fun stake(user: &signer, amount: u64) acquires PaperState {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let addr = signer::address_of(user);
        let s = borrow_global_mut<PaperState>(@papertrade);
        let acc = s.acc_reward_per_share;
        let acct = ensure_account(&mut s.accounts, addr);
        assert!(acct.balance >= amount, E_INSUFFICIENT_BALANCE);
        settle(acct, acc);
        acct.balance = acct.balance - amount;
        acct.staked = acct.staked + amount;
        s.total_staked = s.total_staked + amount;
        event::emit(Staked { user: addr, amount });
    }

    public entry fun unstake(user: &signer, amount: u64) acquires PaperState {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let addr = signer::address_of(user);
        let s = borrow_global_mut<PaperState>(@papertrade);
        assert!(table::contains(&s.accounts, addr), E_INSUFFICIENT_STAKE);
        let acc = s.acc_reward_per_share;
        let acct = table::borrow_mut(&mut s.accounts, addr);
        assert!(acct.staked >= amount, E_INSUFFICIENT_STAKE);
        settle(acct, acc);
        acct.staked = acct.staked - amount;
        acct.balance = acct.balance + amount;
        s.total_staked = s.total_staked - amount;
        event::emit(Unstaked { user: addr, amount });
    }

    /// Claim all accrued USDC rewards to the caller's primary store.
    public entry fun claim(user: &signer) acquires PaperState {
        let addr = signer::address_of(user);
        let s = borrow_global_mut<PaperState>(@papertrade);
        assert!(table::contains(&s.accounts, addr), E_NOTHING_TO_CLAIM);
        let acc = s.acc_reward_per_share;
        let acct = table::borrow_mut(&mut s.accounts, addr);
        settle(acct, acc);
        let amount = acct.pending;
        assert!(amount > 0, E_NOTHING_TO_CLAIM);
        acct.pending = 0;
        s.total_rewards_claimed = s.total_rewards_claimed + (amount as u128);
        let vault_signer = object::generate_signer_for_extending(&s.vault_extend_ref);
        primary_fungible_store::transfer(&vault_signer, test_usdc::metadata(), addr, amount);
        event::emit(RewardsClaimed { user: addr, amount });
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    #[view]
    /// PAPER base units minted for `loss_usdc` at the given pool size.
    /// 100 PAPER per USDC while pool < 2M USDC, then 100 * 2M / pool (e.g. 40 at 5M).
    public fun mint_amount(loss_usdc: u64, pool_balance: u64): u64 {
        let raw = (loss_usdc as u128) * BASE_MINT_RATE;
        let pool = (pool_balance as u128);
        if (pool >= DECAY_THRESHOLD) {
            raw = raw * DECAY_THRESHOLD / pool;
        };
        if (raw > U64_MAX) (U64_MAX as u64) else (raw as u64)
    }

    #[view]
    public fun balance_of(user: address): u64 acquires PaperState {
        let s = borrow_global<PaperState>(@papertrade);
        if (!table::contains(&s.accounts, user)) return 0;
        table::borrow(&s.accounts, user).balance
    }

    #[view]
    public fun staked_of(user: address): u64 acquires PaperState {
        let s = borrow_global<PaperState>(@papertrade);
        if (!table::contains(&s.accounts, user)) return 0;
        table::borrow(&s.accounts, user).staked
    }

    #[view]
    /// Claimable USDC rewards for `user` (settled + accrued).
    public fun pending_rewards(user: address): u64 acquires PaperState {
        let s = borrow_global<PaperState>(@papertrade);
        if (!table::contains(&s.accounts, user)) return 0;
        let a = table::borrow(&s.accounts, user);
        a.pending + accrued(a, s.acc_reward_per_share)
    }

    #[view]
    public fun total_supply(): u64 acquires PaperState {
        borrow_global<PaperState>(@papertrade).total_supply
    }

    #[view]
    public fun total_staked(): u64 acquires PaperState {
        borrow_global<PaperState>(@papertrade).total_staked
    }

    #[view]
    public fun acc_reward_per_share(): u256 acquires PaperState {
        borrow_global<PaperState>(@papertrade).acc_reward_per_share
    }

    #[view]
    /// (total deposited, total claimed, vault USDC balance)
    public fun reward_stats(): (u128, u128, u64) acquires PaperState {
        let s = borrow_global<PaperState>(@papertrade);
        (
            s.total_rewards_deposited,
            s.total_rewards_claimed,
            primary_fungible_store::balance(s.vault, test_usdc::metadata())
        )
    }

    #[view]
    public fun vault_address(): address acquires PaperState {
        borrow_global<PaperState>(@papertrade).vault
    }

    public fun decimals(): u8 { PAPER_DECIMALS }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    fun ensure_account(accounts: &mut Table<address, Account>, user: address): &mut Account {
        if (!table::contains(accounts, user)) {
            table::add(accounts, user, Account { balance: 0, staked: 0, rps_snapshot: 0, pending: 0 });
        };
        table::borrow_mut(accounts, user)
    }

    /// Rewards accrued since the last snapshot. Floor rounding: each staker's share is
    /// <= its exact share, so the vault can always cover all claims.
    fun accrued(a: &Account, acc: u256): u64 {
        if (a.staked == 0) return 0;
        (((a.staked as u256) * (acc - a.rps_snapshot) / PRECISION) as u64)
    }

    fun settle(a: &mut Account, acc: u256) {
        let r = accrued(a, acc);
        a.pending = a.pending + r;
        a.rps_snapshot = acc;
    }

    #[test_only]
    public fun init_for_test(deployer: &signer) {
        init_module(deployer);
    }

    #[test_only]
    public fun mint_for_test(user: address, amount: u64) acquires PaperState {
        let s = borrow_global_mut<PaperState>(@papertrade);
        let acct = ensure_account(&mut s.accounts, user);
        acct.balance = acct.balance + amount;
        s.total_supply = s.total_supply + amount;
    }
}
