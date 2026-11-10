import assert from "node:assert/strict";
import { test } from "node:test";
import type pg from "pg";
import type { Context, ForecastInput, HistoryAppearance, PreparedInput } from "../src/server/forecast/types";
import { isolatedReplayEnvironment } from "../src/server/replay/run";
import { readReplaySnapshot, replayPlan, REPLAY_COLUMNS } from "../src/server/replay/snapshot";

function prepared(): PreparedInput {
  const context: Context = { complete: true, clubs: 24, own: { rank: 1, tiedCount: 1, uncertain: false },
    opponent: { rank: 24, tiedCount: 1, uncertain: false }, key: "synthetic-context", cutoffAt: "2026-11-10T00:00:00.000Z", reasons: [] };
  const appearances: HistoryAppearance[] = Array.from({ length: 6 }, (_, index) => ({
    fixtureId: String(1001 + index), leagueId: "153", season: "2026/27", competition: "championship", covered: true,
    kickoffAt: `2026-09-0${index + 1}T15:00:00.000Z`, status: "final", homeClubId: "301", awayClubId: "302",
    clubId: "301", membershipKnown: true, participation: "played", minutes: index === 0 ? 60 : 97,
    rating: 6 + index / 2, metrics: { goals: index % 2, assists: 0, shotsOnTarget: 2, keyPasses: 1,
      tackles: 1, interceptions: 0, saves: 0, goalsConceded: 0 }, context,
  }));
  const input: ForecastInput = { player: { id: "8001", position: "FWD" }, cutoffAt: "2026-11-10T12:00:00.000Z",
    appearances, gaps: [], rosterReasons: [], currentClub: { clubId: "301", leagueId: "153", season: "2026/27" },
    targets: [{ fixtureId: "2001", leagueId: "153", season: "2026/27", competition: "championship", kickoffAt: "2026-11-12T15:00:00.000Z",
      homeClubId: "301", awayClubId: "302", status: "scheduled", context }] };
  return { input, provenance: {}, sourceOrdinal: "17" };
}

test("replay selects the actual latest six, retaining a weak oldest appearance until the sixth arrives", () => {
  const source = prepared();
  const saved = structuredClone(source);
  const plan = replayPlan(source);
  assert(plan);
  assert.deepEqual(plan.beforeSelected, ["1001", "1002", "1003", "1004", "1005"]);
  assert.deepEqual(plan.afterSelected, ["1002", "1003", "1004", "1005", "1006"]);
  assert.equal(plan.sixthFixtureId, "1006");
  assert.equal(plan.expectedResult.forecastRating.status, "available");
  assert.deepEqual(source, saved, "planning cannot edit real observations");
});

test("replay refuses short, unknown and duplicate evidence instead of manufacturing a sixth", () => {
  for (const change of [
    (input: ForecastInput) => { input.appearances[5].minutes = 59; },
    (input: ForecastInput) => { input.appearances[5].minutes = null; },
    (input: ForecastInput) => { input.appearances[5].membershipKnown = false; },
    (input: ForecastInput) => { input.appearances[5].participation = "unknown"; },
    (input: ForecastInput) => { input.appearances[5].status = "live"; },
    (input: ForecastInput) => { input.appearances.push(structuredClone(input.appearances[5])); },
  ]) {
    const source = prepared(); change(source.input); assert.equal(replayPlan(source), null);
  }
});

test("replay preserves roster, missing-metric, schedule and historical incompleteness gates", () => {
  for (const change of [
    (input: ForecastInput) => { input.currentClub = null; input.rosterReasons = [{ code: "missing_roster_observation" }]; },
    (input: ForecastInput) => { input.appearances[4].metrics.goals = null; },
    (input: ForecastInput) => { input.targets[0].status = "final"; },
    (input: ForecastInput) => { input.targets[0].context!.complete = false; },
    (input: ForecastInput) => { input.gaps.push({ code: "missing_appearance_evidence", fixtureId: "1500", kickoffAt: "2026-09-06T16:00:00.000Z" }); },
  ]) {
    const source = prepared(); change(source.input); assert.equal(replayPlan(source), null);
  }
});

test("the withheld sixth cannot supply its own only club checkpoint", () => {
  const transfer = prepared();
  for (const appearance of transfer.input.appearances.slice(0, 5)) {
    appearance.clubId = "303"; appearance.homeClubId = "303";
  }
  assert.equal(replayPlan(transfer), null);
  const interruptedTenure = prepared();
  interruptedTenure.provenance.rosterObservations = [{ observedAt: "2026-09-05T16:00:00.000Z", playerClubIds: [] }];
  assert.equal(replayPlan(interruptedTenure), null, "do not assume a roster exclusion preserves an earlier club checkpoint");
});

test("isolated child configuration excludes source secrets and Node/PostgreSQL execution overrides", () => {
  const isolated = isolatedReplayEnvironment({ NODE_ENV: "production", PATH: "/bin", HOME: "/tmp/example", DOCKER_HOST: "unix:///example",
    POSTGRES_READER_PASSWORD: "source-password", POSTGRES_HOST: "source-host", PGHOST: "source-host", DATABASE_URL: "source-url",
    MONGO_WORKER_PASSWORD: "document-password", APIFOOTBALL_API_KEY: "provider-key", BETTER_AUTH_SECRET: "auth-key",
    NODE_OPTIONS: "--require=/secret-hook", LD_PRELOAD: "/secret-hook" });
  assert.deepEqual(isolated, { NODE_ENV: "test", PATH: "/bin", HOME: "/tmp/example", DOCKER_HOST: "unix:///example" });
});

test("replay source rejects any role or transaction that could confuse live reads with writes", async () => {
  for (const identity of [
    { name: "lsp_writer", read_only: "on", writer: false, migrator: false, auth: false, superuser: false },
    { name: "lsp_reader", read_only: "off", writer: false, migrator: false, auth: false, superuser: false },
    { name: "lsp_reader", read_only: "on", writer: true, migrator: false, auth: false, superuser: false },
    { name: "lsp_reader", read_only: "on", writer: false, migrator: true, auth: false, superuser: false },
    { name: "lsp_reader", read_only: "on", writer: false, migrator: false, auth: true, superuser: false },
    { name: "lsp_reader", read_only: "on", writer: false, migrator: false, auth: false, superuser: true },
  ]) {
    const statements: string[] = [];
    let released = false;
    const client = { query: async (sql: string) => { statements.push(sql); return { rows: sql.startsWith("SELECT current_user") ? [identity] : [] }; },
      release: () => { released = true; } };
    const pool = { connect: async () => client } as unknown as pg.Pool;
    await assert.rejects(readReplaySnapshot(pool), /restricted reader/);
    assert.equal(statements[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.equal(statements.at(-1), "ROLLBACK");
    assert.equal(statements.length, 3);
    assert.equal(released, true);
  }
});

test("the replay copy allowlist excludes payload bodies, authentication and processing records", () => {
  assert.deepEqual(Object.keys(REPLAY_COLUMNS), ["source_revisions", "normalized_revisions", "competitions", "competition_seasons", "clubs",
    "season_clubs", "players", "player_memberships", "fixtures", "appearances", "roster_snapshots", "roster_entries", "points_adjustments"]);
  assert(!Object.values(REPLAY_COLUMNS).flat().some((column) => /password|secret|token|payload|email/i.test(column)));
});
