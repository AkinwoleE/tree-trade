"use client";
import { useActivity } from "@/lib/use-activity";
import { Leaderboard } from "@/components/ActivityTables";
import { Card } from "@/components/ui";

export default function LeaderboardPage() {
  const { activity, error } = useActivity();
  return (
    <Card title="Leaderboard">
      {error && <p className="text-sm text-rose-400">{error}</p>}
      {activity?.partial && <p className="text-xs text-zinc-500">Based on the most recent on-chain activity.</p>}
      <Leaderboard trades={activity?.trades ?? []} />
    </Card>
  );
}
