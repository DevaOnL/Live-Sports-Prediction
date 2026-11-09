import type { Metric, Reason } from "@/server/forecast/types";

export const positionLabel: Record<string, string> = { GK: "Goalkeeper", DEF: "Defender", MID: "Midfielder", FWD: "Forward", UNKNOWN: "Position unknown" };
export const metricLabel: Record<Metric, string> = { goals: "Goals", assists: "Assists", shotsOnTarget: "Shots on target", keyPasses: "Key passes", tackles: "Tackles", interceptions: "Interceptions", saves: "Saves", goalsConceded: "Goals conceded" };
export function formatNumber(value: number | null | undefined, decimals = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en-GB", { maximumFractionDigits: decimals }).format(value);
}
export function formatDate(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not recorded";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(value)) + " UTC";
}
const explanations: Record<string, string> = {
  incomplete_history: "Uncertain appearances could change the five-match window.", insufficient_history: "Fewer than five confirmed appearances meet the 60-minute minimum.",
  missing_metric: "A required statistic is missing from the selected appearances.", missing_rating: "A selected appearance has no observed rating.",
  missing_next_fixture: "No confirmed future fixture is known for this player.", unknown_current_club: "The player's current club is not confirmed.",
  ambiguous_current_club: "Roster observations disagree about the player's current club.", incomplete_roster_observation: "The latest roster observation is incomplete.",
  missing_roster_observation: "A covered competition has no roster observation.", unknown_position: "The player's position is not confirmed.",
  unknown_kickoff: "An appearance has an unknown kickoff time.", unresolved_past_fixture: "A past fixture still has an unresolved status.",
  uncertain_tier: "An unresolved league-table tie uses neutral opponent strength.",
};
export function reasonText(reason: Reason | string): string {
  const item = typeof reason === "string" ? { code: reason } : reason;
  const label = explanations[item.code] ?? item.code.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
  return label + (item.field ? ` (${metricLabel[item.field as Metric] ?? item.field.replaceAll("_", " ")})` : "") + (item.fixtureId ? ` · match ${item.fixtureId}` : "");
}
