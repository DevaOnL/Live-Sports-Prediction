import { evaluateForecast, inputHash } from "../forecast/engine";
import { MODEL_VERSION, type ForecastInput, type ForecastResult, type HistoryAppearance, type Metric, type Position } from "../forecast/types";
import { COVERAGE } from "../ingestion/coverage";
import { cutoffUtc, localDate } from "../ingestion/standings";

export const FROZEN_EVALUATION = Object.freeze({
  holdoutStart: "2026-10-01",
  holdoutEnd: "2026-11-09",
  modelVersion: MODEL_VERSION,
  inputCutoff: "00:00 on the target competition-local date; strictly earlier local dates only",
  sourceMode: "retrospectively corrected canonical data; historical roster observations remain required",
  positionGrouping: "retrospectively corrected canonical position",
  ratingBaseline: "arithmetic mean of the five provider ratings",
  statisticBaseline: "arithmetic mean of the five individual per-90 rates",
  additionalStatisticBaseline: "pooled unweighted per-90 rate",
  additionalGoalsBaseline: "constant zero",
});

export type BacktestCase = { input: ForecastInput; target: HistoryAppearance };
export type EvaluationSource = { snapshotAt: string; sourceOrdinal: string; latestRetrievedAt: string | null };
export type EvaluationOutput = "rating" | Metric;
export type BaselineName = "ratingMean" | "arithmeticIndividualPer90" | "pooledPer90" | "goalZero";
export type ReasonCount = { code: string; count: number };
export type ErrorSummary = { count: number; mae: number | null; medianAbsoluteError: number | null };
export type EvaluationCohort = {
  leagueId: "all" | "153" | "164";
  position: "all" | Position;
  output: EvaluationOutput;
  unit: "0–10 rating" | "events per 90 minutes";
  candidateTargets: number;
  eligibleTargets: number;
  targetValueAvailable: number;
  scored: number;
  unscoredEligible: number;
  coverage: number | null;
  targetExclusions: ReasonCount[];
  exclusions: ReasonCount[];
  errors: { heuristic: ErrorSummary; baselines: Partial<Record<BaselineName, ErrorSummary>> };
};
export type EvaluationReport = {
  schemaVersion: 1;
  protocol: typeof FROZEN_EVALUATION;
  source: EvaluationSource;
  inputRows: number;
  candidateTargets: number;
  eligibleTargets: number;
  scoredTargetCases: number;
  rejectedRows: ReasonCount[];
  coverageDenominator: "eligible target appearances, including unavailable target metrics";
  reasonCounts: "nonexclusive; each reason counted at most once per case and output";
  cohorts: EvaluationCohort[];
};
export type CaseAudit = {
  playerId: string;
  fixtureId: string;
  cutoffAt: string;
  targetLocalDate: string | null;
  inputHash: string | null;
  selectedFixtureIds: string[];
  selectedTargetFixtureId: string | null;
  targetEligible: boolean;
  rejectedReasons: string[];
  outputs: { output: EvaluationOutput; scored: boolean; reasons: string[] }[];
};

const POSITION_OUTPUTS: Record<Position, readonly EvaluationOutput[]> = {
  FWD: ["rating", "goals", "assists", "shotsOnTarget"],
  MID: ["rating", "assists", "keyPasses", "tackles"],
  DEF: ["rating", "tackles", "interceptions"],
  GK: ["rating", "saves", "goalsConceded"],
  UNKNOWN: ["rating"],
};
const OUTPUT_ORDER: readonly EvaluationOutput[] = ["rating", "goals", "assists", "shotsOnTarget", "keyPasses", "tackles", "interceptions", "saves", "goalsConceded"];
const POSITION_ORDER: readonly ("all" | Position)[] = ["all", "GK", "DEF", "MID", "FWD", "UNKNOWN"];
const MAX_INTEGER = 2_147_483_647;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_INTEGER;
const validRating = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10;
const instant = (value: string | null) => value === null ? NaN : Date.parse(value);
const uniqueReasons = (codes: readonly string[]) => [...new Set(codes.map((code) => /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "unavailable_reason"))].sort(compare);
const competition = (leagueId: string) => leagueId === "153" ? "championship" : "ligue_2";

function addReasons(counts: Map<string, number>, codes: readonly string[]) {
  for (const code of uniqueReasons(codes)) counts.set(code, (counts.get(code) ?? 0) + 1);
}

function reasonCounts(counts: Map<string, number>): ReasonCount[] {
  return [...counts].sort(([a], [b]) => compare(a, b)).map(([code, count]) => ({ code, count }));
}

