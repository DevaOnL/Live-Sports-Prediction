import { selectObservedWindow } from "../forecast/engine";
import type { ForecastInput, Metric, Position } from "../forecast/types";

type KnownPosition = Exclude<Position, "UNKNOWN">;

export type BestStatisticReason =
  | "unknown_position"
  | "unknown_current_club"
  | "unresolved_roster"
  | "invalid_cutoff"
  | "incomplete_history"
  | "insufficient_history"
  | "mixed_competition_window"
  | "missing_statistics"
  | "insufficient_cohort"
  | "no_standout_statistic"
  | "duplicate_player";

export type BestStatistic = {
  status: "available";
  metric: Metric;
  total: number;
  per90: number;
  minutes: number;
  matches: 5;
  percentile: number;
  cohortSize: number;
  standout: boolean;
  leagueId: string;
  season: string;
  position: KnownPosition;
  fixtureIds: string[];
  cutoffAt: string;
} | { status: "unavailable"; reason: BestStatisticReason };

// The order also resolves a tie between a player's candidate percentiles.
const POSITION_METRICS: Record<KnownPosition, readonly Metric[]> = {
  FWD: ["goals", "assists", "shotsOnTarget"],
  MID: ["goals", "assists", "keyPasses", "tackles", "interceptions"],
  DEF: ["tackles", "interceptions", "goals", "assists"],
  GK: ["saves", "goalsConceded"],
};

type Candidate = {
  playerId: string;
  metric: Metric;
  total: number;
  minutes: number;
  percentile?: number;
  cohortSize?: number;
};
type PreparedPlayer = {
  input: ForecastInput;
  position: KnownPosition;
  fixtureIds: string[];
  minutes: number;
  candidates: Candidate[];
};

const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Compare observed rates exactly; division is reserved for the displayed value. */
function compareRates(first: Candidate, second: Candidate) {
  const left = BigInt(first.total) * BigInt(second.minutes);
  const right = BigInt(second.total) * BigInt(first.minutes);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Five-match observations, ranked only against eligible peers in the same competition. */
export function computeBestStatistics(inputs: readonly ForecastInput[]): Map<string, BestStatistic> {
  const results = new Map<string, BestStatistic>();
  const groups = new Map<string, Candidate[]>();
  const prepared: PreparedPlayer[] = [];
  const occurrences = new Map<string, number>();
  for (const input of inputs) occurrences.set(input.player.id, (occurrences.get(input.player.id) ?? 0) + 1);

  for (const input of inputs) {
    const unavailable = (reason: BestStatisticReason) => results.set(input.player.id, { status: "unavailable", reason });
    if (occurrences.get(input.player.id)! > 1) { unavailable("duplicate_player"); continue; }
    if (input.player.position === "UNKNOWN") { unavailable("unknown_position"); continue; }
    if (input.rosterReasons.length) { unavailable("unresolved_roster"); continue; }
    const club = input.currentClub;
    if (!club) { unavailable("unknown_current_club"); continue; }
    if (!Number.isFinite(Date.parse(input.cutoffAt))) { unavailable("invalid_cutoff"); continue; }
    const window = selectObservedWindow(input);
    if (!window.ready || window.selected.length !== 5) {
      unavailable(window.gaps.length ? "incomplete_history" : "insufficient_history");
      continue;
    }
    if (window.selected.some((appearance) => appearance.leagueId !== club.leagueId || appearance.season !== club.season)) {
      unavailable("mixed_competition_window");
      continue;
    }
    const minutes = window.selected.reduce((total, appearance) => total + appearance.minutes!, 0);
    const candidates: Candidate[] = [];
    for (const metric of POSITION_METRICS[input.player.position]) {
      const counts = window.selected.map((appearance) => appearance.metrics[metric]);
      if (!counts.every(validCount)) continue;
      const total = counts.reduce((sum, count) => sum + count, 0);
      if (!Number.isSafeInteger(total)) continue;
      const candidate: Candidate = { playerId: input.player.id, metric, total, minutes };
      candidates.push(candidate);
      const key = JSON.stringify([input.player.position, club.leagueId, club.season, metric]);
      const cohort = groups.get(key) ?? [];
      cohort.push(candidate);
      groups.set(key, cohort);
    }
    prepared.push({ input, position: input.player.position, minutes, fixtureIds: window.selected.map((appearance) => appearance.fixtureId), candidates });
  }

  for (const cohort of groups.values()) {
    if (cohort.length < 10) continue;
    // Worst first: all tied rates receive the same strictly-worse count.
    const direction = cohort[0].metric === "goalsConceded" ? -1 : 1;
    cohort.sort((first, second) => direction * compareRates(first, second));
    let worse = 0;
    for (let index = 0; index < cohort.length; index++) {
      if (index > 0 && compareRates(cohort[index - 1], cohort[index]) !== 0) worse = index;
      cohort[index].percentile = Math.floor(100 * worse / cohort.length);
      cohort[index].cohortSize = cohort.length;
    }
  }

  for (const player of prepared) {
    const { input, candidates } = player;
    const positive = candidates.filter((candidate) => candidate.total > 0 || candidate.metric === "goalsConceded");
    const ranked = positive.filter((candidate) => candidate.percentile !== undefined);
    let best: Candidate | undefined;
    for (const candidate of ranked) {
      if (!best || candidate.percentile! > best.percentile!) best = candidate;
    }
    if (!best) {
      results.set(input.player.id, { status: "unavailable", reason: !candidates.length ? "missing_statistics"
        : !positive.length ? "no_standout_statistic" : "insufficient_cohort" });
      continue;
    }
    results.set(input.player.id, {
      status: "available", metric: best.metric, total: best.total, per90: best.total * 90 / best.minutes,
      minutes: player.minutes, matches: 5, percentile: best.percentile!, cohortSize: best.cohortSize!,
      standout: best.percentile! >= 80, leagueId: input.currentClub!.leagueId, season: input.currentClub!.season,
      position: player.position, fixtureIds: player.fixtureIds, cutoffAt: input.cutoffAt,
    });
  }
  return results;
}
