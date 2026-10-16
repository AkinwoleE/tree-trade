import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, Ed25519PrivateKey, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";
import { parse } from "yaml";

const fromKey = (key: string) =>
  Account.fromPrivateKey({
    privateKey: new Ed25519PrivateKey(PrivateKey.formatPrivateKey(key.trim(), PrivateKeyVariants.Ed25519)),
  });

/**
 * Keeper signer from KEEPER_PRIVATE_KEY, or from an Aptos CLI profile
 * (APTOS_PROFILE, default "default") in APTOS_CONFIG_PATH or the first
 * .aptos/config.yaml found in ./, ../move, ../, ~.
 */
export function loadKeeperAccount(): { account?: Account; from: string } {
  if (process.env.KEEPER_PRIVATE_KEY) return { account: fromKey(process.env.KEEPER_PRIVATE_KEY), from: "KEEPER_PRIVATE_KEY" };

  const profile = process.env.APTOS_PROFILE || "default";
  const candidates = process.env.APTOS_CONFIG_PATH
    ? [resolve(process.env.APTOS_CONFIG_PATH)]
    : [".", "../move", "..", homedir()].map((d) => resolve(join(d, ".aptos", "config.yaml")));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const cfg = parse(readFileSync(path, "utf8")) as { profiles?: Record<string, { private_key?: string }> };
    const key = cfg?.profiles?.[profile]?.private_key;
    if (key) return { account: fromKey(key), from: `${path} [${profile}]` };
  }
  return { from: "none" };
}
