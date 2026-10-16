# SEEDS tokenomics (port of Paper Trade's PaperTokenomics)

Source: docs.papertrade.xyz (#/how/mint-curve, #/learn/paper-emissions, #/paper/overview,
#/paper/staking, #/learn/staking-dividends) + live PaperTokenomics contract
0x75174549dbBD44497D31a47E2E2D7406408d63D9 read on 2026-10-15:
flatRate=100, lpFlatThresholdUsd=$2M, tailDecayScaleUsd=$120M,
tailProgressUsd=$171,253,796, trackedLpUsd=$4,965,581, PAPER supply 7.71B
=> live rate 100*(120/291.25)^2 = 16.98 PAPER/$.

Formula (move/sources/tokenomics.move):
- tracked_lp = pool - queue_owed (signed)
- tracked_lp < threshold (incl. negative): rate = flat_rate
- else: rate = flat_rate * (S/(S+H))^2, H = tail_progress (one-way HWM of LP gain
  booked at/above threshold; payouts/sweeps never lower it)
- basis: close = loss - 2% fee (fee 0 and basis = full loss while queue active);
  liquidation = full margin. Rate is the marginal rate before the gain is booked.
Defaults identical to Paper Trade; admin can tune via tokenomics::set_params and can
only raise H via tokenomics::raise_tail_progress.
Views: exchange::seeds_rate, tokenomics::params. paper::mint_amount is legacy (unused).
