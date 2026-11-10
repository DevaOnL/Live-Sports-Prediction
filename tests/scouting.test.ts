import assert from "node:assert/strict";
import { test } from "node:test";
import { computeBestStatistics, type BestStatistic } from "../src/server/scouting/highlights";
import { METRICS, type ForecastInput, type HistoryAppearance, type Metric, type Position } from "../src/server/forecast/types";

function appearance(index: number, values: Partial<Record<Metric, number | null>> = {}): HistoryAppearance {
  return {
    fixtureId: String(100 + index), leagueId: "153", season: "2026/27", competition: "championship",
    kickoffAt: `2026-09-${String(index).padStart(2, "0")}T14:00:00.000Z`, status: "final",
    homeClubId: "club", awayClubId: "opponent", covered: true, clubId: "club", membershipKnown: true,
    participation: "played", minutes: 90, rating: null, context: null,
    metrics: { ...Object.fromEntries(METRICS.map((metric) => [metric, 0])) as Record<Metric, number>, ...values },
  };
}

function player(id: string, values: Partial<Record<Metric, number | null>> = {}, position: Position = "FWD"): ForecastInput {
  return {
    player: { id, position }, cutoffAt: "2026-09-20T12:00:00.000Z",
    appearances: [1, 2, 3, 4, 5].map((index) => appearance(index, values)), gaps: [],
    currentClub: { clubId: "club", leagueId: "153", season: "2026/27" }, rosterReasons: [], targets: [],
  };
}

function cohort(metric: Metric = "goals", position: Position = "FWD", size = 10) {
  return Array.from({ length: size }, (_, index) => player(String(index), { [metric]: index }, position));
}

function available(result: BestStatistic | undefined) {
  assert(result && result.status === "available", JSON.stringify(result));
  return result;
}

test("best observed statistics retain raw totals, exact five fixtures and conservative top-20 percentiles", () => {
  const inputs = cohort();
  const before = structuredClone(inputs);
  const results = computeBestStatistics(inputs);
  assert.deepEqual(available(results.get("9")), {
    status: "available", metric: "goals", total: 45, per90: 9, minutes: 450, matches: 5,
    percentile: 90, cohortSize: 10, standout: true, leagueId: "153", season: "2026/27", position: "FWD",
    fixtureIds: ["101", "102", "103", "104", "105"], cutoffAt: "2026-09-20T12:00:00.000Z",
  });
  assert.equal(available(results.get("8")).percentile, 80);
  assert.equal(available(results.get("8")).standout, true);
  assert.equal(available(results.get("7")).percentile, 70);
  assert.equal(available(results.get("7")).standout, false, "a best observed count need not be a top-20 standout");
  assert.deepEqual(inputs, before, "ranking must not change observations or source order");
});

test("tied rates never increase the strictly-worse percentile and all-tied peers stay at zero", () => {
  const inputs = cohort();
  inputs[9].appearances.forEach((row) => { row.metrics.goals = 8; });
  const results = computeBestStatistics(inputs);
  assert.equal(available(results.get("8")).percentile, 80);
  assert.equal(available(results.get("9")).percentile, 80);
  const tied = computeBestStatistics(Array.from({ length: 10 }, (_, index) => player(String(index), { goals: 2 })));
  for (const result of tied.values()) {
    assert.equal(available(result).percentile, 0);
    assert.equal(available(result).standout, false);
  }
});

test("percentiles floor fractional ranks and choose a later candidate with a stronger percentile", () => {
  const inputs = cohort("goals", "FWD", 11);
  let results = computeBestStatistics(inputs);
  assert.equal(available(results.get("8")).percentile, 72);
  assert.equal(available(results.get("8")).standout, false);
  assert.equal(available(results.get("9")).percentile, 81);
  assert.equal(available(results.get("9")).standout, true);
  inputs.forEach((input, index) => input.appearances.forEach((row) => { row.metrics.assists = index === 5 ? 20 : index; }));
  results = computeBestStatistics(inputs);
  assert.equal(available(results.get("5")).metric, "assists");
  assert.equal(available(results.get("5")).percentile, 90);
  assert.equal(available(results.get("5")).total, 100);
});

test("all-zero attacking statistics have no standout but remain eligible peers", () => {
  const inputs = Array.from({ length: 10 }, (_, index) => player(String(index)));
  let results = computeBestStatistics(inputs);
  for (const result of results.values()) assert.deepEqual(result, { status: "unavailable", reason: "no_standout_statistic" });
  inputs[0].appearances[0].metrics.goals = 1;
  results = computeBestStatistics(inputs);
  const onlyScorer = available(results.get("0"));
  assert.equal(onlyScorer.total, 1);
  assert.equal(onlyScorer.cohortSize, 10);
  assert.equal(onlyScorer.percentile, 90);
});

