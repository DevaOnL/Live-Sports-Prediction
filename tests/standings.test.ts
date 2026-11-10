import assert from "node:assert/strict";
import { test } from "node:test";
import { cutoffUtc, localDate, POINTS_ADJUSTMENTS, reconstructStandings } from "../src/server/ingestion/standings";
import type { Club, Coverage, Fixture } from "../src/server/ingestion/types";

function setup(ids = ["A", "B"], leagueId = "153") {
  const clubs: Club[] = ids.map((id) => ({ id, name: id }));
  const coverage: Coverage = {
    id: leagueId, name: "Test regular season", country: "Test", season: "2026/27",
    timezone: leagueId === "164" ? "Europe/Paris" : "Europe/London",
    startsOn: "2026-07-01", endsOn: "2027-06-30", expectedClubs: clubs.length,
  };
  const fixtures: Fixture[] = clubs.flatMap((home) => clubs.filter((away) => home.id !== away.id).map((away) => ({
    id: `${home.id}-${away.id}`, leagueId, season: coverage.season, home, away,
    kickoffAt: "2027-05-01T14:00:00.000Z", status: "scheduled" as const,
    homeScore: null, awayScore: null, statisticsStatus: "unknown" as const,
    detailed: false, appearances: [],
  })));
  const final = (home: string, away: string, homeScore: number, awayScore: number, kickoffAt = "2026-08-01T14:00:00.000Z") => {
    Object.assign(fixtures.find((fixture) => fixture.home.id === home && fixture.away.id === away)!, {
      status: "final", homeScore, awayScore, kickoffAt,
    });
  };
  const table = (cutoff = "2026-08-02") => reconstructStandings(coverage, clubs, fixtures, cutoff);
  return { clubs, coverage, fixtures, final, table };
}

test("competition-local midnight uses the offset on either side of DST changes", () => {
  const cases = [
    ["2026-03-29", "Europe/London", "2026-03-29T00:00:00.000Z"],
    ["2026-03-30", "Europe/London", "2026-03-29T23:00:00.000Z"],
    ["2026-10-25", "Europe/London", "2026-10-24T23:00:00.000Z"],
    ["2026-10-26", "Europe/London", "2026-10-26T00:00:00.000Z"],
    ["2026-03-29", "Europe/Paris", "2026-03-28T23:00:00.000Z"],
    ["2026-03-30", "Europe/Paris", "2026-03-29T22:00:00.000Z"],
    ["2026-10-25", "Europe/Paris", "2026-10-24T22:00:00.000Z"],
    ["2026-10-26", "Europe/Paris", "2026-10-25T23:00:00.000Z"],
  ];
  for (const [date, timezone, expected] of cases) assert.equal(cutoffUtc(date, timezone), expected);
  assert.equal(localDate("2026-08-19T23:30:00Z", "Europe/London"), "2026-08-20");
  assert.equal(localDate("2026-08-19T22:30:00Z", "Europe/Paris"), "2026-08-20");
  assert.throws(() => cutoffUtc("2026-02-30", "Europe/London"), RangeError);
  assert.throws(() => cutoffUtc("2026-8-2", "Europe/London"), RangeError);
  assert.throws(() => localDate("unknown", "Europe/Paris"), RangeError);
});

for (const [leagueId, previousDay, sameDay] of [
  ["153", "2026-08-19T22:59:00.000Z", "2026-08-19T23:01:00.000Z"],
  ["164", "2026-08-19T21:59:00.000Z", "2026-08-19T22:01:00.000Z"],
]) {
  test(`${leagueId}: use results from strictly earlier local dates`, () => {
    const data = setup(["A", "B"], leagueId);
    data.final("A", "B", 2, 0, previousDay);
    data.final("B", "A", 5, 0, sameDay);
    const result = data.table("2026-08-20");
    assert.equal(result.complete, true);
    assert.deepEqual(result.rows.map(({ clubId, played, points, goalsFor }) => ({ clubId, played, points, goalsFor })), [
      { clubId: "A", played: 1, points: 3, goalsFor: 2 },
      { clubId: "B", played: 1, points: 0, goalsFor: 0 },
    ]);
  });
}

