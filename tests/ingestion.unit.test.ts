import assert from "node:assert/strict";
import { test } from "node:test";
import { COVERAGE, coverageFor } from "../src/server/ingestion/coverage";
import { normalizeResponse } from "../src/server/ingestion/normalize";
import type { Fixture, ProviderAction, ProviderResponse } from "../src/server/ingestion/types";

const coverage = coverageFor("153");

// Small invented records exercise the provider's documented response shapes.
function response(action: ProviderAction, value: unknown, params: Record<string, string> = {}): ProviderResponse {
  return {
    action, resourceKey: action, params: { league_id: "153", timezone: "UTC", ...params },
    retrievedAt: "2026-11-09T10:00:00.000Z", text: JSON.stringify(value), contentSha256: "a".repeat(64),
  };
}
function event(overrides: Record<string, unknown> = {}) {
  return {
    match_id: "9001", league_id: "153", league_year: "2026/2027", stage_name: "Current",
    match_date: "2026-08-15", match_time: "18:30", match_status: "Finished",
    match_hometeam_id: "101", match_hometeam_name: "Example Home",
    match_awayteam_id: "102", match_awayteam_name: "Example Away",
    match_hometeam_score: "1", match_awayteam_score: "0", ...overrides,
  };
}
function stats(overrides: Record<string, unknown> = {}) {
  return {
    match_id: "9001", player_key: "201", player_name: "Example Keeper", player_position: "Goalkeepers",
    team_name: "home", player_is_subst: "False", player_minutes_played: "96", player_rating: "7.4",
    player_goals: "0", player_assists: "0", player_shots_on_goal: "0", player_key_passes: "0",
    player_tackles: "0", player_interceptions: "0", player_saves: "4", player_goals_conceded: "0", ...overrides,
  };
}
function context(): Fixture {
  return normalizeResponse(response("get_events", [event()]), coverage).fixtures[0];
}
function detail(value: unknown, prior = context()) {
  return normalizeResponse(response("get_statistics", value, { match_id: "9001" }), coverage, prior);
}
const awayStats = () => stats({ player_key: "202", player_name: "Example Forward", player_position: "Forwards", team_name: "away", player_saves: "0" });
function fullStatistics() {
  return [stats(), awayStats(), ...Array.from({ length: 10 }, (_, index) => [
    stats({ player_key: String(300 + index), player_name: `Invented home player ${index}`, player_saves: "0" }),
    awayStatsWithId(String(400 + index), index),
  ]).flat()];
}
function awayStatsWithId(id: string, index: number) {
  return { ...awayStats(), player_key: id, player_name: `Invented away player ${index}` };
}

test("coverage is fixed, immutable, and rejects expansion", () => {
  assert.deepEqual(COVERAGE.map((item) => [item.id, item.season, item.expectedClubs, item.timezone]), [
    ["153", "2026/27", 24, "Europe/London"], ["164", "2026/27", 18, "Europe/Paris"],
  ]);
  assert.ok(Object.isFrozen(COVERAGE));
  assert.ok(Object.isFrozen(coverage));
  assert.throws(() => coverageFor("152"), /Unsupported competition/);
  assert.throws(() => normalizeResponse(response("get_events", []), { ...coverage, season: "2027/28" }), /Unsupported coverage/);
});

test("UTC source kickoff is preserved through summer time and both local timezones", () => {
  const english = normalizeResponse(response("get_events", [event()]), coverage).fixtures[0];
  const french = normalizeResponse(response("get_events", [event({ league_id: "164" })], { league_id: "164" }), coverageFor("164")).fixtures[0];
  assert.equal(english.kickoffAt, "2026-08-15T18:30:00.000Z");
  assert.equal(french.kickoffAt, english.kickoffAt);
  assert.equal(normalizeResponse(response("get_events", [event()], { timezone: "Europe/London" }), coverage).fixtures.length, 0);
  const winter = normalizeResponse(response("get_events", [event({ match_date: "2026-12-15" })]), coverage).fixtures[0];
  assert.equal(winter.kickoffAt, "2026-12-15T18:30:00.000Z");
});

