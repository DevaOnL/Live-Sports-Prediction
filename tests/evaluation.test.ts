import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBacktest, FROZEN_EVALUATION, type BacktestCase, type EvaluationOutput, type EvaluationReport } from "../src/server/evaluation/scoring";
import { evaluateForecast } from "../src/server/forecast/engine";
import { METRICS, type Context, type HistoryAppearance, type Metric, type Position } from "../src/server/forecast/types";
import { cutoffUtc, localDate } from "../src/server/ingestion/standings";

const source = { snapshotAt: "2026-11-10T12:00:00.000Z", sourceOrdinal: "42", latestRetrievedAt: "2026-11-10T11:00:00.000Z" };
const timezone = (leagueId: string) => leagueId === "153" ? "Europe/London" : "Europe/Paris";

function context(kickoffAt: string, leagueId = "153", z = 0): Context {
  const clubs = leagueId === "153" ? 24 : 18;
  const middle = leagueId === "153" ? 10 : 8;
  const lower = leagueId === "153" ? 18 : 15;
  const ranks: Record<number, [number, number]> = { [-2]: [1, lower], [-1]: [middle, lower], 0: [middle, middle], 1: [middle, 1], 2: [lower, 1] };
  const [own, opponent] = ranks[z];
  return { complete: true, clubs, own: { rank: own, tiedCount: 1, uncertain: false },
    opponent: { rank: opponent, tiedCount: 1, uncertain: false }, key: `table:${leagueId}:${kickoffAt}:${z}`,
    cutoffAt: cutoffUtc(localDate(kickoffAt, timezone(leagueId)), timezone(leagueId)), reasons: [] };
}

function appearance(index: number, leagueId = "153"): HistoryAppearance {
  const kickoffAt = `2026-09-${String(index).padStart(2, "0")}T14:00:00.000Z`;
  return { fixtureId: `history-${index}`, leagueId, season: "2026/27", competition: leagueId === "153" ? "championship" : "ligue_2",
    kickoffAt, status: "final", homeClubId: "club", awayClubId: "opponent", covered: true,
    clubId: "club", membershipKnown: true, participation: "played", minutes: 90, rating: 7,
    metrics: Object.fromEntries(METRICS.map((metric) => [metric, 1])) as Record<Metric, number>, context: context(kickoffAt, leagueId) };
}

function sample(id = "player-one", position: Position = "FWD", leagueId = "153", kickoffAt = "2026-10-01T14:00:00.000Z"): BacktestCase {
  const target = { ...appearance(6, leagueId), fixtureId: `target-${id}`, kickoffAt, context: context(kickoffAt, leagueId) };
  const cutoffAt = cutoffUtc(localDate(kickoffAt, timezone(leagueId)), timezone(leagueId));
  return { target, input: { player: { id, position }, cutoffAt, appearances: [1, 2, 3, 4, 5].map((index) => appearance(index, leagueId)),
    gaps: [], currentClub: { clubId: "club", leagueId, season: "2026/27" }, rosterReasons: [],
    targets: [{ fixtureId: target.fixtureId, leagueId, season: "2026/27", competition: target.competition,
      kickoffAt, status: "scheduled", homeClubId: "club", awayClubId: "opponent", context: { ...context(kickoffAt, leagueId), cutoffAt } }] } };
}

function cohort(report: EvaluationReport, output: EvaluationOutput, leagueId: "all" | "153" | "164" = "all", position: "all" | Position = "all") {
  const value = report.cohorts.find((item) => item.output === output && item.leagueId === leagueId && item.position === position);
  assert(value, `Missing ${leagueId}/${position}/${output} cohort`);
  return value;
}

