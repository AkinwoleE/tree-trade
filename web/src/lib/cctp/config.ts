// Circle CCTP V2 testnet config. Sources: developers.circle.com/cctp/references/aptos-packages,
// /cctp/references/contract-addresses, /stablecoins/usdc-contract-addresses.
export const APTOS_DOMAIN = 9;
export const APTOS_TESTNET_USDC = "0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832";
export const IRIS_SANDBOX = "https://iris-api-sandbox.circle.com";
export const EVM_TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const;
export const FINALITY_STANDARD = 2000; // Aptos destination supports standard transfers

export type EvmSource = { key: string; name: string; chainId: number; domain: number; usdc: `0x${string}`; rpc: string; explorer: string; faucetHint: string };
export const EVM_SOURCES: EvmSource[] = [
  { key: "sepolia", name: "Ethereum Sepolia", chainId: 11155111, domain: 0, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io/tx/", faucetHint: "faucet.circle.com" },
  { key: "base-sepolia", name: "Base Sepolia", chainId: 84532, domain: 6, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org/tx/", faucetHint: "faucet.circle.com" },
  { key: "arbitrum-sepolia", name: "Arbitrum Sepolia", chainId: 421614, domain: 3, usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", rpc: "https://sepolia-rollup.arbitrum.io/rpc", explorer: "https://sepolia.arbiscan.io/tx/", faucetHint: "faucet.circle.com" },
];
