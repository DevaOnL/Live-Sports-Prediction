import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, competitionCoefficient, evaluateForecast, inputHash, selectObservedWindow } from "../src/server/forecast/engine";
import { METRICS, type Context, type ForecastInput, type HistoryAppearance, type Metric, type Position, type Target } from "../src/server/forecast/types";

function context(own = 10, opponent = 10, clubs = 24): Context {
  return {
    complete: true, clubs, own: { rank: own, tiedCount: 1, uncertain: false },
    opponent: { rank: opponent, tiedCount: 1, uncertain: false }, key: `table:${clubs}:${own}:${opponent}`,
    cutoffAt: "2026-09-01T00:00:00.000Z", reasons: [],
  };
}

function appearance(index: number, overrides: Partial<HistoryAppearance> = {}): HistoryAppearance {
  return {
    fixtureId: String(100 + index), leagueId: "153", season: "2026/27", competition: "championship",
    kickoffAt: `2026-09-${String(index).padStart(2, "0")}T14:00:00.000Z`, status: "final",
    homeClubId: "club", awayClubId: "opponent", covered: true, clubId: "club", membershipKnown: true,
    participation: "played", minutes: 90, rating: 7,
    metrics: Object.fromEntries(METRICS.map((metric) => [metric, index])) as Record<Metric, number>,
    context: context(), ...overrides,
  };
}

function target(overrides: Partial<Target> = {}): Target {
  return {
    fixtureId: "next", leagueId: "153", season: "2026/27", competition: "championship",
    kickoffAt: "2026-10-01T14:00:00.000Z", status: "scheduled", homeClubId: "club", awayClubId: "opponent",
    context: context(), ...overrides,
  };
}

function input(position: Position = "FWD"): ForecastInput {
  return {
    player: { id: "player", position }, cutoffAt: "2026-09-20T12:00:00.000Z",
    appearances: [1, 2, 3, 4, 5].map((index) => appearance(index)), gaps: [],
    currentClub: { clubId: "club", leagueId: "153", season: "2026/27" }, rosterReasons: [], targets: [target()],
  };
}

