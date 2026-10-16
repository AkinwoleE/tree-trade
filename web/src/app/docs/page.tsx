import { SeedsCurve } from "@/components/SeedsCurve";
import Link from "next/link";

const S = ({ id, title, children }: { id: string; title: string; children: React.ReactNode }) => (
  <section id={id} className="card space-y-2 scroll-mt-4">
    <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
    <div className="space-y-2 text-sm leading-relaxed text-zinc-300">{children}</div>
  </section>
);

const TOC = [
  ["what", "What is Tree Trade?"],
  ["quick-start", "Quick start"],
  ["trades", "Trades and pricing"],
  ["oracle", "Prices and the oracle"],
  ["wins-losses", "Wins and losses"],
  ["liquidations", "Liquidations"],
  ["lp-queue", "The house pool and the payout queue"],
  ["seeds", "SEEDS emissions"],
  ["staking", "Staking rewards"],
  ["deposits", "Deposits and withdrawals"],
  ["hedge", "Hedge on Decibel"],
  ["risk", "Risk"],
  ["faq", "FAQ"],
] as const;

export default function Docs() {
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <nav className="card h-fit space-y-1 text-sm lg:sticky lg:top-4">
        {TOC.map(([id, t]) => <a key={id} href={`#${id}`} className="block text-zinc-400 hover:text-emerald-300">{t}</a>)}
      </nav>
      <div className="space-y-4">
        <S id="what" title="What is Tree Trade?">
          <p>Tree Trade by APTree is a fully on-chain BTC and ETH perpetuals exchange on Aptos (currently <b>testnet only</b>, with mock test USDC). Every trade is a synthetic swap between you and a shared house pool: no order book, no matching engine.</p>
          <p>Up to 1000× leverage, fills at a fresh signed mid price, no funding payments, no slippage within open-interest caps.</p>
        </S>
        <S id="quick-start" title="Quick start">
          <ol className="list-decimal space-y-1 pl-5">
            <li>Connect an Aptos wallet (Petra or Aptos Connect) set to <b>testnet</b>, with a little testnet APT for gas.</li>
            <li>Use the faucet in the Account panel to mint test USDC, then deposit it to your trading balance.</li>
            <li>On <Link className="underline" href="/trade/btc">Trade</Link>, pick BTC or ETH, long or short, margin (min 10 USDC) and leverage (1–1000×), and open.</li>
            <li>Close any time. Losses mint SEEDS; stake them on the <Link className="underline" href="/seeds">SEEDS</Link> page to earn USDC.</li>
          </ol>
        </S>
        <S id="trades" title="Trades and pricing">
          <p>Every open and close fills at a fresh signed mid price (see <a className="underline" href="#oracle">Prices and the oracle</a>); size does not move it.</p>
          <p>Positions are $1,000 to $10,000,000 in size (margin × leverage). Each market has independent long and short open-interest caps in asset quantity; a keeper keeps each side&apos;s cap at current open interest plus about $1B of room, rebuilding it when the room leaves the $900M–$1.1B band. An open over a side&apos;s cap is rejected.</p>
        </S>
        <S id="oracle" title="Prices and the oracle">
          <p><b>Each trade carries its own price.</b> When you open or close, the Tree Trade server signs the current BTC or ETH mid price with a dedicated price-signing key, and your transaction carries that signed price. The contract checks the signature and rejects any price more than 10 seconds old (or more than 3 seconds in the future), so a trade always fills at a price under 10 seconds old, never at an older stored price.</p>
          <p><b>Liquidations use the keeper&apos;s price.</b> The keeper pushes BTC and ETH mid prices to the on-chain oracle whenever the price moves by about 0.1%, and at least every 30 seconds. It watches open positions and, when one crosses its bust price, pushes the latest price and liquidates it. A stored price older than 60 seconds is stale and liquidations wait until a fresh one lands. A signed trade price also refreshes the stored price.</p>
          <p><b>Price-move cap.</b> Each new price, whether pushed by the keeper or carried by a trade, may only move a limited distance from the last stored price: 0.2% plus 0.02% per second since that price, never more than 10%. A bigger jump is rejected on-chain. The keeper also waits for a second reading before pushing any move over 2%.</p>
          <p><b>When the keeper is down.</b> The keeper normally maintains each side&apos;s open-interest cap. If it hasn&apos;t refreshed the caps for 15 minutes, a fixed default cap of $20M of open notional per side per market applies until it is back.</p>
        </S>
        <S id="wins-losses" title="Wins and losses">
          <p>Winning close: you get your margin back right away. Your gain first passes a 0.2 bp deadband, then an <b>asymmetric-impact haircut</b> that shrinks as the move grows: scale = 0.9 / (1 + 1/(move × 15,000) + 100,000/(10⁶ × move × P)), with P = 814.598 for BTC and 483.979 for ETH. BTC keeps about 74% of a 0.1% move and 88% of a 1% move, never more than 90%. A <b>2% win fee</b> then comes off. Losing close: nothing extra is taken from you; 2% is carved from the pool&apos;s gain on your loss. Fees are split half to SEEDS stakers (in USDC), half to the protocol, and are only paid while the payout queue is empty and the pool can cover them. While the queue is active, loss and liquidation fees are waived and win fees are not paid out.</p>
        </S>
        <S id="liquidations" title="Liquidations">
          <p>Every position has a bust price a small fixed buffer (about 5 bp of price: 0.0476% BTC, 0.0481% ETH) before the price where its equity hits zero. Crossing it is a hard bust: the whole margin is forfeited. At 100× that is a 0.953% move, at 1000× about 0.052%. The whole margin goes to the pool (2% fee on the lost margin, waived while the queue is active) and SEEDS are minted to the trader. Entry and liquidation prices are drawn on the trade chart.</p>
        </S>
        <S id="lp-queue" title="The house pool and the payout queue">
          <p>The house pool takes the other side of every trade. It starts from traders&apos; losses only: nobody can deposit into it (the original testnet seed was removed). Above a 5M USDC cap, excess is swept to SEEDS stakers.</p>
          <p>If the pool can&apos;t pay a winner in full, the unpaid part waits in a first-in, first-out queue and is paid from later losses. While anyone is queued, new winners join the back of the queue and every loss pays the queue before the pool. Queued winnings can be used as margin for new trades: a loss cancels that part of your claim, a win adds to it, and the surviving claim is paid or re-queued on close. A liquidation of such a position wipes the claim with no fee. Anyone can crank the queue from the <Link className="underline" href="/house">House</Link> page.</p>
        </S>
        <S id="seeds" title="SEEDS emissions">
          <p>SEEDS starts at zero supply: no pre-mint, no team or investor allocation, no airdrop, no vesting. It is non-transferable and minted only when a trader closes at a loss or is liquidated, straight to the trader&apos;s account in the same transaction. Nothing to claim.</p>
          <p><b>Mint basis.</b> A losing close mints on the loss after the 2% fee (the fee comes out of the pool&apos;s side, not your loss). If the payout queue is active, no fee is taken, the whole loss pays queued winners, and SEEDS mint on the full loss. A liquidation always mints on the full lost margin.</p>
          <p><b>Curve.</b> While tracked LP (pool minus queued payouts) is under 2M USDC, including when it is underwater, the rate is a flat 100 SEEDS per 1 USDC of basis. At or above 2M, the rate is 100 × (S / (S + H))², where S = 120M USDC and H is the high-water mark of LP gains earned past the 2M threshold. H only ever goes up, so payouts and staker sweeps never restore the rate: at H = 100M the rate is about 29.8 per USDC, at H = 171M about 17.</p>
          <SeedsCurve />
        </S>
        <S id="staking" title="Staking rewards">
          <p>Staked SEEDS earn USDC from the stakers&apos; half of fees and from pool excess above the cap. Staking and unstaking are instant. Rewards accrue per share and can be claimed at any time. Unstaked SEEDS earn nothing.</p>
        </S>
        <S id="deposits" title="Deposits and withdrawals">
          <p>Deposit test USDC to your trading balance to trade; withdraw free balance at any time. Margin locked in open positions can&apos;t be withdrawn until the position closes.</p>
        </S>
        <S id="hedge" title="Hedge on Decibel">
          <p>Optional. When you open a Tree Trade position with Hedge on, the Tree Trade hedger opens the opposite position on Decibel (Aptos testnet perps DEX) in your own Decibel Trading Account, sized to offset the notional, and closes it when your Tree Trade position closes or is liquidated.</p>
          <p>You grant consent on-chain with a per-market, expiring delegation, revocable at any time. The hedger can only trade the markets you delegated and can never withdraw your funds. Tree Trade never holds your keys. Decibel&apos;s minimum size and step size apply; tiny hedges are skipped and clearly shown.</p>
        </S>
        <S id="risk" title="Risk">
          <ul className="list-disc space-y-1 pl-5">
            <li>Testnet software, not audited. Test tokens have no value.</li>
            <li>Prices are signed and pushed by Tree Trade&apos;s own keeper and price-signing service, which are trusted (bounded by the on-chain age and price-move limits).</li>
            <li>At very high leverage, the price can jump past the bust price between keeper updates before a liquidation lands.</li>
            <li>Winners can wait in the payout queue when the pool is short.</li>
          </ul>
        </S>
        <S id="faq" title="FAQ">
          <p><b>Is there an order book?</b> No. You always trade against the house pool at a fresh signed mid price.</p>
          <p><b>Are there funding payments?</b> No.</p>
          <p><b>Can I transfer SEEDS?</b> No. It can only be staked and unstaked.</p>
          <p><b>Is this mainnet?</b> No, Aptos testnet only.</p>
        </S>
      </div>
    </div>
  );
}