function summarize(errors: readonly number[]): ErrorSummary {
  if (!errors.length) return { count: 0, mae: null, medianAbsoluteError: null };
  const sorted = [...errors].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: errors.length,
    mae: errors.reduce((sum, value) => sum + value, 0) / errors.length,
    medianAbsoluteError: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
  };
}

function baselineNames(output: EvaluationOutput): BaselineName[] {
  return output === "rating" ? ["ratingMean"] : output === "goals"
    ? ["arithmeticIndividualPer90", "pooledPer90", "goalZero"]
    : ["arithmeticIndividualPer90", "pooledPer90"];
}

function targetEligibility(target: HistoryAppearance): string[] {
  const reasons: string[] = [];
  if (target.status !== "final") reasons.push("target_not_final");
  if (target.participation !== "played") reasons.push("target_not_played");
  if (!target.membershipKnown || !target.clubId || ![target.homeClubId, target.awayClubId].includes(target.clubId)) reasons.push("target_membership_unknown");
  if (!validCount(target.minutes)) reasons.push(target.minutes === null ? "target_minutes_missing" : "target_minutes_invalid");
  else if (target.minutes < 60) reasons.push("target_minutes_below_60");
  return uniqueReasons(reasons);
}

/** Inputs are supplied by a read-only adapter; outcomes never repair missing input evidence. */
function inputValidation(input: ForecastInput, target: HistoryAppearance, date: string, expectedCutoff: string): string[] {
  const reasons: string[] = [];
  if (instant(input.cutoffAt) !== instant(expectedCutoff)) reasons.push("cutoff_mismatch");
  if (input.currentClub && (input.currentClub.clubId !== target.clubId || input.currentClub.leagueId !== target.leagueId || input.currentClub.season !== target.season)) {
    reasons.push("target_club_mismatch");
  }
  for (const appearance of input.appearances) {
    if (!appearance.covered) continue;
    const coverage = COVERAGE.find((item) => item.id === appearance.leagueId && item.season === appearance.season);
    if (!coverage || appearance.competition !== competition(appearance.leagueId)) { reasons.push("invalid_history_coverage"); continue; }
    const kickoff = instant(appearance.kickoffAt);
    if (Number.isFinite(kickoff) && (kickoff >= instant(expectedCutoff) || localDate(appearance.kickoffAt!, coverage.timezone) >= date)) {
      reasons.push("invalid_history_chronology");
    }
  }
  // Gaps have no competition identifier. A known instant must at least precede
  // the shared freeze; unknown instants remain gaps for the unchanged engine.
  if (input.gaps.some((gap) => Number.isFinite(instant(gap.kickoffAt)) && instant(gap.kickoffAt) >= instant(expectedCutoff))) {
    reasons.push("invalid_history_chronology");
  }
  return uniqueReasons(reasons);
}

function contextValidation(input: ForecastInput, result: ForecastResult, expectedCutoff: string): string[] {
  const reasons: string[] = [];
  for (const selected of result.selected) {
    const appearance = input.appearances.find((item) => item.fixtureId === selected.fixtureId);
    if (!appearance?.context || !appearance.kickoffAt) continue;
    const coverage = COVERAGE.find((item) => item.id === appearance.leagueId && item.season === appearance.season);
    if (coverage && instant(appearance.context.cutoffAt) !== instant(cutoffUtc(localDate(appearance.kickoffAt, coverage.timezone), coverage.timezone))) {
      reasons.push("invalid_context_cutoff");
    }
  }
  const target = input.targets.find((item) => item.fixtureId === result.target?.fixtureId);
  if (target?.context && instant(target.context.cutoffAt) !== instant(expectedCutoff)) reasons.push("invalid_target_context_cutoff");
  return uniqueReasons(reasons);
}

function targetMetadataMatches(input: ForecastInput, result: ForecastResult, observed: HistoryAppearance): boolean {
  const target = input.targets.find((item) => item.fixtureId === result.target?.fixtureId);
  return Boolean(target && target.leagueId === observed.leagueId && target.season === observed.season
    && target.competition === observed.competition && instant(target.kickoffAt) === instant(observed.kickoffAt)
    && target.homeClubId === observed.homeClubId && target.awayClubId === observed.awayClubId);
}

