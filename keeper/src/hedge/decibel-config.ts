/**
 * Decibel testnet config for @decibeltrade/sdk.
 *
 * The SDK's TESTNET_CONFIG (v0.8.2) and docs.decibel.trade/developer-hub/on-chain/overview/contract-reference
 * still name package 0xe7da…1b7f, which has no modules after the 2026-10 testnet redeploy. The live package
 * (read from testnet-app.decibel.trade's bundled config, 2026-10-08) is 0xd368…7bd1. Override it with
 * DECIBEL_PACKAGE. Every derived address comes from the SDK's own helpers, so nothing is hand-computed here.
 */
import {
  TESTNET_CONFIG,
  getDlpShareAddress,
  getDlpVaultAddress,
  getPerpEngineGlobalAddress,
  getTestcAddress,
  getUsdcAddress,
  type DecibelConfig,
} from "@decibeltrade/sdk";

export const DECIBEL_TESTNET_PACKAGE = "0xd368b820fdfbfe004679cdb0facef4b920c4fc0c2c80bd2fecf3843a93427bd1";

export function decibelConfig(pkg = process.env.DECIBEL_PACKAGE || DECIBEL_TESTNET_PACKAGE): DecibelConfig {
  return {
    ...TESTNET_CONFIG,
    // Geomi MonthlyCredit exhausted (2026-10-15); anonymous api.testnet IP limits starve the hedger.
    fullnodeUrl: process.env.APTOS_FULLNODE || "https://fullnode.testnet.aptoslabs.com/v1",
    deployment: {
      ...TESTNET_CONFIG.deployment,
      package: pkg,
      usdc: getUsdcAddress(pkg).toString(),
      testc: getTestcAddress(pkg).toString(),
      perpEngineGlobal: getPerpEngineGlobalAddress(pkg).toString(),
      dlpVault: getDlpVaultAddress(pkg).toString(),
      dlpShare: getDlpShareAddress(pkg).toString(),
    },
  };
}