test("event scope rejects unapproved leagues, seasons, stages, and dates", () => {
  for (const override of [
    { league_id: "152" }, { league_year: "2025/2026" }, { stage_name: "Playoffs" },
    { stage_name: "" }, { match_date: "2026-02-30" }, { match_date: "2027-07-01" },
    { league_year: undefined }, { match_id: "9001?key=secret" },
  ]) {
    const batch = normalizeResponse(response("get_events", [event(override)]), coverage);
    assert.equal(batch.fixtures.length, 0, JSON.stringify(override));
    assert.ok(batch.issues.length > 0);
  }
});

test("missing or invalid kickoff and unfamiliar finality remain uncertain", () => {
  for (const time of [null, "", "TBD", "25:00"]) {
    const fixture = normalizeResponse(response("get_events", [event({ match_time: time, match_status: "Awarded" })]), coverage).fixtures[0];
    assert.equal(fixture.kickoffAt, null);
    assert.equal(fixture.status, "unknown");
  }
  assert.equal(normalizeResponse(response("get_events", [event({ match_date: "" })]), coverage).fixtures[0].kickoffAt, null);
});

test("missing whole-match statistics preserves known starters and bench as unknown", () => {
  const value = event({ lineup: {
    home: { starting_lineups: [{ player_key: "201", lineup_player: "Example Starter", lineup_position: "1" }], substitutes: [{ player_key: "203", lineup_player: "Example Bench", lineup_position: "0" }], coach: [{ player_key: "999", lineup_player: "Example Coach" }] },
    away: { starting_lineups: [{ player_key: "202", lineup_player: "Example Away", lineup_position: "9" }] },
  } });
  const batch = normalizeResponse(response("get_events", [value]), coverage);
  const fixture = batch.fixtures[0];
  assert.equal(fixture.statisticsStatus, "missing");
  assert.equal(fixture.appearances.length, 3);
  assert.ok(fixture.appearances.every((item) => item.participation === "unknown" && item.minutes === null));
  assert.ok(fixture.appearances.every((item) => item.player.position === "UNKNOWN"));
  assert.ok(batch.issues.some((item) => item.code === "missing_statistics"));
});

test("keyed and flat get_statistics normalize consistently without changing context", () => {
  const prior = context();
  const before = JSON.stringify(prior);
  const rows = [stats(), awayStats()];
  const keyed = detail({ "9001": { player_statistics: rows } }, prior);
  const flat = detail({ player_statistics: rows }, prior);
  const array = detail(rows, prior);
  assert.deepEqual(keyed.fixtures, flat.fixtures);
  assert.deepEqual(keyed.fixtures, array.fixtures);
  assert.equal(keyed.fixtures[0].statisticsStatus, "partial");
  assert.ok(keyed.issues.some((item) => item.code === "incomplete_participant_coverage"));
  assert.equal(keyed.fixtures[0].appearances[0].minutes, 96);
  assert.equal(keyed.fixtures[0].appearances[0].player.position, "GK");
  assert.equal(keyed.fixtures[0].appearances[1].player.position, "FWD");
  assert.equal(JSON.stringify(prior), before);
});

test("event player_stats home/away collections use the same field mappings", () => {
  const batch = normalizeResponse(response("get_events", [event({ player_stats: { home: [stats({ team_name: undefined })], away: [awayStats()] } })]), coverage);
  assert.deepEqual(batch.fixtures[0].appearances, detail({ player_statistics: [stats(), awayStats()] }).fixtures[0].appearances);
  assert.equal(batch.fixtures[0].statisticsStatus, "partial");
});

test("complete statistics require at least eleven positive-minute players for each club", () => {
  const rows = fullStatistics();
  const complete = detail(rows);
  assert.equal(complete.fixtures[0].statisticsStatus, "complete");
  assert.equal(complete.issues.length, 0);
  for (const side of ["home", "away"]) {
    const absent = rows.find((item) => item.team_name === side)!;
    const truncated = detail(rows.filter((item) => item !== absent));
    assert.equal(truncated.fixtures[0].statisticsStatus, "partial");
    assert.ok(truncated.issues.some((item) => item.code === "incomplete_participant_coverage"));
    const dnp = detail(rows.map((item) => item === absent
      ? { ...item, player_minutes_played: "0", player_rating: "0", player_saves: "0" } : item));
    assert.equal(dnp.fixtures[0].statisticsStatus, "partial");
    assert.equal(dnp.fixtures[0].appearances.find((item) => item.player.id === absent.player_key)?.participation, "dnp");
    assert.ok(dnp.issues.some((item) => item.code === "incomplete_participant_coverage"));
  }
});