test("Championship uses overall goals before head-to-head", () => {
  const data = setup(["A", "B", "C", "D"]);
  data.final("A", "B", 2, 0);
  data.final("C", "A", 2, 0);
  data.final("B", "D", 3, 1);
  const result = data.table();
  assert.equal(result.complete, true);
  assert.deepEqual(result.rows.map((row) => row.clubId), ["C", "B", "A", "D"]);
});

test("Championship head-to-head compares only the clubs in the tied group", () => {
  const data = setup(["A", "B", "C", "D"]);
  data.final("A", "B", 1, 0);
  data.final("A", "C", 1, 0);
  data.final("B", "C", 1, 0);
  data.final("A", "D", 0, 1);
  data.final("D", "A", 1, 0);
  data.final("B", "D", 1, 0);
  data.final("D", "B", 1, 0);
  data.final("C", "D", 1, 0);
  data.final("D", "C", 0, 1);
  const result = data.table();
  assert.equal(result.complete, true);
  assert.deepEqual(result.rows.map(({ clubId, points, goalsFor, goalsAgainst, position }) =>
    ({ clubId, points, goalsFor, goalsAgainst, position })), [
    { clubId: "D", points: 9, goalsFor: 3, goalsAgainst: 3, position: 1 },
    { clubId: "A", points: 6, goalsFor: 2, goalsAgainst: 2, position: 2 },
    { clubId: "B", points: 6, goalsFor: 2, goalsAgainst: 2, position: 3 },
    { clubId: "C", points: 6, goalsFor: 2, goalsAgainst: 2, position: 4 },
  ]);
  assert.ok(result.rows.every((row) => !row.rankUncertain));
});

test("Championship falls back to wins after a tied head-to-head mini-table", () => {
  const data = setup(["A", "B", "C", "D"]);
  data.final("A", "C", 1, 1);
  data.final("C", "A", 0, 0);
  data.final("A", "D", 0, 0);
  data.final("B", "C", 1, 0);
  data.final("D", "B", 1, 0);
  const result = data.table();
  assert.equal(result.rows.find((row) => row.clubId === "B")!.position, 2);
  assert.equal(result.rows.find((row) => row.clubId === "A")!.position, 3);
});

test("Championship uses away goals after total wins", () => {
  const data = setup(["A", "B", "C", "D"]);
  data.final("A", "C", 1, 1);
  data.final("D", "B", 1, 1);
  data.final("C", "D", 2, 0);
  const result = data.table();
  assert.equal(result.rows.find((row) => row.clubId === "B")!.position, 2);
  assert.equal(result.rows.find((row) => row.clubId === "A")!.position, 3);
});

test("Ligue 2 skips single-meeting head-to-head and proceeds to away wins", () => {
  const data = setup(["A", "B", "C", "D"], "164");
  data.final("A", "B", 1, 0);
  data.final("C", "A", 1, 0);
  data.final("D", "B", 0, 1);
  const result = data.table();
  assert.equal(result.complete, true);
  assert.equal(result.rows.find((row) => row.clubId === "B")!.position, 2);
  assert.equal(result.rows.find((row) => row.clubId === "A")!.position, 3);
  data.final("B", "A", 0, 0);
  const afterReturnMeeting = data.table();
  assert.equal(afterReturnMeeting.rows.find((row) => row.clubId === "A")!.position, 1);
  assert.equal(afterReturnMeeting.rows.find((row) => row.clubId === "B")!.position, 2);
});

test("Ligue 2 requires both meetings for every pairing in a multiway tie", () => {
  const data = setup(["A", "B", "C", "D"], "164");
  data.final("A", "B", 1, 0);
  data.final("A", "C", 1, 0);
  data.final("B", "C", 1, 0);
  data.final("A", "D", 0, 1);
  data.final("D", "A", 1, 0);
  data.final("B", "D", 1, 0);
  data.final("D", "B", 1, 0);
  data.final("C", "D", 1, 0);
  data.final("D", "C", 0, 1);
  const result = data.table();
  // C has one away win. The partial mini-table would incorrectly put A first.
  assert.equal(result.rows.find((row) => row.clubId === "C")!.position, 2);
  assert.equal(result.rows.find((row) => row.clubId === "A")!.position, 3);
  assert.equal(result.rows.find((row) => row.clubId === "B")!.position, 3);
});