function predictions(input: ForecastInput, result: ForecastResult, output: EvaluationOutput): Partial<Record<BaselineName, number>> | null {
  const selected = result.selected.map((item) => input.appearances.filter((appearance) => appearance.fixtureId === item.fixtureId));
  if (selected.length !== 5 || selected.some((items) => items.length !== 1)) return null;
  const history = selected.map((items) => items[0]);
  if (output === "rating") {
    if (!history.every((item) => validRating(item.rating))) return null;
    return { ratingMean: history.reduce((sum, item) => sum + item.rating!, 0) / 5 };
  }
  if (!history.every((item) => validCount(item.metrics[output]) && validCount(item.minutes) && item.minutes >= 60)) return null;
  return {
    arithmeticIndividualPer90: history.reduce((sum, item) => sum + 90 * item.metrics[output]! / item.minutes!, 0) / 5,
    pooledPer90: 90 * history.reduce((sum, item) => sum + item.metrics[output]!, 0) / history.reduce((sum, item) => sum + item.minutes!, 0),
    ...(output === "goals" ? { goalZero: 0 } : {}),
  };
}

type Accumulator = {
  cohort: Omit<EvaluationCohort, "unscoredEligible" | "coverage" | "targetExclusions" | "exclusions" | "errors">;
  targetExclusions: Map<string, number>;
  exclusions: Map<string, number>;
  heuristic: number[];
  baselines: Partial<Record<BaselineName, number[]>>;
};