test("conflicting side and team identifiers cannot assign a player or retain prior metrics", () => {
  const previous = detail(fullStatistics()).fixtures[0];
  for (const identifiers of [{ team_key: "102" }, { team_id: "102" }, { team_key: "101", team_id: "102" }]) {
    const rows = fullStatistics().map((item) => item.player_key === "201" ? { ...item, ...identifiers } : item);
    const withoutPrior = detail(rows);
    assert.equal(withoutPrior.fixtures[0].appearances.some((item) => item.player.id === "201"), false);
    assert.equal(withoutPrior.fixtures[0].statisticsStatus, "partial");
    assert.ok(withoutPrior.issues.some((item) => item.code === "conflicting_membership"));
    const corrected = detail(rows, previous);
    const uncertain = corrected.fixtures[0].appearances.find((item) => item.player.id === "201")!;
    assert.equal(uncertain.clubId, "101");
    assert.equal(uncertain.participation, "unknown");
    assert.equal(uncertain.minutes, null);
    assert.equal(uncertain.saves, null);
    assert.equal(corrected.fixtures[0].statisticsStatus, "partial");
  }
  assert.equal(detail(fullStatistics().map((item) => ({ ...item,
    team_key: item.team_name === "home" ? "101" : "102",
    team_id: item.team_name === "home" ? "101" : "102",
  }))).fixtures[0].statisticsStatus, "complete");
});

test("missing known participants in later detailed response become unknown, not DNP or stale statistics", () => {
  const previous = detail({ player_statistics: [stats(), awayStats()] }).fixtures[0];
  const batch = detail({ player_statistics: [stats()] }, previous);
  const absent = batch.fixtures[0].appearances.find((item) => item.player.id === "202");
  assert.equal(absent?.participation, "unknown");
  assert.equal(absent?.minutes, null);
  assert.equal(absent?.rating, null);
  assert.equal(batch.fixtures[0].statisticsStatus, "partial");
  assert.ok(batch.issues.some((item) => item.code === "missing_player_statistics"));
});

test("empty detail preserves existing participants and marks a whole-match gap", () => {
  const previous = detail({ player_statistics: [stats(), awayStats()] }).fixtures[0];
  const fixture = detail({ player_statistics: [] }, previous).fixtures[0];
  assert.equal(fixture.statisticsStatus, "missing");
  assert.equal(fixture.appearances.length, 2);
  assert.ok(fixture.appearances.every((item) => item.participation === "unknown" && item.minutes === null));
});

test("malformed football detail replaces previous complete metrics with an explicit gap", () => {
  const previous = detail({ player_statistics: fullStatistics() }).fixtures[0];
  assert.equal(previous.statisticsStatus, "complete");
  for (const malformed of [{}, { "9001": {} }, { player_statistics: {} }, { "9001": { player_statistics: null } }]) {
    const batch = detail(malformed, previous);
    assert.equal(batch.fixtures.length, 1);
    const fixture = batch.fixtures[0];
    assert.equal(fixture.detailed, true);
    assert.equal(fixture.statisticsStatus, "missing");
    assert.equal(fixture.appearances.length, previous.appearances.length);
    assert.ok(fixture.appearances.every((item) => item.participation === "unknown"
      && item.minutes === null && item.rating === null && item.goals === null && item.saves === null));
    assert.ok(batch.issues.some((item) => item.code === "invalid_payload"));
  }
  assert.equal(previous.statisticsStatus, "complete");
  assert.equal(previous.appearances[0].minutes, 96);
});

test("zero is distinct from null and blank, including explicit zero-minute DNP", () => {
  const zero = stats({ player_minutes_played: "0", player_rating: "0", player_saves: "0", player_is_subst: "True" });
  const fixture = detail({ player_statistics: [zero, awayStats()] }).fixtures[0];
  assert.equal(fixture.appearances[0].participation, "dnp");
  assert.equal(fixture.appearances[0].minutes, 0);
  assert.equal(fixture.appearances[0].goals, 0);
  for (const missing of [null, "", "  ", undefined]) {
    const value = detail({ player_statistics: [stats({ player_minutes_played: missing, player_goals: missing, player_is_subst: "True" }), awayStats()] }).fixtures[0];
    assert.equal(value.appearances[0].minutes, null);
    assert.equal(value.appearances[0].goals, null);
    assert.equal(value.appearances[0].participation, "unknown");
    assert.equal(value.statisticsStatus, "partial");
  }
});

