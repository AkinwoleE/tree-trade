import { getActivity } from "@/lib/activity-server";
import internal from "@/config/internal-accounts.json";

/** Real-user counts. Internal/test accounts (server-side list) are excluded; delegate trades already carry the owner. */
export const dynamic = "force-dynamic";

const norm = (a: string) => "0x" + String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const EXCLUDED = new Set((internal.accounts as { address: string }[]).map((a) => norm(a.address)));

export async function GET() {
  try {
    const a = await getActivity();
    const real = (o: string) => !EXCLUDED.has(norm(o));
    const closed = new Set(a.trades.map((t) => t.id));
    const day = Math.floor(Date.now() / 1000) - 86_400;
    const all = new Set<string>(), recent = new Set<string>(), openNow = new Set<string>(), excluded = new Set<string>();
    for (const o of a.opens) {
      const w = norm(o.owner);
      if (!real(w)) { excluded.add(w); continue; }
      all.add(w);
      if (o.ts >= day) recent.add(w);
      if (!closed.has(o.id)) openNow.add(w);
    }
    for (const t of a.trades) {
      const w = norm(t.owner);
      if (!real(w)) { excluded.add(w); continue; }
      all.add(w);
      if (t.ts >= day) recent.add(w);
    }
    return Response.json(
      { openNow: openNow.size, active24h: recent.size, allTime: all.size, excludedTraders: excluded.size, partial: !!a.partial, updatedAt: a.updatedAt },
      { headers: { "cache-control": "s-maxage=30, stale-while-revalidate=120" } },
    );
  } catch {
    return Response.json({ error: "stats unavailable" }, { status: 503 });
  }
}