/** Pure paired scoring. The returned audit is private; only `report` is publishable. */
export function evaluateBacktest(cases: readonly BacktestCase[], source: EvaluationSource): { report: EvaluationReport; audit: CaseAudit[] } {
  if (!Number.isFinite(instant(source.snapshotAt)) || (source.latestRetrievedAt !== null && !Number.isFinite(instant(source.latestRetrievedAt))) || !/^\d+$/.test(source.sourceOrdinal)) {
    throw new RangeError("Invalid evaluation source metadata.");
  }
  const seen = new Set<string>();
  const accumulators = new Map<string, Accumulator>();
  const rejected = new Map<string, number>();
  const audit: CaseAudit[] = [];
  let candidateTargets = 0;
  let eligibleTargets = 0;
  let scoredTargetCases = 0;
  const ordered = [...cases].sort((a, b) => compare(a.input.player.id, b.input.player.id) || compare(a.target.fixtureId, b.target.fixtureId));
  for (const { input, target } of ordered) {
    const caseKey = JSON.stringify([input.player.id, target.fixtureId]);
    if (seen.has(caseKey)) throw new RangeError("Duplicate evaluation case.");
    seen.add(caseKey);
    const record: CaseAudit = { playerId: input.player.id, fixtureId: target.fixtureId, cutoffAt: input.cutoffAt,
      targetLocalDate: null, inputHash: null, selectedFixtureIds: [], selectedTargetFixtureId: null,
      targetEligible: false, rejectedReasons: [], outputs: [] };
    audit.push(record);
    const coverage = COVERAGE.find((item) => item.id === target.leagueId && item.season === target.season);
    const scopeReasons: string[] = [];
    if (!coverage || !target.covered || target.competition !== competition(target.leagueId)) scopeReasons.push("target_outside_coverage");
    if (!Number.isFinite(instant(target.kickoffAt))) scopeReasons.push("target_kickoff_unknown");
    if (coverage && Number.isFinite(instant(target.kickoffAt))) {
      record.targetLocalDate = localDate(target.kickoffAt!, coverage.timezone);
      if (record.targetLocalDate < FROZEN_EVALUATION.holdoutStart || record.targetLocalDate > FROZEN_EVALUATION.holdoutEnd) scopeReasons.push("target_outside_holdout");
    }
    if (scopeReasons.length) {
      record.rejectedReasons = uniqueReasons(scopeReasons);
      addReasons(rejected, record.rejectedReasons);
      continue;
    }
    candidateTargets++;
    const targetReasons = targetEligibility(target);
    const targetEligible = targetReasons.length === 0;
    record.targetEligible = targetEligible;
    if (targetEligible) eligibleTargets++;
    const expectedCutoff = cutoffUtc(record.targetLocalDate!, coverage!.timezone);
    const validation = inputValidation(input, target, record.targetLocalDate!, expectedCutoff);
    let result: ForecastResult | null = null;
    if (Number.isFinite(instant(input.cutoffAt))) {
      result = evaluateForecast(input);
      record.inputHash = inputHash(input, result);
      record.selectedFixtureIds = result.selected.map((item) => item.fixtureId);
      record.selectedTargetFixtureId = result.target?.fixtureId ?? null;
      validation.push(...contextValidation(input, result, expectedCutoff));
      if (result.target?.fixtureId !== target.fixtureId) validation.push("target_selection_mismatch");
      else if (!targetMetadataMatches(input, result, target)) validation.push("target_metadata_mismatch");
    } else validation.push("invalid_input_cutoff");
    let scoredAny = false;
    for (const output of POSITION_OUTPUTS[input.player.position]) {
      const actualValue = output === "rating" ? target.rating : target.metrics[output];
      const validActual = output === "rating" ? validRating(actualValue) : validCount(actualValue);
      const outputReasons: string[] = [...validation];
      if (!validActual) outputReasons.push(actualValue === null ? "target_metric_missing" : "target_metric_invalid");
      const estimate = result ? output === "rating" ? result.forecastRating : result.projected90[output] : undefined;
      if (!estimate || estimate.status !== "available" || typeof estimate.value !== "number" || !Number.isFinite(estimate.value)) {
        outputReasons.push("model_output_unavailable", ...(estimate?.reasons.map((reason) => reason.code) ?? []));
      }
      const baselines = result ? predictions(input, result, output) : null;
      if (!baselines) outputReasons.push("baseline_inputs_unavailable");
      const exclusionReasons = uniqueReasons(outputReasons);
      const scored = targetEligible && exclusionReasons.length === 0;
      record.outputs.push({ output, scored, reasons: uniqueReasons([...targetReasons, ...exclusionReasons]) });
      if (scored) scoredAny = true;
      for (const [leagueId, position] of [["all", "all"], [target.leagueId, "all"], ["all", input.player.position], [target.leagueId, input.player.position]] as const) {
        const key = JSON.stringify([leagueId, position, output]);
        let accumulator = accumulators.get(key);
        if (!accumulator) {
          accumulator = {
            cohort: { leagueId: leagueId as EvaluationCohort["leagueId"], position, output,
              unit: output === "rating" ? "0–10 rating" : "events per 90 minutes",
              candidateTargets: 0, eligibleTargets: 0, targetValueAvailable: 0, scored: 0 },
            targetExclusions: new Map(), exclusions: new Map(), heuristic: [],
            baselines: Object.fromEntries(baselineNames(output).map((name) => [name, []])),
          };
          accumulators.set(key, accumulator);
        }
        accumulator.cohort.candidateTargets++;
        if (!targetEligible) addReasons(accumulator.targetExclusions, targetReasons);
        else {
          accumulator.cohort.eligibleTargets++;
          if (validActual) accumulator.cohort.targetValueAvailable++;
          if (!scored) addReasons(accumulator.exclusions, exclusionReasons);
          else {
            accumulator.cohort.scored++;
            const actual = output === "rating" ? actualValue! : 90 * actualValue! / target.minutes!;
            accumulator.heuristic.push(Math.abs(estimate!.value! - actual));
            for (const name of baselineNames(output)) accumulator.baselines[name]!.push(Math.abs(baselines![name]! - actual));
          }
        }
      }
    }
    if (scoredAny) scoredTargetCases++;
  }
  const cohorts = [...accumulators.values()].map(({ cohort, targetExclusions, exclusions, heuristic, baselines }): EvaluationCohort => ({
    ...cohort, unscoredEligible: cohort.eligibleTargets - cohort.scored,
    coverage: cohort.eligibleTargets ? cohort.scored / cohort.eligibleTargets : null,
    targetExclusions: reasonCounts(targetExclusions), exclusions: reasonCounts(exclusions),
    errors: { heuristic: summarize(heuristic), baselines: Object.fromEntries(baselineNames(cohort.output).map((name) => [name, summarize(baselines[name]!)])) },
  })).sort((a, b) => compare(a.leagueId === "all" ? "" : a.leagueId, b.leagueId === "all" ? "" : b.leagueId)
    || POSITION_ORDER.indexOf(a.position) - POSITION_ORDER.indexOf(b.position) || OUTPUT_ORDER.indexOf(a.output) - OUTPUT_ORDER.indexOf(b.output));
  return {
    report: { schemaVersion: 1, protocol: FROZEN_EVALUATION, source: { ...source }, inputRows: cases.length,
      candidateTargets, eligibleTargets, scoredTargetCases, rejectedRows: reasonCounts(rejected),
      coverageDenominator: "eligible target appearances, including unavailable target metrics",
      reasonCounts: "nonexclusive; each reason counted at most once per case and output", cohorts },
    audit,
  };
}
