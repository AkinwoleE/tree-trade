import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Serves the hedger's state file (keeper/hedge-state.json, written atomically by keeper/src/hedge/hedger.ts).
 * Read-only; contains statuses and public addresses only, never keys.
 */
export const dynamic = "force-dynamic";

const STATE_PATH = process.env.HEDGE_STATE_PATH || path.join(/*turbopackIgnore: true*/ process.cwd(), "..", "keeper", "hedge-state.json");

export async function GET() {
  try {
    const s = JSON.parse(await readFile(/*turbopackIgnore: true*/ STATE_PATH, "utf8"));
    return Response.json(
      {
        available: true,
        age: Math.max(0, Math.round((Date.now() - Number(s.updatedAt)) / 1000)),
        mode: s.mode,
        hedger: s.hedger,
        groups: s.groups ?? {},
        positions: s.positions ?? {},
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    // No local hedger state (e.g. on Vercel). Optionally proxy a published state URL; otherwise degrade:
    // the UI falls back to on-chain data (hedge requests + the Decibel position on the Trading Account).
    const url = process.env.HEDGE_STATE_URL;
    if (url) {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.ok) return Response.json(await r.json(), { headers: { "cache-control": "no-store" } });
      } catch {}
    }
    return Response.json({ available: false, limited: true, groups: {}, positions: {} }, { headers: { "cache-control": "no-store" } });
  }
}
