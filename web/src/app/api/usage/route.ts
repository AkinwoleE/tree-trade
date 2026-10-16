import { usageSnapshot } from "@/lib/api-keys";

/** Upstream (Aptos/Decibel) request counts for this server instance since it started. Approximate: one instance only. */
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(usageSnapshot(), { headers: { "cache-control": "no-store" } });
}