test("unsupported final tie separation preserves equal ranks without an ID tiebreak", () => {
  const data = setup(["Z", "A", "M", "B"], "164");
  data.final("Z", "A", 0, 0);
  const result = data.table();
  assert.equal(result.complete, true);
  assert.deepEqual(result.rows.map(({ clubId, position, rankUncertain }) => ({ clubId, position, rankUncertain })), [
    { clubId: "Z", position: 1, rankUncertain: true },
    { clubId: "A", position: 1, rankUncertain: true },
    { clubId: "M", position: 3, rankUncertain: true },
    { clubId: "B", position: 3, rankUncertain: true },
  ]);
  assert.ok(result.issues.some((issue) => issue.code === "unresolved_standings_tie"));
});

test("Southampton deduction has explicit official provenance and an effective date", () => {
  const data = setup(["3072", "A"]);
  assert.equal(data.table("2026-05-19").rows.find((row) => row.clubId === "3072")!.points, 0);
  assert.equal(data.table("2026-05-20").rows.find((row) => row.clubId === "3072")!.points, -4);
  assert.equal(data.table().rows.find((row) => row.clubId === "3072")!.position, 2);
  assert.equal(POINTS_ADJUSTMENTS[0].effectiveAt, "2026-05-19T17:45:00.000Z");
  assert.equal(POINTS_ADJUSTMENTS[0].points, -4);
  assert.match(POINTS_ADJUSTMENTS[0].provenanceUrl, /^https:\/\/images\.gc\.eflservices\.co\.uk\/.+\.pdf$/);
  data.coverage.season = "2027/28";
  data.coverage.startsOn = "2027-07-01";
  data.coverage.endsOn = "2028-06-30";
  for (const fixture of data.fixtures) { fixture.season = "2027/28"; fixture.kickoffAt = "2028-05-01T14:00:00Z"; }
  assert.equal(data.table("2027-08-01").rows.find((row) => row.clubId === "3072")!.points, 0);
});

test("missing or invalid finalized scores before cutoff block complete history", () => {
  for (const score of [null, -1, 1.5, Number.NaN]) {
    const data = setup();
    data.final("A", "B", 0, 0);
    data.fixtures[0].homeScore = score;
    const result = data.table();
    assert.equal(result.complete, false);
    assert.ok(result.issues.some((issue) => issue.code === "missing_final_score"));
    assert.ok(result.rows.every((row) => row.played === 0));
  }
  const future = setup();
  future.final("A", "B", 0, 0, "2026-08-03T14:00:00Z");
  future.fixtures[0].homeScore = null;
  assert.equal(future.table().complete, true);
});

test("unknown result status or kickoff cannot become a complete historical table", () => {
  const unknownResult = setup();
  unknownResult.fixtures[0].status = "unknown";
  unknownResult.fixtures[0].kickoffAt = "2026-08-01T14:00:00Z";
  assert.equal(unknownResult.table().complete, false);
  assert.ok(unknownResult.table().issues.some((issue) => issue.code === "unknown_result"));
  for (const kickoffAt of [null, "not-a-date"]) {
    const data = setup();
    data.fixtures[0].kickoffAt = kickoffAt;
    assert.equal(data.table().complete, false);
    assert.ok(data.table().issues.some((issue) => issue.code === "unknown_kickoff"));
  }
});

test("known unfinished, postponed and cancelled fixtures add no invented results", () => {
  for (const status of ["scheduled", "live", "postponed", "cancelled"] as const) {
    const data = setup();
    Object.assign(data.fixtures[0], { status, kickoffAt: "2026-08-01T14:00:00Z", homeScore: 9, awayScore: 0 });
    const result = data.table();
    assert.equal(result.complete, status === "postponed" || status === "cancelled");
    assert.equal(result.issues.some((issue) => issue.code === "unfinished_past_fixture"), status === "scheduled" || status === "live");
    assert.ok(result.rows.every((row) => row.played === 0 && row.points === 0));
  }
});