test("conflicting zero-minute positive statistics cannot confirm DNP", () => {
  const fixture = detail({ player_statistics: [stats({ player_minutes_played: "0", player_goals: "1" }), awayStats()] }).fixtures[0];
  assert.equal(fixture.appearances[0].participation, "unknown");
  assert.equal(fixture.statisticsStatus, "partial");
});

test("invalid ratings, negative counts, fractions, booleans, and coercible text never become zero", () => {
  for (const [field, value, canonical] of [
    ["player_rating", "10.1", "rating"], ["player_rating", "-1", "rating"],
    ["player_minutes_played", "-1", "minutes"], ["player_goals", "1.2", "goals"],
    ["player_goals", true, "goals"], ["player_goals", "0x10", "goals"],
    ["player_goals", "1e2", "goals"], ["player_goals", "2147483648", "goals"],
  ] as const) {
    const batch = detail({ player_statistics: [stats({ [field]: value }), awayStats()] });
    assert.equal(batch.fixtures[0].appearances[0][canonical], null);
    assert.equal(batch.fixtures[0].statisticsStatus, "partial");
    assert.ok(batch.issues.some((item) => item.code === "invalid_number" && item.field === field));
  }
});

test("unknown membership, malformed participants, and duplicate rows prevent complete statistics", () => {
  for (const invalid of [stats({ team_name: "other" }), stats({ player_key: "bad" }), false, stats()]) {
    const batch = detail({ player_statistics: [stats(), awayStats(), invalid] });
    assert.equal(batch.fixtures[0].statisticsStatus, "partial");
    assert.ok(batch.issues.length > 0);
  }
  const fixture = detail({ player_statistics: [stats(), stats(), awayStats()] }).fixtures[0];
  assert.equal(fixture.appearances.filter((item) => item.player.id === "201").length, 1);
  assert.equal(fixture.appearances[0].participation, "unknown");
});

test("detailed participant fixture and membership mismatches remain uncertain", () => {
  assert.equal(detail({ player_statistics: [stats({ match_id: "9002" }), awayStats()] }).fixtures[0].statisticsStatus, "partial");
  const previous = detail({ player_statistics: [stats(), awayStats()] }).fixtures[0];
  const changed = detail({ player_statistics: [stats({ team_name: "away" }), awayStats()] }, previous);
  assert.equal(changed.fixtures[0].appearances[0].participation, "unknown");
  assert.ok(changed.issues.some((item) => item.code === "conflicting_membership"));
  assert.equal(normalizeResponse(response("get_statistics", { player_statistics: [] }), coverage).fixtures.length, 0);
});

test("team rosters preserve plural position groups and unknown positions", () => {
  const batch = normalizeResponse(response("get_teams", [{ team_key: "101", team_name: "Example Club", players: [
    { player_key: "201", player_name: "Keeper", player_type: "Goalkeepers" },
    { player_key: "202", player_name: "Defender", player_type: "Defenders" },
    { player_key: "203", player_name: "Midfielder", player_type: "Midfielders" },
    { player_key: "204", player_name: "Forward", player_type: "Forwards" },
    { player_key: "205", player_name: "Unknown", player_type: "Other" },
  ] }]), coverage);
  assert.deepEqual(batch.players.map((item) => item.position), ["GK", "DEF", "MID", "FWD", "UNKNOWN"]);
  assert.ok(batch.players.every((item) => item.clubId === "101"));
});

test("provider standings normalize totals and permit deduction-adjusted negative points", () => {
  const value = { team_id: "101", team_name: "Example Club", league_id: "153", stage_name: "Current",
    overall_league_payed: "1", overall_league_W: "0", overall_league_D: "0", overall_league_L: "1",
    overall_league_GF: "0", overall_league_GA: "2", overall_league_PTS: "-4" };
  const batch = normalizeResponse(response("get_standings", [value]), coverage);
  assert.deepEqual(batch.standings, [{ clubId: "101", played: 1, wins: 0, draws: 0, losses: 1, goalsFor: 0, goalsAgainst: 2, points: -4 }]);
  for (const override of [{ overall_league_W: "2" }, { overall_league_GF: "" }, { stage_name: "Promotion Playoffs" }, { league_id: "152" }]) {
    assert.equal(normalizeResponse(response("get_standings", [{ ...value, ...override }]), coverage).standings.length, 0);
  }
});

