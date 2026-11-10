import { createHash } from "node:crypto";
import { MODEL_VERSION, type CompetitionCode, type Context, type EligibilityGap, type ForecastInput, type ForecastResult, type HistoryAppearance, type Metric, type Output, type Position, type Reason, type Target } from "./types";

const MAX_INTEGER = 2_147_483_647;
const POSITION_METRICS: Record<Position, readonly Metric[]> = {
  FWD: ["goals", "assists", "shotsOnTarget"], MID: ["assists", "keyPasses", "tackles"],
  DEF: ["tackles", "interceptions"], GK: ["saves", "goalsConceded"], UNKNOWN: [],
};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const instant = (value: string | null) => value === null ? NaN : Date.parse(value);
const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_INTEGER;
const validRating = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10;

/** A stable JSON encoding: object order is irrelevant, array order remains meaningful. */
export function canonicalJson(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b)).map(([key, entry]) => [key, ordered(entry)]));
    }
    return item;
  };
  const result = JSON.stringify(ordered(value));
  if (result === undefined) throw new TypeError("Forecast inputs must be JSON values");
  return result;
}

export function competitionCoefficient(code: CompetitionCode | string): 1.5 | 2 {
  return ["premier_league", "ligue_1", "bundesliga", "serie_a", "la_liga"].includes(code) ? 2 : 1.5;
}

function reasons(items: Reason[]): Reason[] {
  return [...new Map(items.map((item) => [canonicalJson(item), item])).entries()]
    .sort(([a], [b]) => compare(a, b)).map(([, item]) => item);
}

function orderedAppearances(items: HistoryAppearance[]): HistoryAppearance[] {
  return [...items].sort((a, b) => instant(a.kickoffAt) - instant(b.kickoffAt) || compare(a.fixtureId, b.fixtureId) || compare(canonicalJson(a), canonicalJson(b)));
}

function eligibility(input: ForecastInput) {
  const cutoff = instant(input.cutoffAt);
  if (!Number.isFinite(cutoff)) throw new RangeError("Invalid forecast cutoff");
  const eligible: HistoryAppearance[] = [];
  const gaps: EligibilityGap[] = [...input.gaps];
  const seen = new Set<string>();
  for (const appearance of orderedAppearances(input.appearances.filter((item) => item.covered))) {
    if (["live", "postponed", "cancelled"].includes(appearance.status)) continue;
    const kickoff = instant(appearance.kickoffAt);
    const gap = (code: string, field?: string) => gaps.push({ code, fixtureId: appearance.fixtureId, kickoffAt: appearance.kickoffAt, ...(field ? { field } : {}) });
    if (!Number.isFinite(kickoff)) { gap("unknown_kickoff", "kickoffAt"); continue; }
    if (kickoff >= cutoff) continue;
    if (seen.has(appearance.fixtureId)) { gap("duplicate_appearance"); continue; }
    seen.add(appearance.fixtureId);
    if (appearance.status === "unknown") { gap("unknown_fixture_finality", "status"); continue; }
    if (appearance.status === "scheduled") { gap("unresolved_past_fixture", "status"); continue; }
    if (appearance.status !== "final") continue;
    if (!appearance.membershipKnown || !appearance.clubId || ![appearance.homeClubId, appearance.awayClubId].includes(appearance.clubId)) {
      gap("unknown_membership", "clubId"); continue;
    }
    if (appearance.participation === "unknown") { gap("unknown_participation", "participation"); continue; }
    if (!validCount(appearance.minutes)) { gap(appearance.minutes === null ? "unknown_minutes" : "invalid_minutes", "minutes"); continue; }
    if (appearance.participation === "dnp") {
      if (appearance.minutes !== 0) gap("conflicting_participation", "minutes");
      continue;
    }
    if (appearance.minutes >= 60) eligible.push(appearance);
  }
  const selected = orderedAppearances(eligible).slice(-5);
  const boundary = selected.length === 5 ? selected[0] : null;
  const relevant = (gap: EligibilityGap) => {
    const kickoff = instant(gap.kickoffAt);
    if (!Number.isFinite(kickoff)) return true;
    if (kickoff >= cutoff) return false;
    if (!boundary) return true;
    const difference = kickoff - instant(boundary.kickoffAt);
    return difference > 0 || (difference === 0 && (!gap.fixtureId || compare(gap.fixtureId, boundary.fixtureId) >= 0));
  };
  return { selected, gaps: gaps.filter(relevant), relevant, cutoff, boundary };
}

/** The observed five-match window, independent of forecast context and targets. */
export function selectObservedWindow(input: ForecastInput): { selected: HistoryAppearance[]; gaps: EligibilityGap[]; ready: boolean } {
  const { selected, gaps } = eligibility(input);
  return { selected, gaps, ready: selected.length === 5 && gaps.length === 0 };
}

