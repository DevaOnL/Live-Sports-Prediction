import type { ForecastInput, ForecastResult, Rank } from "../server/forecast/types";

export function selectedEvidence(input: ForecastInput, result: ForecastResult) {
  return result.selected.map((selected) => ({ selected,
    appearance: input.appearances.find((appearance) => appearance.fixtureId === selected.fixtureId),
  }));
}

export function tierLabel(rank: Rank | null, clubs: number): string {
  if (!rank || clubs < 2) return "Unknown tier";
  const tier = (value: number) => 100 * value <= 35 * clubs ? "Upper tier" : 100 * value <= 70 * clubs ? "Middle tier" : "Lower tier";
  if (rank.uncertain && tier(rank.rank) !== tier(rank.rank + rank.tiedCount - 1)) return "Uncertain tier · neutral weight";
  return tier(rank.rank);
}

export function forecastNotices(forecast: {
  evaluation: { cutoffAt: string; sourceOrdinal: string };
  result: Pick<ForecastResult, "target">;
}, source: { cutoffAt: string; sourceOrdinal: string }, now = source.cutoffAt): string[] {
  const notices: string[] = [];
  if (forecast.evaluation.sourceOrdinal !== source.sourceOrdinal) notices.push("Source data has changed since this saved forecast was evaluated. A forecast refresh may still be pending.");
  if (forecast.result.target && Date.parse(forecast.result.target.kickoffAt) <= Date.parse(now)) notices.push("The saved target kickoff has passed. These saved projections need a new evaluation before use for a future match.");
  if (Date.parse(now) - Date.parse(forecast.evaluation.cutoffAt) > 15 * 60_000) notices.push("This evaluation is over 15 minutes old. Review its evaluation time and target before using the result.");
  return notices;
}

export function comparisonNotices(comparison: {
  cutoffAt: string;
  players: { result: Pick<ForecastResult, "target"> }[];
}, now = comparison.cutoffAt): string[] {
  const notices: string[] = [];
  if (comparison.players.some(({ result }) => result.target && Date.parse(result.target.kickoffAt) <= Date.parse(now))) {
    notices.push("A target kickoff in this comparison has passed since the shared cutoff. Refresh the comparison before using its future-match projections.");
  }
  if (Date.parse(now) - Date.parse(comparison.cutoffAt) > 15 * 60_000) {
    notices.push("This comparison snapshot is over 15 minutes old. Refresh to evaluate the players together at a new cutoff; source data may also have changed.");
  }
  return notices;
}