function close(actual: number | null | undefined, expected: number) {
  assert.ok(actual !== null && actual !== undefined && Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`);
}

test("frozen scoring uses unchanged 0–10 ratings and distinct arithmetic, pooled and zero statistic baselines", () => {
  const row = sample();
  const minutes = [60, 75, 90, 97, 120];
  const goals = [1, 2, 0, 1, 0];
  row.input.appearances.forEach((item, index) => {
    item.minutes = minutes[index]; item.rating = 5 + index; item.metrics.goals = goals[index];
    item.context = context(item.kickoffAt!, "153", index - 2);
  });
  row.input.targets[0].context = { ...context(row.target.kickoffAt!, "153", 2), cutoffAt: row.input.cutoffAt };
  row.target.minutes = 97; row.target.rating = 8.25; row.target.metrics.goals = 2;
  const unchanged = structuredClone(row);
  const { report, audit } = evaluateBacktest([row], source);
  const rating = cohort(report, "rating");
  close(rating.errors.heuristic.mae, 2.25);
  close(rating.errors.baselines.ratingMean!.mae, 1.25);
  assert.equal(rating.unit, "0–10 rating");
  const expectedModel = 90 * 1.8 / 343.875;
  const expectedArithmetic = goals.reduce((sum, count, index) => sum + 90 * count / minutes[index], 0) / 5;
  const expectedPooled = 90 * 4 / 442;
  const actual = 180 / 97;
  const scored = cohort(report, "goals");
  close(scored.errors.heuristic.mae, Math.abs(expectedModel - actual));
  close(scored.errors.baselines.arithmeticIndividualPer90!.mae, Math.abs(expectedArithmetic - actual));
  close(scored.errors.baselines.pooledPer90!.mae, Math.abs(expectedPooled - actual));
  close(scored.errors.baselines.goalZero!.mae, actual);
  assert.notEqual(expectedArithmetic, expectedPooled);
  assert.equal(scored.unit, "events per 90 minutes");
  assert.equal(scored.coverage, 1);
  assert.equal(scored.errors.heuristic.count, 1);
  assert.deepEqual(row, unchanged, "scoring must not change inputs or outcomes");
  assert.match(audit[0].inputHash!, /^[a-f0-9]{64}$/);
  assert.equal(audit[0].selectedFixtureIds.length, 5);
  assert.equal(audit[0].selectedTargetFixtureId, row.target.fixtureId);
});

test("zero values score while missing target metrics stay unavailable on their output only", () => {
  const zero = sample("zero");
  zero.input.appearances.forEach((item) => { item.rating = 0; item.metrics.goals = 0; });
  zero.target.rating = 0; zero.target.metrics.goals = 0;
  let report = evaluateBacktest([zero], source).report;
  close(cohort(report, "rating").errors.heuristic.mae, 0);
  close(cohort(report, "goals").errors.heuristic.mae, 0);
  zero.target.metrics.goals = null;
  report = evaluateBacktest([zero], source).report;
  const goals = cohort(report, "goals");
  assert.equal(goals.eligibleTargets, 1);
  assert.equal(goals.targetValueAvailable, 0);
  assert.equal(goals.scored, 0);
  assert.equal(goals.coverage, 0);
  assert.equal(goals.errors.heuristic.mae, null);
  assert(goals.exclusions.some((item) => item.code === "target_metric_missing"));
  assert.equal(cohort(report, "rating").scored, 1);
  assert.equal(cohort(report, "assists").scored, 1);
});

test("a missing historical statistic never changes the selected five or unpaired baseline case sets", () => {
  const row = sample();
  row.input.appearances[2].metrics.goals = null;
  const { report, audit } = evaluateBacktest([row], source);
  const goals = cohort(report, "goals");
  assert.equal(goals.scored, 0);
  assert.equal(goals.targetValueAvailable, 1);
  assert(goals.exclusions.some((item) => item.code === "missing_metric"));
  for (const summary of Object.values(goals.errors.baselines)) assert.deepEqual(summary, { count: 0, mae: null, medianAbsoluteError: null });
  assert.equal(cohort(report, "rating").scored, 1);
  assert.equal(cohort(report, "assists").scored, 1);
  assert.deepEqual(audit[0].selectedFixtureIds, row.input.appearances.map((item) => item.fixtureId));
});

test("missing historical ratings and uncertain appearances retain output-specific reasons", () => {
  const missingRating = sample("missing-rating");
  missingRating.input.appearances[0].rating = null;
  let report = evaluateBacktest([missingRating], source).report;
  assert.equal(cohort(report, "rating").scored, 0);
  assert.equal(cohort(report, "goals").scored, 1);
  const uncertain = sample("uncertain-window");
  uncertain.input.gaps.push({ code: "missing_appearance_evidence", fixtureId: "unknown-appearance", kickoffAt: "2026-09-07T14:00:00.000Z" });
  report = evaluateBacktest([uncertain], source).report;
  assert.equal(report.scoredTargetCases, 0);
  assert(cohort(report, "goals").exclusions.some((reason) => reason.code === "incomplete_history" && reason.count === 1));
  assert(cohort(report, "rating").exclusions.some((reason) => reason.code === "missing_appearance_evidence" && reason.count === 1));
});

test("invalid target ratings and decimal counts are excluded instead of becoming zero", () => {
  const row = sample();
  row.target.rating = 10.1;
  row.target.metrics.goals = 0.5;
  const report = evaluateBacktest([row], source).report;
  for (const output of ["rating", "goals"] as const) {
    const value = cohort(report, output);
    assert.equal(value.scored, 0);
    assert.equal(value.targetValueAvailable, 0);
    assert(value.exclusions.some((reason) => reason.code === "target_metric_invalid"));
  }
  assert.equal(cohort(report, "assists").scored, 1);
});

test("missing historical rosters preserve zero scoring and null errors without borrowing target membership", () => {
  const row = sample();
  row.input.currentClub = null;
  row.input.rosterReasons = [{ code: "missing_roster_observation" }, { code: "unknown_current_club" }];
  const { report, audit } = evaluateBacktest([row], source);
  assert.equal(report.eligibleTargets, 1);
  assert.equal(report.scoredTargetCases, 0);
  assert.equal(audit[0].selectedTargetFixtureId, null);
  for (const item of report.cohorts) {
    assert.equal(item.scored, 0);
    assert.equal(item.unscoredEligible, 1);
    assert.equal(item.coverage, 0);
    assert.deepEqual(item.errors.heuristic, { count: 0, mae: null, medianAbsoluteError: null });
    assert(item.exclusions.some((reason) => reason.code === "missing_roster_observation"));
    assert(item.exclusions.some((reason) => reason.code === "target_selection_mismatch"));
  }
});

test("target eligibility separately reports short, DNP, unknown and nonfinal target rows", () => {
  const changes: Partial<HistoryAppearance>[] = [
    { minutes: 59 }, { participation: "dnp", minutes: 0 }, { membershipKnown: false },
    { minutes: null }, { participation: "unknown" }, { status: "scheduled" }, { minutes: -1 },
  ];
  const rows = changes.map((change, index) => { const row = sample(`ineligible-${index}`); Object.assign(row.target, change); return row; });
  const report = evaluateBacktest(rows, source).report;
  const rating = cohort(report, "rating");
  assert.equal(report.candidateTargets, 7);
  assert.equal(report.eligibleTargets, 0);
  assert.equal(rating.candidateTargets, 7);
  assert.equal(rating.eligibleTargets, 0);
  assert.equal(rating.scored, 0);
  assert.equal(rating.coverage, null);
  assert.deepEqual(rating.exclusions, []);
  assert(rating.targetExclusions.some((reason) => reason.code === "target_minutes_below_60" && reason.count === 2));
  assert(rating.targetExclusions.some((reason) => reason.code === "target_not_played" && reason.count === 2));
  assert(rating.targetExclusions.some((reason) => reason.code === "target_minutes_missing"));
  assert(rating.targetExclusions.some((reason) => reason.code === "target_not_final"));
});

test("the forecast must select the expected fixture and the roster club must match target membership", () => {
  const wrongFixture = sample("wrong-fixture");
  wrongFixture.input.targets.unshift({ ...wrongFixture.input.targets[0], fixtureId: "earlier-fixture", kickoffAt: "2026-10-01T12:00:00.000Z" });
  const wrongClub = sample("wrong-club");
  wrongClub.input.currentClub!.clubId = "opponent";
  const { report, audit } = evaluateBacktest([wrongFixture, wrongClub], source);
  assert.equal(report.scoredTargetCases, 0);
  assert(cohort(report, "rating").exclusions.some((reason) => reason.code === "target_selection_mismatch"));
  assert(cohort(report, "rating").exclusions.some((reason) => reason.code === "target_club_mismatch"));
  assert.equal(audit.find((item) => item.playerId === "wrong-club")!.selectedTargetFixtureId, wrongClub.target.fixtureId);
});

test("an expected fixture ID cannot conceal mismatched frozen target metadata", () => {
  const row = sample();
  row.input.targets[0].kickoffAt = "2026-10-02T14:00:00.000Z";
  const { report, audit } = evaluateBacktest([row], source);
  assert.equal(audit[0].selectedTargetFixtureId, row.target.fixtureId);
  assert.equal(report.scoredTargetCases, 0);
  assert(cohort(report, "rating").exclusions.some((reason) => reason.code === "target_metadata_mismatch"));
});

test("all position groups retain only applicable outputs and corrected position/league cohorts", () => {
  const positions: Position[] = ["FWD", "MID", "DEF", "GK", "UNKNOWN"];
  const rows = positions.map((position, index) => sample(`position-${index}`, position, index % 2 ? "164" : "153"));
  const { report } = evaluateBacktest(rows, source);
  assert.equal(report.protocol.positionGrouping, "retrospectively corrected canonical position");
  assert.equal(cohort(report, "rating").scored, 5);
  assert.equal(cohort(report, "rating", "153").scored, 3);
  assert.equal(cohort(report, "rating", "164", "MID").scored, 1);
  assert.equal(cohort(report, "rating", "all", "UNKNOWN").scored, 1);
  assert.deepEqual(report.cohorts.filter((item) => item.leagueId === "all" && item.position === "GK").map((item) => item.output), ["rating", "saves", "goalsConceded"]);
  assert(!report.cohorts.some((item) => item.position === "UNKNOWN" && item.output !== "rating"));
  for (const item of report.cohorts) {
    assert.equal(item.errors.heuristic.count, item.scored);
    for (const baseline of Object.values(item.errors.baselines)) assert.equal(baseline.count, item.scored);
    assert.equal(Object.hasOwn(item.errors.baselines, "goalZero"), item.output === "goals");
    assert.equal(Object.hasOwn(item.errors.baselines, "ratingMean"), item.output === "rating");
  }
});

test("paired coverage includes unscored eligible outcomes and never gives baselines extra cases", () => {
  const available = sample("available");
  const noRoster = sample("no-roster"); noRoster.input.currentClub = null; noRoster.input.rosterReasons = [{ code: "missing_roster_observation" }];
  const noActual = sample("no-actual"); noActual.target.metrics.goals = null;
  const report = evaluateBacktest([available, noRoster, noActual], source).report;
  const goals = cohort(report, "goals");
  assert.equal(goals.eligibleTargets, 3);
  assert.equal(goals.targetValueAvailable, 2);
  assert.equal(goals.scored, 1);
  assert.equal(goals.unscoredEligible, 2);
  close(goals.coverage, 1 / 3);
  for (const baseline of Object.values(goals.errors.baselines)) assert.equal(baseline.count, 1);
});

test("median absolute errors handle even and odd paired samples without percentage claims", () => {
  const rows = [7, 8, 10].map((rating, index) => { const row = sample(`median-${index}`); row.target.rating = rating; return row; });
  let rating = cohort(evaluateBacktest(rows, source).report, "rating");
  close(rating.errors.heuristic.mae, 4 / 3);
  close(rating.errors.heuristic.medianAbsoluteError, 1);
  rating = cohort(evaluateBacktest([rows[0], rows[2]], source).report, "rating");
  close(rating.errors.heuristic.mae, 1.5);
  close(rating.errors.heuristic.medianAbsoluteError, 1.5);
});

test("holdout endpoints use competition-local dates and remain frozen", () => {
  const rows = [
    sample("start", "FWD", "153", "2026-09-30T23:30:00.000Z"),
    sample("end", "FWD", "153", "2026-11-09T23:30:00.000Z"),
    sample("before", "FWD", "153", "2026-09-30T22:30:00.000Z"),
    sample("after-paris", "FWD", "164", "2026-11-09T23:30:00.000Z"),
  ];
  const { report, audit } = evaluateBacktest(rows, source);
  assert.equal(FROZEN_EVALUATION.holdoutStart, "2026-10-01");
  assert.equal(FROZEN_EVALUATION.holdoutEnd, "2026-11-09");
  assert.equal(report.inputRows, 4);
  assert.equal(report.candidateTargets, 2);
  assert.equal(report.scoredTargetCases, 2);
  assert.deepEqual(report.rejectedRows, [{ code: "target_outside_holdout", count: 2 }]);
  assert.equal(audit.find((item) => item.playerId === "start")!.targetLocalDate, "2026-10-01");
  assert.equal(audit.find((item) => item.playerId === "after-paris")!.targetLocalDate, "2026-11-10");
});

test("local-midnight validation observes the October clock change", () => {
  const before = sample("before-clock", "FWD", "153", "2026-10-25T14:00:00.000Z");
  const after = sample("after-clock", "FWD", "153", "2026-10-26T14:00:00.000Z");
  assert.equal(before.input.cutoffAt, "2026-10-24T23:00:00.000Z");
  assert.equal(after.input.cutoffAt, "2026-10-26T00:00:00.000Z");
  assert.equal(evaluateBacktest([before, after], source).report.scoredTargetCases, 2);
  before.input.cutoffAt = "2026-10-25T00:00:00.000Z";
  const rating = cohort(evaluateBacktest([before], source).report, "rating");
  assert.equal(rating.scored, 0);
  assert(rating.exclusions.some((reason) => reason.code === "cutoff_mismatch"));
});

test("same local-date history cannot leak across the London/Paris midnight difference", () => {
  const row = sample();
  const crossLeague = { ...appearance(5, "164"), kickoffAt: "2026-09-30T22:30:00.000Z" };
  crossLeague.context = context(crossLeague.kickoffAt, "164");
  row.input.appearances[4] = crossLeague;
  assert(Date.parse(crossLeague.kickoffAt) < Date.parse(row.input.cutoffAt));
  assert.equal(localDate(crossLeague.kickoffAt, "Europe/Paris"), "2026-10-01");
  assert.equal(evaluateForecast(row.input).forecastRating.status, "available", "the adapter adds the stricter retrospective date boundary");
  const rating = cohort(evaluateBacktest([row], source).report, "rating");
  assert.equal(rating.scored, 0);
  assert(rating.exclusions.some((reason) => reason.code === "invalid_history_chronology"));
});

test("target, cutoff and later appearances cannot be supplied as historical inputs", () => {
  for (const kickoffAt of ["2026-09-30T23:00:00.000Z", "2026-10-01T14:00:00.000Z", "2026-10-02T14:00:00.000Z"]) {
    const row = sample();
    row.input.appearances.push({ ...row.target, kickoffAt });
    const rating = cohort(evaluateBacktest([row], source).report, "rating");
    assert.equal(rating.scored, 0);
    assert(rating.exclusions.some((reason) => reason.code === "invalid_history_chronology"));
  }
});

test("future standings cutoffs cannot masquerade as frozen historical or target contexts", () => {
  const historical = sample("historical-context");
  historical.input.appearances[0].context!.cutoffAt = historical.input.cutoffAt;
  const target = sample("target-context");
  target.input.targets[0].context!.cutoffAt = "2026-10-01T15:00:00.000Z";
  const report = evaluateBacktest([historical, target], source).report;
  assert.equal(report.scoredTargetCases, 0);
  assert(cohort(report, "rating").exclusions.some((reason) => reason.code === "invalid_context_cutoff"));
  assert(cohort(report, "rating").exclusions.some((reason) => reason.code === "invalid_target_context_cutoff"));
});

test("stable aggregates omit private case identities and are deterministic under input reordering", () => {
  const rows = [sample("private-case-one", "GK", "164"), sample("private-case-two", "FWD"), sample("private-case-three", "MID")];
  const first = evaluateBacktest(rows, source);
  assert.deepEqual(evaluateBacktest([...rows].reverse(), source), first);
  assert.deepEqual(JSON.parse(JSON.stringify(first.report)), first.report);
  const text = JSON.stringify(first.report);
  assert(!text.includes("private-case"));
  assert(!text.includes("inputHash") && !text.includes("fixtureId") && !text.includes("playerId"));
  assert(!text.includes("history-"));
  assert.equal(first.audit.length, 3);
  assert(first.audit.every((item) => item.inputHash !== null));
});

test("empty and rejected inputs report no fabricated measurements and duplicate cases are rejected", () => {
  const empty = evaluateBacktest([], source).report;
  assert.equal(empty.eligibleTargets, 0);
  assert.equal(empty.scoredTargetCases, 0);
  assert.deepEqual(empty.cohorts, []);
  const row = sample();
  assert.throws(() => evaluateBacktest([row, structuredClone(row)], source), /Duplicate evaluation case/);
  row.target.covered = false;
  const rejected = evaluateBacktest([row], source).report;
  assert.equal(rejected.candidateTargets, 0);
  assert.deepEqual(rejected.rejectedRows, [{ code: "target_outside_coverage", count: 1 }]);
  assert.throws(() => evaluateBacktest([], { ...source, sourceOrdinal: "invalid" }), /Invalid evaluation source metadata/);
});