for (const status of ["postponed", "cancelled"] as const) test(`${status} fixtures without kickoff do not block results or bypass schedule guards`, () => {
  const data = setup();
  Object.assign(data.fixtures[0], { status, kickoffAt: null, homeScore: 9, awayScore: 0 });
  for (const table of [data.table(), reconstructStandings(data.coverage, data.clubs, data.fixtures, "2026-08-03", { asOf: "2026-08-02T12:00:00Z" })]) {
    assert.equal(table.complete, true);
    assert.equal(table.issues.some((issue) => issue.code === "unknown_kickoff"), false);
    assert.ok(table.rows.every((row) => row.played === 0 && row.points === 0));
  }
  const incomplete = reconstructStandings(data.coverage, data.clubs, data.fixtures.slice(1), "2026-08-02");
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.issues.some((issue) => issue.code === "incomplete_schedule"));
  data.fixtures.push({ ...data.fixtures[0], id: "duplicate-pairing" });
  assert.ok(data.table().issues.some((issue) => issue.code === "duplicate_pairing"));
});

test("full roster and every regular-season home/away pairing are required", () => {
  const missingFixture = setup();
  missingFixture.fixtures.pop();
  assert.equal(missingFixture.table().complete, false);
  assert.ok(missingFixture.table().issues.some((issue) => issue.code === "incomplete_schedule"));
  const missingClub = setup();
  missingClub.coverage.expectedClubs = 3;
  assert.equal(missingClub.table().complete, false);
  assert.ok(missingClub.table().issues.some((issue) => issue.code === "invalid_club_count"));
  const duplicateClub = setup();
  duplicateClub.clubs.push(duplicateClub.clubs[0]);
  assert.equal(duplicateClub.table().complete, false);
  assert.equal(duplicateClub.table().rows.length, 2);
  assert.ok(duplicateClub.table().issues.some((issue) => issue.code === "duplicate_registration"));
});

test("duplicate fixture IDs are counted once and conflicting schedules remain incomplete", () => {
  const duplicate = setup();
  duplicate.final("A", "B", 2, 1);
  duplicate.fixtures.push({ ...duplicate.fixtures[0] });
  const result = duplicate.table();
  assert.equal(result.complete, false);
  assert.equal(result.rows.find((row) => row.clubId === "A")!.played, 1);
  assert.equal(result.rows.find((row) => row.clubId === "A")!.points, 3);
  const conflicting = setup();
  conflicting.final("A", "B", 2, 1);
  conflicting.fixtures.push({ ...conflicting.fixtures[0], homeScore: 5 });
  assert.equal(conflicting.table().complete, false);
  assert.ok(conflicting.table().issues.some((issue) => issue.code === "conflicting_fixture"));
  const duplicatePair = setup();
  duplicatePair.final("A", "B", 2, 1);
  duplicatePair.fixtures.push({ ...duplicatePair.fixtures[0], id: "different-id" });
  assert.equal(duplicatePair.table().complete, false);
  assert.ok(duplicatePair.table().issues.some((issue) => issue.code === "duplicate_pairing"));
});

for (const [leagueId, previousDay, sameDay] of [
  ["premier-league-gb-eng", "2026-08-19T22:59:00.000Z", "2026-08-19T23:01:00.000Z"],
  ["laliga-es", "2026-08-19T21:59:00.000Z", "2026-08-19T22:01:00.000Z"],
]) {
  test(`${leagueId}: current-league context uses its own local matchday`, () => {
    const data = setup(["A", "B"], leagueId);
    if (leagueId === "laliga-es") data.coverage.timezone = "Europe/Madrid";
    data.final("A", "B", 2, 0, previousDay);
    data.final("B", "A", 5, 0, sameDay);
    const result = data.table("2026-08-20");
    assert.equal(result.complete, true);
    assert.equal(result.rows.find((row) => row.clubId === "A")!.points, 3);
    assert.equal(result.rows.find((row) => row.clubId === "B")!.points, 0);
    assert.equal(result.issues.some((issue) => issue.code === "unsupported_standings_rules"), false);
  });
}

test("Premier League uses overall goal difference and goals before preserving unresolved equal positions", () => {
  const data = setup(["A", "B", "C", "D"], "premier-league-gb-eng");
  data.final("A", "B", 2, 0);
  data.final("C", "A", 2, 0);
  data.final("B", "D", 3, 1);
  assert.deepEqual(data.table().rows.map((row) => row.clubId), ["C", "B", "A", "D"]);

  const tied = setup(["A", "B", "C", "D"], "premier-league-gb-eng");
  tied.final("A", "B", 1, 0);
  tied.final("A", "C", 1, 0);
  tied.final("B", "C", 1, 0);
  tied.final("A", "D", 0, 1);
  tied.final("D", "A", 1, 0);
  tied.final("B", "D", 1, 0);
  tied.final("D", "B", 1, 0);
  tied.final("C", "D", 1, 0);
  tied.final("D", "C", 0, 1);
  const result = tied.table();
  assert.equal(result.complete, true);
  assert.deepEqual(result.rows.filter((row) => row.clubId !== "D").map((row) => [row.position, row.rankUncertain]),
    [[2, true], [2, true], [2, true]], "an interim table cannot apply Championship wins/away-goals or infer final sporting stakes");
});

