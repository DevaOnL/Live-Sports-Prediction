"use client";

import { formatDate, formatNumber, metricLabel, positionLabel } from "@/lib/presentation";
import type { BestStatistic, BestStatisticReason } from "@/server/scouting/highlights";
import { MetricIcon } from "./football-art";
import { useDataVisibility } from "./data-visibility";

const explanations: Record<BestStatisticReason, string> = {
  unknown_position: "The player's position is unconfirmed.",
  unknown_current_club: "The player's current club is unconfirmed.",
  unresolved_roster: "Current roster evidence is incomplete or conflicting.",
  invalid_cutoff: "The observation time could not be verified.",
  incomplete_history: "Uncertain appearances could change the five-match window.",
  insufficient_history: "Five confirmed appearances of at least 60 minutes are needed.",
  mixed_competition_window: "The latest five qualifying appearances span different leagues or seasons.",
  missing_statistics: "The relevant statistics are incomplete across the five appearances.",
  insufficient_cohort: "At least 10 eligible players in the same position, league and season are needed for comparison.",
  no_standout_statistic: "No positive statistic is recorded across the eligible metrics in these five appearances.",
  duplicate_player: "Conflicting player records prevent a reliable comparison.",
};

export function BestStatisticView({ statistic, leagueName }: { statistic: BestStatistic; leagueName?: string }) {
  const { showHidden } = useDataVisibility();
  if (statistic.status === "unavailable") return showHidden ? <section className="best-statistic best-statistic-hidden" aria-label="Best statistic">
    <p className="best-statistic-label">Best statistic</p>
    <p className="best-statistic-empty">Not recorded</p>
    <details className="provenance-details"><summary>Recorded details</summary><p>{explanations[statistic.reason]}</p></details>
  </section> : null;

  return <section className="best-statistic" aria-label="Best statistic">
    <div className="best-statistic-heading"><p className="best-statistic-label">Best statistic</p>{statistic.standout && <span className="badge best-statistic-badge">Top 20%</span>}</div>
    <div className="best-statistic-value"><MetricIcon metric={statistic.metric} size={24} /><strong>{formatNumber(statistic.total, 0)}</strong><span>{metricLabel[statistic.metric]}</span></div>
    <p className="best-statistic-window">Last 5 · {formatNumber(statistic.per90)} per 90 min</p>
    <details className="provenance-details"><summary>Statistic details</summary>
      <p>Observed total across the latest five completed league appearances of at least 60 minutes: {formatNumber(statistic.minutes, 0)} minutes played.</p>
      <p>Compared by rate per 90 minutes with {statistic.cohortSize} eligible players in the same position ({positionLabel[statistic.position].toLowerCase()}), {leagueName ?? `league ${statistic.leagueId}`}, {statistic.season}. The group includes this player.</p>
      <p>This rate ranks above at least {statistic.percentile}% of the group. Ties share the same rank.{statistic.metric === "goalsConceded" && " Fewer goals conceded is better."} The highest-ranked eligible metric is shown.</p>
      <p>As of {formatDate(statistic.cutoffAt)}. Shorter appearances and missing statistics do not become zero values.</p>
      <p className="identifier">Fixtures: {statistic.fixtureIds.join(", ")}</p>
    </details>
  </section>;
}
