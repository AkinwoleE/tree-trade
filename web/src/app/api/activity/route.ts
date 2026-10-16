import { getActivity } from "@/lib/activity-server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getActivity(), { headers: { "cache-control": "s-maxage=30, stale-while-revalidate=120" } });
  } catch {
    return Response.json({ error: "activity unavailable" }, { status: 503 });
  }
}