function contextValues(context: Context | null, fixtureId: string) {
  const failures: Reason[] = [];
  const warnings: Reason[] = [];
  const invalid = (code: string) => failures.push({ code, fixtureId });
  if (!context) invalid("missing_standings_context");
  else if (!context.complete) {
    invalid("incomplete_standings_context");
    failures.push(...context.reasons);
  } else {
    const rankValid = (rank: Context["own"]) => rank !== null && Number.isSafeInteger(rank.rank) && rank.rank >= 1
      && Number.isSafeInteger(rank.tiedCount) && rank.tiedCount >= 1 && rank.rank + rank.tiedCount - 1 <= context.clubs;
    if (!Number.isSafeInteger(context.clubs) || context.clubs < 2 || !rankValid(context.own) || !rankValid(context.opponent)) invalid("invalid_standings_context");
    else {
      const tier = (rank: number) => 100 * rank <= 35 * context.clubs ? 1 : 100 * rank <= 70 * context.clubs ? 0 : -1;
      const strength = (rank: NonNullable<Context["own"]>, field: string) => {
        if (rank.uncertain && tier(rank.rank) !== tier(rank.rank + rank.tiedCount - 1)) {
          warnings.push({ code: "uncertain_tier", fixtureId, field });
          return 0;
        }
        return tier(rank.rank);
      };
      const z = strength(context.opponent!, "opponent") - strength(context.own!, "own");
      warnings.push(...context.reasons);
      return { z, difficulty: 1 + 0.1 * z, reasons: failures, warnings };
    }
  }
  return { z: null, difficulty: null, reasons: reasons(failures), warnings };
}

function selectTarget(input: ForecastInput, cutoff: number): Target | null {
  const club = input.currentClub;
  if (!club || input.rosterReasons.length) return null;
  return [...input.targets].filter((fixture) => fixture.status === "scheduled" && Number.isFinite(instant(fixture.kickoffAt))
    && instant(fixture.kickoffAt) > cutoff && fixture.leagueId === club.leagueId && fixture.season === club.season
    && [fixture.homeClubId, fixture.awayClubId].includes(club.clubId))
    .sort((a, b) => instant(a.kickoffAt) - instant(b.kickoffAt) || compare(a.fixtureId, b.fixtureId))[0] ?? null;
}

const unavailable = (items: Reason[]): Output => ({ status: "unavailable", value: null, reasons: reasons(items) });
const available = (value: number): Output => ({ status: "available", value, reasons: [] });

/** The fixed heuristic. Eligibility is resolved once, independently of every metric. */
export function evaluateForecast(input: ForecastInput): ForecastResult {
  const window = eligibility(input);
  const historyReasons: Reason[] = window.gaps.map((gap) => ({ code: gap.code, ...(gap.fixtureId ? { fixtureId: gap.fixtureId } : {}), ...(gap.field ? { field: gap.field } : {}) }));
  const historyStatus = historyReasons.length ? "incomplete_history" : window.selected.length < 5 ? "insufficient_history" : "ready";
  if (historyStatus !== "ready") historyReasons.unshift({ code: historyStatus });
  const warnings: Reason[] = [];
  const contexts = window.selected.map((appearance) => contextValues(appearance.context, appearance.fixtureId));
  for (const context of contexts) warnings.push(...context.warnings);
  const selected = window.selected.map((appearance, index) => ({
    fixtureId: appearance.fixtureId, leagueId: appearance.leagueId, kickoffAt: appearance.kickoffAt!, clubId: appearance.clubId!,
    minutes: appearance.minutes!, rating: validRating(appearance.rating) ? appearance.rating : null,
    coefficient: competitionCoefficient(appearance.competition), z: contexts[index].z, difficulty: contexts[index].difficulty,
  }));
  const targetSource = selectTarget(input, window.cutoff);
  const targetContext = targetSource ? contextValues(targetSource.context, targetSource.fixtureId) : null;
  if (targetContext) warnings.push(...targetContext.warnings);
  const target = targetSource ? {
    fixtureId: targetSource.fixtureId, leagueId: targetSource.leagueId, kickoffAt: targetSource.kickoffAt!,
    coefficient: competitionCoefficient(targetSource.competition), z: targetContext!.z, difficulty: targetContext!.difficulty,
  } : null;
  const targetReasons: Reason[] = target ? targetContext!.reasons : input.rosterReasons.length ? input.rosterReasons
    : [{ code: input.currentClub ? "no_future_fixture" : "unknown_current_club" }];
  const weightedReasons = [...historyReasons, ...contexts.flatMap((context) => context.reasons)];
  const ratingReasons = [...weightedReasons];
  for (const appearance of window.selected) {
    if (!validRating(appearance.rating)) ratingReasons.push({ code: appearance.rating === null ? "missing_metric" : "invalid_metric", fixtureId: appearance.fixtureId, field: "rating" });
  }
  const form = ratingReasons.length ? null : selected.reduce((sum, appearance) => sum + appearance.rating! * appearance.difficulty! * appearance.coefficient, 0) / 5;
  const adjustedFormIndex = form === null ? unavailable(ratingReasons) : available(100 * form / 24);
  const forecastReasons = [...ratingReasons, ...targetReasons];
  const rating = forecastReasons.length ? null : Math.max(0, Math.min(10, form! / (target!.difficulty! * target!.coefficient)));
  const forecastRating = rating === null ? unavailable(forecastReasons) : available(rating);
  const displayedForecastRating = rating === null ? unavailable(forecastReasons) : available(10 * rating);
  const projected90: ForecastResult["projected90"] = {};
  for (const metric of POSITION_METRICS[input.player.position]) {
    const missing = [...weightedReasons, ...targetReasons];
    for (const appearance of window.selected) {
      if (!validCount(appearance.metrics[metric])) missing.push({ code: appearance.metrics[metric] === null ? "missing_metric" : "invalid_metric", fixtureId: appearance.fixtureId, field: metric });
    }
    if (missing.length) projected90[metric] = unavailable(missing);
    else {
      let numerator = 0;
      let denominator = 0;
      for (let index = 0; index < selected.length; index++) {
        const appearance = selected[index];
        const weight = appearance.coefficient / (1 + Math.abs(appearance.z! - target!.z!));
        numerator += weight * window.selected[index].metrics[metric]!;
        denominator += weight * appearance.minutes;
      }
      projected90[metric] = available(90 * numerator / denominator);
    }
  }
  const positionReasons: Reason[] = input.player.position === "UNKNOWN" ? [{ code: "unknown_position", field: "position" }] : [];
  const outputs = [adjustedFormIndex, forecastRating, displayedForecastRating, ...Object.values(projected90)];
  const count = outputs.filter((output) => output.status === "available").length;
  return {
    modelVersion: MODEL_VERSION, playerId: input.player.id, cutoffAt: input.cutoffAt,
    status: count === 0 ? "unavailable" : count === outputs.length && !positionReasons.length ? "available" : "partial",
    historyStatus, reasons: reasons([...historyReasons, ...positionReasons, ...outputs.flatMap((output) => output.reasons)]),
    warnings: reasons(warnings), selected, target, adjustedFormIndex, forecastRating, displayedForecastRating, projected90,
  };
}

