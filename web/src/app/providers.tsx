"use client";

import { AptosWalletAdapterProvider } from "@aptos-labs/wallet-adapter-react";
import type { ReactNode } from "react";
import { NETWORK } from "@/lib/chain";
import { setupAutomaticSolanaWalletDerivation } from "@aptos-labs/derived-wallet-solana";
import { setupAutomaticEthereumWalletDerivation } from "@aptos-labs/derived-wallet-ethereum";
import { Network } from "@aptos-labs/ts-sdk";

// AIP-113 derivable abstracted accounts: Phantom (Solana) and MetaMask/any EIP-6963 EVM wallet
// show up in the Aptos wallet list and sign Aptos transactions with their native keys.
if (typeof window !== "undefined") {
  setupAutomaticSolanaWalletDerivation({ defaultNetwork: Network.TESTNET });
  setupAutomaticEthereumWalletDerivation({ defaultNetwork: Network.TESTNET });
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AptosWalletAdapterProvider
      autoConnect
      dappConfig={{
        network: NETWORK,
      }}
      onError={(e) => console.error("wallet error", e)}
    >
      {children}
    </AptosWalletAdapterProvider>
  );
}
