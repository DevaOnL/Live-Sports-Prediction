import { Comparison } from "@/components/comparison";

export default async function ComparisonPage({ searchParams }: { searchParams: Promise<{ playerId?: string | string[]; allowCrossPosition?: string }> }) {
  const query = await searchParams;
  const ids = query.playerId === undefined ? [] : Array.isArray(query.playerId) ? query.playerId : [query.playerId];
  return <Comparison key={`${ids.join(",")}:${query.allowCrossPosition ?? "false"}`} initialIds={ids} initialCrossPosition={query.allowCrossPosition === "true"} />;
}