test("goalkeepers rank fewer goals conceded as better and zero conceded is valid", () => {
  const inputs = cohort("goalsConceded", "GK");
  const results = computeBestStatistics(inputs);
  const clean = available(results.get("0"));
  assert.equal(clean.metric, "goalsConceded");
  assert.equal(clean.total, 0);
  assert.equal(clean.percentile, 90);
  assert.equal(clean.standout, true);
  assert.equal(available(results.get("9")).percentile, 0);
});

test("normalization ranks observed rates instead of totals and preserves exact rational ties", () => {
  const inputs = cohort();
  inputs[8].appearances.forEach((row) => { row.minutes = 60; row.metrics.goals = 6; });
  inputs[9].appearances.forEach((row) => { row.minutes = 90; row.metrics.goals = 9; });
  const results = computeBestStatistics(inputs);
  assert.equal(available(results.get("8")).total, 30);
  assert.equal(available(results.get("9")).total, 45);
  assert.equal(available(results.get("8")).per90, 9);
  assert.equal(available(results.get("8")).percentile, 80);
  assert.equal(available(results.get("9")).percentile, 80);
  inputs[8].appearances[0].metrics.goals = 7;
  const changed = computeBestStatistics(inputs);
  assert.equal(available(changed.get("8")).percentile, 90, "the lower raw total can have the higher observed rate");
});

test("fractional per-90 rates are compared before display rounding", () => {
  const inputs = Array.from({ length: 10 }, (_, index) => player(String(index), { goals: 1 }));
  inputs[8].appearances[0].minutes = 91;
  inputs[9].appearances[0].minutes = 92;
  const results = computeBestStatistics(inputs);
  assert.equal(available(results.get("8")).percentile, 10);
  assert.equal(available(results.get("9")).percentile, 0);
});

test("large integer ratios keep distinct ranks when floating-point crossproducts would tie", () => {
  const inputs = cohort();
  for (const index of [8, 9]) {
    inputs[index].appearances.forEach((row) => { row.metrics.goals = 200_000_000; row.minutes = 200_000_000; });
  }
  inputs[8].appearances[0].metrics.goals = 200_000_001;
  inputs[9].appearances[0].minutes = 199_999_999;
  const results = computeBestStatistics(inputs);
  assert.equal(available(results.get("8")).percentile, 80);
  assert.equal(available(results.get("9")).percentile, 90,
    "1,000,000,000 / 999,999,999 is strictly higher than 1,000,000,001 / 1,000,000,000");
});

test("missing or invalid counts exclude only the dependent metric without converting missing to zero", () => {
  for (const invalid of [null, -1, 0.5, NaN, Infinity]) {
    const inputs = cohort();
    inputs.forEach((input, index) => input.appearances.forEach((row) => { row.metrics.assists = index; }));
    inputs[9].appearances[0].metrics.goals = invalid;
    const result = available(computeBestStatistics(inputs).get("9"));
    assert.equal(result.metric, "assists", String(invalid));
    assert.equal(result.total, 45);
    assert.equal(result.cohortSize, 10);
    assert.equal(result.percentile, 90);
  }
  const missing = cohort();
  missing[9].appearances.forEach((row) => { for (const metric of METRICS) row.metrics[metric] = null; });
  assert.deepEqual(computeBestStatistics(missing).get("9"), { status: "unavailable", reason: "missing_statistics" });
  assert.deepEqual(computeBestStatistics(missing).get("8"), { status: "unavailable", reason: "insufficient_cohort" });
});

test("short matches and confirmed DNP do not displace the window; a sixth eligible match does", () => {
  const inputs = cohort();
  const subject = inputs[9];
  subject.appearances.push({ ...appearance(6, { goals: 100 }), minutes: 59 },
    { ...appearance(7, { goals: 100 }), participation: "dnp", minutes: 0 });
  let result = available(computeBestStatistics(inputs).get("9"));
  assert.equal(result.total, 45);
  assert.deepEqual(result.fixtureIds, ["101", "102", "103", "104", "105"]);
  subject.appearances.push(appearance(8));
  result = available(computeBestStatistics(inputs).get("9"));
  assert.equal(result.total, 36, "a poor sixth eligible appearance replaces the oldest");
  assert.deepEqual(result.fixtureIds, ["102", "103", "104", "105", "108"]);
});

