# Phantom / MetaMask accounts + Circle CCTP deposits (testnet)

## Wallets (AIP-113 derivable abstracted accounts)
`setupAutomaticSolanaWalletDerivation` / `setupAutomaticEthereumWalletDerivation` (`@aptos-labs/derived-wallet-*`, `defaultNetwork: TESTNET`) in `web/src/app/providers.tsx`. Phantom (Solana) and any EIP-6963 EVM wallet (MetaMask) show up in the Aptos wallet list. The Aptos address is derived from the wallet's key + domain. Signing uses `0x1::solana_derivable_account` / `0x1::ethereum_derivable_account`. We never touch user keys.

## Gas sponsorship (`/api/sponsor`)
Derived accounts start with 0 APT. The client builds a fee-payer transaction, the user's wallet signs it (`signTransaction`), and the server adds the fee-payer signature from a dedicated sponsor account (0x5044…528b, holding 1 testnet APT; the key is a server-only env var).
- Only entry functions in our package are sponsored (exchange, test_usdc, paper, hedge, usdc_gateway).
- Limits: max gas 20k, price ≤200, 30 tx/min per sender.
- If sponsorship is unavailable, the client falls back to a normal wallet-paid transaction.

## CCTP V2 flow (EVM testnets → Aptos testnet, domain 9)
1. **Burn.** The user's EVM wallet calls `approve` and then `TokenMessengerV2(0x8FE6…2DAA).depositForBurn(amount, 9, aptosAddr as bytes32, USDC, 0x0, maxFee 0, minFinality 2000)`. Supported sources: Sepolia (0), Arbitrum Sepolia (3), Base Sepolia (6). Aptos only supports standard transfers.
2. **Attest.** `/api/cctp/receive` polls Iris sandbox `/v2/messages/{domain}?transactionHash=`.
3. **Mint.** Once the attestation is complete and the message's destination domain is 9, the server submits Circle's precompiled `testnet/v2/receive_message.mv` script, which runs `receive_message → prepare_mint → handler::mint`.
   - The sponsor pays the gas.
   - USDC is minted to the mintRecipient that the user signed, never to us.
   - destinationCaller is 0x0, so anyone, including the user, could relay instead.
4. **Deposit.** The user calls `usdc_gateway::wrap_and_deposit` (sponsored).

The in-flight burn hash is kept in localStorage and resumes polling after a reload.

## Collateral decision
The pool, SEEDS math and faucet all run on the mock `test_usdc`. Rather than migrating the exchange, we added `papertrade::usdc_gateway`:
- Real Circle testnet USDC (`0x6909…2832`) is locked 1:1 in a keyless vault.
- In return the user gets `test_usdc`, taken from the vault float first and minted via a friend-only function only when the float runs short.
- `unwrap` returns real USDC, up to the reserve.

This keeps every existing invariant and test. Bridged users trade exactly like faucet users. Upgrade tx: 0xea5b69d3…6de2. Tests: 100/100.

## Not done
- Solana devnet source: needs the CCTP Solana program's `deposit_for_burn` (Anchor). Phantom users can bridge from Phantom's EVM account today.
- No CCTP round trip has been tested end to end with real faucet USDC. Circle's faucet is captcha-gated.
