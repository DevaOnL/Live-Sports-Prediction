import type { Player } from "../ingestion/types";

export const MODEL_VERSION = "heuristic-v1";
export const METRICS = ["goals", "assists", "shotsOnTarget", "keyPasses", "tackles", "interceptions", "saves", "goalsConceded"] as const;
export type Metric = typeof METRICS[number];
export type Position = Player["position"];
export type CompetitionCode = "premier_league" | "ligue_1" | "bundesliga" | "serie_a" | "la_liga" | "championship" | "ligue_2" | "other";
export type Reason = { code: string; fixtureId?: string; field?: string };
export type Rank = { rank: number; tiedCount: number; uncertain: boolean };
export type Context = {
  complete: boolean; clubs: number; own: Rank | null; opponent: Rank | null;
  key: string; cutoffAt: string; reasons: Reason[];
};
export type Match = {
  fixtureId: string; leagueId: string; season: string; competition: CompetitionCode;
  kickoffAt: string | null;
  status: "unknown" | "scheduled" | "live" | "final" | "postponed" | "cancelled";
  homeClubId: string; awayClubId: string;
};
export type HistoryAppearance = Match & {
  sourceProvider?: "sorare";
  covered: boolean; clubId: string | null; membershipKnown: boolean;
  participation: "unknown" | "played" | "dnp"; minutes: number | null;
  rating: number | null; metrics: Record<Metric, number | null>; context: Context | null;
};
export type EligibilityGap = Reason & { kickoffAt: string | null };
export type CurrentClub = { clubId: string; leagueId: string; season: string };
export type Target = Match & { context: Context | null };
export type ForecastInput = {
  player: { id: string; position: Position }; cutoffAt: string;
  appearances: HistoryAppearance[]; gaps: EligibilityGap[];
  currentClub: CurrentClub | null; rosterReasons: Reason[]; targets: Target[];
};
export type Output = { status: "available" | "unavailable"; value: number | null; reasons: Reason[] };
export type Selected = {
  fixtureId: string; leagueId: string; kickoffAt: string; clubId: string;
  minutes: number; rating: number | null; coefficient: number;
  z: number | null; difficulty: number | null;
};
export type ForecastResult = {
  modelVersion: string; playerId: string; cutoffAt: string;
  status: "available" | "partial" | "unavailable";
  historyStatus: "ready" | "insufficient_history" | "incomplete_history";
  reasons: Reason[]; warnings: Reason[]; selected: Selected[];
  target: { fixtureId: string; leagueId: string; kickoffAt: string; coefficient: number; z: number | null; difficulty: number | null } | null;
  adjustedFormIndex: Output; forecastRating: Output; displayedForecastRating: Output;
  projected90: Partial<Record<Metric, Output>>;
};
export type PreparedInput = {
  input: ForecastInput;
  provenance: Record<string, unknown>;
  sourceOrdinal: string;
};
export type RefreshResult = { players: number; created: number; unchanged: number; available: number; partial: number; unavailable: number };
