import { Aptos, AptosConfig, Network, type InputViewFunctionData, type MoveValue } from "@aptos-labs/ts-sdk";
import { fn } from "@/config/contract";

export const NETWORK = Network.TESTNET;

/**
 * In the browser every node/indexer call goes through our /api/aptos proxy (server-side key,
 * caching, 429 backoff). On the server the SDK talks to the node directly with the key.
 */
const origin = typeof window !== "undefined" ? window.location.origin : undefined;
export const aptos = new Aptos(
  new AptosConfig(
    origin
      ? { network: NETWORK, fullnode: `${origin}/api/aptos/v1`, indexer: `${origin}/api/aptos/v1/graphql` }
      : // Server: a dedicated site key when set; otherwise the anonymous public fullnode. The shared APTOS_API_KEY
        // is not used here: while its org credit is capped every keyed call 429s (the /api/aptos proxy still tries it as a fallback).
        process.env.APTOS_API_KEY_SITE
        ? { network: NETWORK, clientConfig: { API_KEY: process.env.APTOS_API_KEY_SITE } }
        : { network: NETWORK, fullnode: "https://fullnode.testnet.aptoslabs.com/v1" },
  ),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const transient = (e: unknown) => /429|rate limit|temporarily|fetch failed|network|Unexpected token|not valid JSON|503|502/i.test(String((e as Error)?.message ?? e));

/** View call with retry + backoff on transient (rate-limit / network) errors. */
export async function view(id: string, args: InputViewFunctionData["functionArguments"] = []): Promise<MoveValue[]> {
  let err: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await aptos.view({ payload: { function: fn(id), functionArguments: args } });
    } catch (e) {
      err = e;
      if (!transient(e)) throw e;
      await sleep(400 * 2 ** i);
    }
  }
  throw err;
}
export const explorerTx = (hash: string) => `https://explorer.aptoslabs.com/txn/${hash}?network=testnet`;

export const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