test("repeated fixtures do not produce repeated canonical rows", () => {
  const batch = normalizeResponse(response("get_events", [event(), event()]), coverage);
  assert.equal(batch.fixtures.length, 1);
  assert.equal(batch.fixtures[0].status, "final");
  assert.equal(batch.fixtures[0].homeScore, 1);
  assert.ok(batch.issues.some((item) => item.code === "duplicate_fixture"));
  assert.equal(batch.issues.some((item) => item.code === "conflicting_fixture"), false);
});

test("conflicting duplicate fixtures invalidate confirmed scores, statistics, and participation", () => {
  const original = event({ player_statistics: fullStatistics() });
  const batch = normalizeResponse(response("get_events", [original, { ...original, match_hometeam_score: "9" }, original]), coverage);
  assert.equal(batch.fixtures.length, 1);
  const fixture = batch.fixtures[0];
  assert.equal(fixture.status, "unknown");
  assert.equal(fixture.homeScore, null);
  assert.equal(fixture.awayScore, null);
  assert.equal(fixture.statisticsStatus, "partial");
  assert.equal(fixture.detailed, true);
  assert.equal(fixture.appearances.length, 22);
  assert.ok(fixture.appearances.every((item) => item.participation === "unknown" && item.minutes === null
    && item.rating === null && item.saves === null));
  assert.ok(batch.issues.some((item) => item.code === "conflicting_fixture"));
});

test("conflicting duplicate club identities remain uncertain and do not register discarded participants", () => {
  const original = event();
  const conflicting = event({ match_awayteam_id: "103", match_awayteam_name: "Conflicting club", lineup: {
    away: { starting_lineups: [{ player_key: "999", lineup_player: "Discarded player" }] },
  } });
  const batch = normalizeResponse(response("get_events", [original, conflicting]), coverage);
  assert.equal(batch.fixtures[0].away.id, "102");
  assert.equal(batch.fixtures[0].status, "unknown");
  assert.equal(batch.fixtures[0].awayScore, null);
  assert.deepEqual(batch.clubs.map((item) => item.id), ["101", "102"]);
  assert.equal(batch.players.length, 0);
  assert.ok(batch.issues.some((item) => item.code === "conflicting_fixture"));
});

test("duplicate statistics order does not make equivalent fixtures conflict", () => {
  const rows = fullStatistics();
  const batch = normalizeResponse(response("get_events", [event({ player_statistics: rows }),
    event({ player_statistics: [...rows].reverse() })]), coverage);
  assert.equal(batch.fixtures[0].status, "final");
  assert.equal(batch.fixtures[0].statisticsStatus, "complete");
  assert.equal(batch.issues.some((item) => item.code === "conflicting_fixture"), false);
});

test("parse and validation errors expose fixed codes and fields without source values", () => {
  const secret = "SECRET_PROVIDER_KEY_DO_NOT_LOG";
  const malformed = { ...response("get_events", []), text: secret, resourceKey: secret };
  const badJson = normalizeResponse(malformed, coverage);
  assert.deepEqual(badJson.issues, [{ code: "invalid_json", resource: "get_events" }]);
  const badId = normalizeResponse(response("get_events", [event({ match_id: secret })]), coverage);
  assert.equal(JSON.stringify(badId.issues).includes(secret), false);
  assert.equal(normalizeResponse(response("get_events", { error: secret }), coverage).fixtures.length, 0);
});

test("unparseable successful statistics clear earlier complete metrics and preserve participants as gaps", () => {
  const prior = detail(fullStatistics()).fixtures[0];
  assert.equal(prior.statisticsStatus, "complete");
  const broken = { ...response("get_statistics", {}, { match_id: "9001" }), text: "{broken" };
  const batch = normalizeResponse(broken, coverage, prior);
  assert.ok(batch.issues.some((issue) => issue.code === "invalid_json"));
  assert.equal(batch.fixtures[0].statisticsStatus, "missing");
  assert.equal(batch.fixtures[0].appearances.length, prior.appearances.length);
  assert.ok(batch.fixtures[0].appearances.every((appearance) => appearance.participation === "unknown" && appearance.minutes === null && appearance.rating === null));
});
