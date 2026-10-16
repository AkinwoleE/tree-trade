import "server-only";
/**
 * Per-role Geomi keys, each falling back to the shared key so nothing changes until a role key is set.
 *   site    : APTOS_API_KEY_SITE -> APTOS_API_KEY
 *   Decibel : DECIBEL_API_KEY    -> DECIBEL_NODE_API_KEY
 * (Box bots use APTOS_API_KEY_BOTS -> APTOS_API_KEY in keeper/src/usage.ts.)
 */
export const siteApiKey = (): string | undefined => process.env.APTOS_API_KEY_SITE || process.env.APTOS_API_KEY || undefined;
export const decibelApiKey = (): string | undefined => process.env.DECIBEL_API_KEY || process.env.DECIBEL_NODE_API_KEY || undefined;

/** In-memory per-instance request counter (served by /api/usage; the keeper logs it hourly). */
const counts = new Map<string, number>();
const since = Date.now();
export function countUpstream(kind: string) {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}
export function usageSnapshot() {
  return { since, now: Date.now(), counts: Object.fromEntries(counts) };
}