function close(actual: number | null | undefined, expected: number) {
  assert.ok(actual !== null && actual !== undefined && Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`);
}

for (const [position, metrics] of Object.entries({ FWD: ["goals", "assists", "shotsOnTarget"], MID: ["assists", "keyPasses", "tackles"], DEF: ["tackles", "interceptions"], GK: ["saves", "goalsConceded"] })) {
  test(`${position}: exposes only its fixed position statistics with distinct rating/form scales`, () => {
    const result = evaluateForecast(input(position as Position));
    assert.equal(result.status, "available");
    assert.deepEqual(Object.keys(result.projected90), metrics);
    close(result.adjustedFormIndex.value, 43.75);
    close(result.forecastRating.value, 7);
    close(result.displayedForecastRating.value, 70);
    for (const metric of metrics) close(result.projected90[metric as Metric]?.value, 3);
  });
}

test("asymmetric difficulty rewards the lower-tier side and clamps the next rating", () => {
  const lower = input();
  lower.appearances.forEach((row) => { row.context = context(18, 1); });
  lower.targets[0].context = context(1, 18);
  const result = evaluateForecast(lower);
  assert.equal(result.selected[0].z, 2);
  close(result.selected[0].difficulty, 1.2);
  close(result.adjustedFormIndex.value, 52.5);
  close(result.forecastRating.value, 10);
  close(result.displayedForecastRating.value, 100);
  lower.appearances.forEach((row) => { row.context = context(1, 18); });
  lower.targets[0].context = context(18, 1);
  close(evaluateForecast(lower).forecastRating.value, 7 * 0.8 / 1.2);
});

test("tier boundaries use integer percentages for 24, 18 and 20 clubs", () => {
  for (const [clubs, upper, middle] of [[24, 8, 16], [18, 6, 12], [20, 7, 14]]) {
    const data = input();
    const expected = [1, 0, 0, -1];
    [upper, upper + 1, middle, middle + 1].forEach((rank, index) => {
      data.targets[0].context = context(upper + 1, rank, clubs);
      assert.equal(evaluateForecast(data).target!.z, expected[index]);
    });
  }
});

test("a tied rank is neutral only when its occupied interval crosses a tier", () => {
  const data = input();
  const table = context(7, 18);
  table.own = { rank: 7, tiedCount: 2, uncertain: true };
  data.targets[0].context = table;
  assert.equal(evaluateForecast(data).target!.z, -2);
  assert.equal(evaluateForecast(data).warnings.length, 0);
  table.own.rank = 8;
  const crossing = evaluateForecast(data);
  assert.equal(crossing.target!.z, -1);
  assert.deepEqual(crossing.warnings, [{ code: "uncertain_tier", fixtureId: "next", field: "own" }]);
});

test("top-division coefficients are explicit and equal coefficients cancel in rating", () => {
  for (const code of ["premier_league", "ligue_1", "bundesliga", "serie_a", "la_liga"]) assert.equal(competitionCoefficient(code), 2);
  for (const code of ["championship", "ligue_2", "England", "France", "other"]) assert.equal(competitionCoefficient(code), 1.5);
  const data = input();
  data.appearances.forEach((row) => { row.competition = "premier_league"; });
  data.targets[0].competition = "premier_league";
  close(evaluateForecast(data).forecastRating.value, 7);
  close(evaluateForecast(data).adjustedFormIndex.value, 100 * 14 / 24);
  data.targets[0].competition = "championship";
  close(evaluateForecast(data).forecastRating.value, 14 / 1.5);
});

test("statistic weights use context distance and pooled preserved minutes including extra time", () => {
  const data = input();
  const ranks: [number, number][] = [[1, 18], [10, 18], [10, 10], [10, 1], [18, 1]];
  const minutes = [60, 75, 90, 95, 120];
  data.appearances.forEach((row, index) => { row.context = context(...ranks[index]); row.minutes = minutes[index]; });
  data.targets[0].context = context(18, 1);
  const weights = [1.5 / 5, 1.5 / 4, 1.5 / 3, 1.5 / 2, 1.5];
  const expected = 90 * weights.reduce((sum, weight, index) => sum + weight * (index + 1), 0)
    / weights.reduce((sum, weight, index) => sum + weight * minutes[index], 0);
  const result = evaluateForecast(data);
  close(result.projected90.goals!.value, expected);
  assert.equal(result.selected[4].minutes, 120);
  assert.notEqual(result.projected90.goals!.value, 3);
});

test("a poor sixth eligible match replaces the oldest instead of selecting better performances", () => {
  const data = input();
  data.appearances.push(appearance(6, { rating: 0 }));
  const result = evaluateForecast(data);
  assert.deepEqual(result.selected.map((row) => row.fixtureId), ["102", "103", "104", "105", "106"]);
  close(result.forecastRating.value, 5.6);
});

test("short appearances and confirmed DNP retain the window but remain refresh evidence", () => {
  const data = input();
  const original = inputHash(data);
  data.appearances.push(appearance(6, { minutes: 59 }), appearance(7, { minutes: 0, participation: "dnp", rating: null }));
  const result = evaluateForecast(data);
  assert.equal(result.historyStatus, "ready");
  assert.deepEqual(result.selected.map((row) => row.fixtureId), ["101", "102", "103", "104", "105"]);
  close(result.forecastRating.value, 7);
  assert.notEqual(inputHash(data), original);
});

test("current explicit DNP with omitted minutes preserves actual appearances and nullable evidence without changing legacy rules", () => {
  const data = input();
  const missed = appearance(6, { participation: "dnp", minutes: null, rating: null,
    metrics: Object.fromEntries(METRICS.map((metric) => [metric, null])) as Record<Metric, null> });
  data.appearances.push(missed);
  assert.equal(selectObservedWindow(data).ready, false, "legacy omitted-minute behavior stays frozen");
  assert(selectObservedWindow(data).gaps.some((gap) => gap.code === "unknown_minutes"));
  missed.sourceProvider = "sorare";
  const current = selectObservedWindow(data);
  assert.equal(current.ready, true);
  assert.deepEqual(current.selected.map((row) => row.fixtureId), ["101", "102", "103", "104", "105"]);
  assert.equal(missed.minutes, null);
  assert(Object.values(missed.metrics).every((value) => value === null));
  missed.participation = "unknown";
  assert.equal(selectObservedWindow(data).ready, false);
  assert(selectObservedWindow(data).gaps.some((gap) => gap.code === "unknown_participation"));
  missed.participation = "dnp";
  missed.metrics.goals = 1;
  assert.equal(selectObservedWindow(data).ready, false, "a DNP cannot hide known positive counts");
  assert(selectObservedWindow(data).gaps.some((gap) => gap.code === "conflicting_participation"));
});

test("unknown eligibility cannot be skipped in favour of an older sixth match", () => {
  for (const change of [
    { minutes: null }, { participation: "unknown" as const }, { membershipKnown: false },
    { status: "unknown" as const }, { clubId: "unrelated" }, { kickoffAt: null },
  ]) {
    const data = input();
    data.appearances.push(appearance(6, change));
    const result = evaluateForecast(data);
    assert.equal(result.historyStatus, "incomplete_history", canonicalJson(change));
    assert.equal(result.forecastRating.status, "unavailable");
    assert.equal(result.adjustedFormIndex.status, "unavailable");
    assert.equal(result.projected90.goals!.status, "unavailable");
  }
});

test("only a gap that could affect the latest five blocks; unknown timing always blocks", () => {
  const data = input();
  data.appearances.unshift(appearance(0, { kickoffAt: "2026-08-31T14:00:00Z", minutes: null }));
  assert.equal(evaluateForecast(data).historyStatus, "ready");
  data.gaps.push({ code: "missing_match", fixtureId: "missing", kickoffAt: "2026-09-06T14:00:00Z" });
  assert.equal(evaluateForecast(data).historyStatus, "incomplete_history");
  data.gaps[0].kickoffAt = null;
  assert.equal(evaluateForecast(data).historyStatus, "incomplete_history");
});

test("fewer than five confirmed covered matches is insufficient, uncovered matches do not fill it", () => {
  const data = input();
  data.appearances[0].covered = false;
  const result = evaluateForecast(data);
  assert.equal(result.historyStatus, "insufficient_history");
  assert.equal(result.selected.length, 4);
  assert.equal(result.status, "unavailable");
});

test("the cutoff excludes the target's own appearance and known nonfinal fixtures", () => {
  const data = input();
  data.appearances.push(
    appearance(6, { kickoffAt: data.cutoffAt, rating: 10 }),
    appearance(7, { status: "live", minutes: null }),
    appearance(8, { status: "cancelled", minutes: null }),
  );
  const result = evaluateForecast(data);
  assert.equal(result.historyStatus, "ready");
  assert.deepEqual(result.selected.map((row) => row.fixtureId), ["101", "102", "103", "104", "105"]);
  close(result.forecastRating.value, 7);
});

test("known live, postponed and cancelled fixtures cannot enter history even with unknown kickoff", () => {
  const data = input();
  const originalHash = inputHash(data);
  for (const status of ["live", "postponed", "cancelled"] as const) {
    data.appearances.push(appearance(6, { fixtureId: status, status, kickoffAt: null, minutes: null, participation: "unknown" }));
  }
  const result = evaluateForecast(data);
  assert.equal(result.historyStatus, "ready");
  close(result.forecastRating.value, 7);
  assert.equal(result.selected.length, 5);
  assert.equal(inputHash(data), originalHash);
});

test("an explicit row on an unresolved past schedule blocks history, future schedule does not", () => {
  const data = input();
  const row = appearance(6, { status: "scheduled", minutes: null, participation: "unknown" });
  data.appearances.push(row);
  let result = evaluateForecast(data);
  assert.equal(result.historyStatus, "incomplete_history");
  assert.ok(result.reasons.some((reason) => reason.code === "unresolved_past_fixture" && reason.fixtureId === row.fixtureId));
  row.kickoffAt = "2026-09-21T14:00:00Z";
  result = evaluateForecast(data);
  assert.equal(result.historyStatus, "ready");
  row.kickoffAt = null;
  result = evaluateForecast(data);
  assert.equal(result.historyStatus, "incomplete_history");
  assert.ok(result.reasons.some((reason) => reason.code === "unknown_kickoff" && reason.fixtureId === row.fixtureId));
});

test("duplicate player appearances cannot count twice and replay independent of input order", () => {
  const data = input();
  data.appearances.push(appearance(5, { rating: 10 }));
  const first = evaluateForecast(data);
  const firstHash = inputHash(data, first);
  assert.equal(first.historyStatus, "incomplete_history");
  assert.equal(first.selected.length, 5);
  data.appearances.reverse();
  assert.deepEqual(evaluateForecast(data), first);
  assert.equal(inputHash(data), firstHash);
});

test("missing ratings and statistics block only outputs that depend on them, retaining the same five", () => {
  const data = input("MID");
  data.appearances[2].metrics.tackles = null;
  let result = evaluateForecast(data);
  assert.equal(result.status, "partial");
  close(result.forecastRating.value, 7);
  close(result.projected90.assists!.value, 3);
  assert.deepEqual(result.projected90.tackles!.reasons, [{ code: "missing_metric", fixtureId: "103", field: "tackles" }]);
  assert.equal(result.selected.length, 5);
  data.appearances[3].rating = null;
  result = evaluateForecast(data);
  assert.equal(result.adjustedFormIndex.status, "unavailable");
  assert.equal(result.forecastRating.status, "unavailable");
  close(result.projected90.keyPasses!.value, 3);
});

test("zero is valid and invalid numerical inputs never become zero", () => {
  const zero = input();
  zero.appearances.forEach((row) => { row.rating = 0; row.metrics.goals = 0; });
  close(evaluateForecast(zero).forecastRating.value, 0);
  close(evaluateForecast(zero).projected90.goals!.value, 0);
  for (const invalid of [-1, 0.5, Infinity, NaN, 2_147_483_648]) {
    const data = input();
    data.appearances[0].metrics.goals = invalid;
    const result = evaluateForecast(data);
    assert.equal(result.projected90.goals!.status, "unavailable");
    assert.equal(result.forecastRating.status, "available");
    data.appearances[0].minutes = invalid;
    assert.equal(evaluateForecast(data).historyStatus, "incomplete_history");
  }
  for (const invalid of [-0.1, 10.1, Infinity, NaN]) {
    const data = input();
    data.appearances[0].rating = invalid;
    assert.equal(evaluateForecast(data).forecastRating.status, "unavailable");
    assert.equal(evaluateForecast(data).projected90.goals!.status, "available");
  }
});

test("missing historical standings block weighted outputs, missing target context preserves form", () => {
  const data = input();
  data.targets[0].context = null;
  let result = evaluateForecast(data);
  assert.equal(result.forecastRating.status, "unavailable");
  close(result.adjustedFormIndex.value, 43.75);
  data.appearances[0].context!.complete = false;
  result = evaluateForecast(data);
  assert.equal(result.adjustedFormIndex.status, "unavailable");
  assert.equal(result.projected90.goals!.status, "unavailable");
  assert.equal(result.historyStatus, "ready");
});

test("unknown position preserves rating outputs and reports unavailable position context", () => {
  const result = evaluateForecast(input("UNKNOWN"));
  close(result.forecastRating.value, 7);
  assert.deepEqual(result.projected90, {});
  assert.equal(result.status, "partial");
  assert.ok(result.reasons.some((reason) => reason.code === "unknown_position"));
});

test("current club controls the target while covered history survives a transfer", () => {
  const data = input();
  data.currentClub = { clubId: "new-club", leagueId: "164", season: "2026/27" };
  data.targets.push(target({ fixtureId: "new", leagueId: "164", competition: "ligue_2", homeClubId: "new-club" }));
  const result = evaluateForecast(data);
  assert.equal(result.target!.fixtureId, "new");
  assert.equal(result.selected.every((row) => row.clubId === "club"), true);
  assert.equal(result.historyStatus, "ready");
  data.currentClub = null;
  assert.equal(evaluateForecast(data).target, null);
  close(evaluateForecast(data).adjustedFormIndex.value, 43.75);
});

test("next fixture requires known future schedule, club, league and season and refreshes after a final", () => {
  const data = input();
  data.targets.unshift(
    target({ fixtureId: "cancelled", kickoffAt: "2026-09-21T12:00:00Z", status: "cancelled" }),
    target({ fixtureId: "postponed", kickoffAt: "2026-09-21T12:00:00Z", status: "postponed" }),
    target({ fixtureId: "live", kickoffAt: "2026-09-21T12:00:00Z", status: "live" }),
    target({ fixtureId: "unknown", kickoffAt: null }),
    target({ fixtureId: "past", kickoffAt: "2026-09-20T12:00:00Z" }),
    target({ fixtureId: "wrong-season", kickoffAt: "2026-09-21T12:00:00Z", season: "2027/28" }),
    target({ fixtureId: "wrong-league", kickoffAt: "2026-09-21T12:00:00Z", leagueId: "164" }),
  );
  assert.equal(evaluateForecast(data).target!.fixtureId, "next");
  const oldHash = inputHash(data);
  data.targets.push(target({ fixtureId: "later", kickoffAt: "2026-10-10T14:00:00Z" }));
  assert.equal(inputHash(data), oldHash);
  data.targets.find((row) => row.fixtureId === "next")!.status = "final";
  assert.equal(evaluateForecast(data).target!.fixtureId, "later");
  assert.notEqual(inputHash(data), oldHash);
});

test("same kickoff ordering uses stable provider IDs for window and target", () => {
  const data = input();
  data.appearances.forEach((row) => { row.kickoffAt = "2026-09-01T14:00:00Z"; });
  data.appearances.push(appearance(6, { fixtureId: "100", kickoffAt: "2026-09-01T14:00:00Z" }));
  data.targets = [target({ fixtureId: "z" }), target({ fixtureId: "A" }), target({ fixtureId: "a" })];
  const result = evaluateForecast(data);
  assert.deepEqual(result.selected.map((row) => row.fixtureId), ["101", "102", "103", "104", "105"]);
  assert.equal(result.target!.fixtureId, "A");
});

test("replay hash ignores ordering, incidental clock cutoffs and unrelated historical evidence", () => {
  const data = input();
  const digest = inputHash(data);
  data.appearances.reverse();
  data.targets.reverse();
  data.cutoffAt = "2026-09-20T18:00:00.000Z";
  data.appearances.forEach((row) => { row.context!.cutoffAt = "2026-09-19T00:00:00Z"; });
  data.targets[0].context!.cutoffAt = "2026-09-20T00:00:00Z";
  data.appearances.push(appearance(0, { kickoffAt: "2026-08-31T14:00:00Z", rating: 10 }));
  assert.equal(inputHash(data), digest);
  assert.equal(canonicalJson({ z: 1, a: { c: 2, b: 3 } }), '{"a":{"b":3,"c":2},"z":1}');
  assert.match(digest, /^[a-f0-9]{64}$/);
});

test("context corrections and clock-driven target changes affect hash; A to B to A replays A", () => {
  const data = input();
  const original = inputHash(data);
  data.targets[0].context!.key = "corrected-context";
  assert.notEqual(inputHash(data), original);
  data.targets[0].context!.key = "table:24:10:10";
  assert.equal(inputHash(data), original);
  data.cutoffAt = "2026-10-02T12:00:00Z";
  assert.notEqual(inputHash(data), original);
});

test("ambiguous roster blocks target rather than guessing while historical form remains", () => {
  const data = input();
  data.rosterReasons = [{ code: "ambiguous_current_club" }];
  const result = evaluateForecast(data);
  assert.equal(result.target, null);
  assert.equal(result.forecastRating.status, "unavailable");
  close(result.adjustedFormIndex.value, 43.75);
});