test("unknown participation and relevant gaps block rather than treating an unknown as DNP", () => {
  for (const change of [{ participation: "unknown" as const }, { minutes: null }, { membershipKnown: false }]) {
    const inputs = cohort();
    inputs[9].appearances.push({ ...appearance(6), ...change });
    assert.deepEqual(computeBestStatistics(inputs).get("9"), { status: "unavailable", reason: "incomplete_history" });
  }
  const inputs = cohort();
  inputs[9].gaps.push({ code: "missing_statistics", fixtureId: "missing", kickoffAt: null });
  assert.deepEqual(computeBestStatistics(inputs).get("9"), { status: "unavailable", reason: "incomplete_history" });
  inputs[9].gaps[0].kickoffAt = "2026-08-31T14:00:00Z";
  assert.equal(available(computeBestStatistics(inputs).get("9")).total, 45, "strictly older uncertainty cannot alter the selected five");
});

test("cutoff, coverage and five-appearance readiness use the forecast eligibility rule", () => {
  const inputs = cohort();
  const subject = inputs[9];
  subject.appearances.push({ ...appearance(6, { goals: 100 }), kickoffAt: subject.cutoffAt });
  assert.equal(available(computeBestStatistics(inputs).get("9")).total, 45);
  subject.appearances[0].covered = false;
  assert.deepEqual(computeBestStatistics(inputs).get("9"), { status: "unavailable", reason: "insufficient_history" });
});

test("mixed competition or season windows and unresolved current membership remain unavailable", () => {
  for (const change of [{ leagueId: "164" }, { season: "2025/26" }]) {
    const inputs = cohort();
    Object.assign(inputs[9].appearances[0], change);
    assert.deepEqual(computeBestStatistics(inputs).get("9"), { status: "unavailable", reason: "mixed_competition_window" });
  }
  const inputs = cohort();
  inputs[9].rosterReasons = [{ code: "ambiguous_current_club" }];
  assert.deepEqual(computeBestStatistics(inputs).get("9"), { status: "unavailable", reason: "unresolved_roster" });
  inputs[9].rosterReasons = [];
  inputs[9].currentClub = null;
  assert.deepEqual(computeBestStatistics(inputs).get("9"), { status: "unavailable", reason: "unknown_current_club" });
});

test("at least ten metric-eligible peers including self must share position, league and season", () => {
  assert.deepEqual(computeBestStatistics(cohort("goals", "FWD", 9)).get("8"), { status: "unavailable", reason: "insufficient_cohort" });
  const forwards = cohort();
  const defenders = cohort("tackles", "DEF").map((input) => ({ ...input, player: { ...input.player, id: `def-${input.player.id}` } }));
  forwards[9].player.position = "DEF";
  let results = computeBestStatistics([...forwards, ...defenders]);
  assert.deepEqual(results.get("8"), { status: "unavailable", reason: "insufficient_cohort" });
  assert.equal(available(results.get("def-9")).cohortSize, 11);
  forwards[9].player.position = "FWD";
  for (const change of [{ leagueId: "164" }, { season: "2025/26" }]) {
    const changed = structuredClone(forwards);
    Object.assign(changed[9].currentClub!, change);
    changed[9].appearances.forEach((row) => Object.assign(row, change));
    results = computeBestStatistics(changed);
    assert.deepEqual(results.get("8"), { status: "unavailable", reason: "insufficient_cohort" });
    assert.deepEqual(results.get("9"), { status: "unavailable", reason: "insufficient_cohort" });
  }
});

test("position candidates and tie preference are independent of input order", () => {
  for (const [position, preferred] of [["FWD", "goals"], ["MID", "goals"], ["DEF", "tackles"], ["GK", "saves"]] as const) {
    const inputs = Array.from({ length: 10 }, (_, index) => player(String(index),
      Object.fromEntries(METRICS.map((metric) => [metric, metric === "goalsConceded" ? 10 - index : index])), position));
    const forward = computeBestStatistics(inputs);
    const reverse = computeBestStatistics([...inputs].reverse());
    assert.equal(available(forward.get("9")).metric, preferred);
    assert.deepEqual(reverse.get("9"), forward.get("9"));
  }
  const midfielders = cohort("interceptions", "MID");
  assert.equal(available(computeBestStatistics(midfielders).get("9")).metric, "interceptions");
  midfielders[9].player.position = "UNKNOWN";
  assert.deepEqual(computeBestStatistics(midfielders).get("9"), { status: "unavailable", reason: "unknown_position" });
});

test("duplicate player IDs cannot inflate a cohort", () => {
  const inputs = cohort("goals", "FWD", 9);
  inputs.push(structuredClone(inputs[8]));
  const results = computeBestStatistics(inputs);
  assert.deepEqual(results.get("8"), { status: "unavailable", reason: "duplicate_player" });
  assert.deepEqual(results.get("7"), { status: "unavailable", reason: "insufficient_cohort" });
});