function semanticContext(context: Context | null) {
  if (!context) return null;
  return { complete: context.complete, clubs: context.clubs, own: context.own, opponent: context.opponent, key: context.key, reasons: reasons(context.reasons) };
}

/** Hash only evidence that can change this player's selection, outputs or availability. */
export function inputHash(input: ForecastInput, result: ForecastResult = evaluateForecast(input)): string {
  const window = eligibility(input);
  const selectedIds = new Set(window.selected.map((appearance) => appearance.fixtureId));
  const relevantAppearances = input.appearances.filter((appearance) => appearance.covered && !["live", "postponed", "cancelled"].includes(appearance.status)
    && window.relevant({ code: "evidence", fixtureId: appearance.fixtureId, kickoffAt: appearance.kickoffAt }))
    .map((appearance) => ({
      fixtureId: appearance.fixtureId, leagueId: appearance.leagueId, season: appearance.season,
      kickoffAt: appearance.kickoffAt, status: appearance.status, homeClubId: appearance.homeClubId, awayClubId: appearance.awayClubId,
      clubId: appearance.clubId, membershipKnown: appearance.membershipKnown, participation: appearance.participation, minutes: appearance.minutes,
      ...(selectedIds.has(appearance.fixtureId) ? {
        coefficient: competitionCoefficient(appearance.competition), rating: appearance.rating,
        metrics: Object.fromEntries(POSITION_METRICS[input.player.position].map((metric) => [metric, appearance.metrics[metric]])), context: semanticContext(appearance.context),
      } : {}),
    })).sort((a, b) => compare(canonicalJson(a), canonicalJson(b)));
  const target = result.target ? input.targets.find((fixture) => fixture.fixtureId === result.target!.fixtureId) : null;
  const semantic = {
    modelVersion: MODEL_VERSION, player: input.player, currentClub: input.currentClub, rosterReasons: reasons(input.rosterReasons),
    appearances: relevantAppearances,
    gaps: window.gaps.map((gap) => ({ ...gap })).sort((a, b) => compare(canonicalJson(a), canonicalJson(b))),
    target: target ? {
      fixtureId: target.fixtureId, leagueId: target.leagueId, season: target.season, kickoffAt: target.kickoffAt,
      homeClubId: target.homeClubId, awayClubId: target.awayClubId, coefficient: competitionCoefficient(target.competition), context: semanticContext(target.context),
    } : null,
    availability: { status: result.status, historyStatus: result.historyStatus, reasons: result.reasons, warnings: result.warnings },
  };
  return createHash("sha256").update(canonicalJson(semantic)).digest("hex");
}