function laLigaTwoClubTie(returnMeeting: boolean) {
  const data = setup(["A", "B", "C", "D"], "laliga-es");
  data.coverage.timezone = "Europe/Madrid";
  data.final("A", "B", 1, 0);
  if (returnMeeting) data.final("B", "A", 0, 0);
  data.final("B", "C", 3, 0);
  data.final("D", "A", 3, 0);
  data.final("D", "C", 1, 0);
  return data;
}

test("La Liga two-club ties prioritize completed head-to-head goals over overall goal difference", () => {
  const result = laLigaTwoClubTie(true).table();
  assert.equal(result.complete, true);
  assert.deepEqual(result.rows.map((row) => row.clubId), ["D", "A", "B", "C"]);
  const a = result.rows.find((row) => row.clubId === "A")!;
  const b = result.rows.find((row) => row.clubId === "B")!;
  assert(a.goalsFor - a.goalsAgainst < b.goalsFor - b.goalsAgainst);
  assert.equal(a.rankUncertain, false);
  assert.equal(b.rankUncertain, false);
});

test("La Liga incomplete head-to-head evidence retains an uncertain interval instead of an invented tiebreak", () => {
  const result = laLigaTwoClubTie(false).table();
  assert.equal(result.complete, true, "result coverage can be complete while tied positions remain uncertain");
  assert.deepEqual(result.rows.filter((row) => ["A", "B"].includes(row.clubId)).map((row) => [row.position, row.rankUncertain]), [[2, true], [2, true]]);
  assert(result.issues.some((issue) => issue.code === "incomplete_head_to_head"));
});

test("La Liga recomputes the remaining two-club tie after a multiway mini-table separates one club", () => {
  const data = setup(["A", "B", "C", "D", "E"], "laliga-es");
  data.coverage.timezone = "Europe/Madrid";
  data.final("A", "B", 2, 0);
  data.final("B", "A", 0, 0);
  data.final("A", "C", 4, 0);
  data.final("C", "A", 0, 0);
  data.final("B", "C", 1, 0);
  data.final("C", "B", 2, 0);
  data.final("A", "D", 0, 1);
  data.final("D", "A", 1, 0);
  data.final("B", "D", 10, 0);
  data.final("D", "B", 0, 0);
  data.final("C", "D", 1, 0);
  data.final("D", "C", 0, 0);
  data.final("D", "E", 1, 0);
  const result = data.table();
  assert.equal(result.complete, true);
  assert.deepEqual(result.rows.map((row) => row.clubId), ["D", "A", "C", "B", "E"]);
  assert(result.rows.filter((row) => ["A", "B", "C"].includes(row.clubId)).every((row) => row.points === 8));
});

test("La Liga unavailable final fair-play or deciding-match criteria preserve tied ranks", () => {
  const data = setup(["A", "B"], "laliga-es");
  data.final("A", "B", 0, 0);
  data.final("B", "A", 0, 0);
  assert.deepEqual(data.table().rows.map((row) => [row.position, row.rankUncertain]), [[1, true], [1, true]]);
});

test("new leagues never receive a former competition deduction or unsupported fallback tie rules", () => {
  for (const id of ["premier-league-gb-eng", "laliga-es"]) {
    const data = setup(["3072", "A"], id);
    assert.equal(data.table().rows.find((row) => row.clubId === "3072")!.points, 0);
  }
  const unsupported = setup(["A", "B"], "unsupported");
  unsupported.final("A", "B", 3, 0);
  const result = unsupported.table();
  assert.equal(result.complete, false);
  assert(result.issues.some((issue) => issue.code === "unsupported_standings_rules"));
  assert(result.rows.every((row) => row.position === 1 && row.rankUncertain));
});
