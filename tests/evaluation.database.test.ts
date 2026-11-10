import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { readFrozenEvaluation } from "../src/server/evaluation/database";
import { prepareHistoricalInputs } from "../src/server/forecast/inputs";
import { ForecastStore } from "../src/server/forecast/store";
import { archiveId } from "../src/server/ingestion/archive";
import { coverageFor } from "../src/server/ingestion/coverage";
import { cutoffUtc } from "../src/server/ingestion/standings";
import { IngestionStore } from "../src/server/ingestion/store";
import type { Appearance, ArchivedResponse, Batch, Club, Coverage, Fixture, Player } from "../src/server/ingestion/types";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId)) {
  throw new Error("Evaluation tests require NODE_ENV=test, a dedicated _test database and POSTGRES_TEST_CLUSTER_ID from a disposable PostgreSQL 17 cluster.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const connection = { host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"), database,
  connectionTimeoutMillis: 5_000, statement_timeout: 60_000 };
const coverage = coverageFor("153");
const clubs: Club[] = Array.from({ length: 24 }, (_, index) => ({ id: index === 0 ? "3072" : String(5000 + index), name: `Evaluation club ${index + 1}` }));
const player: Player = { id: "8001", name: "Evaluation forward", position: "FWD" };
let administrator: pg.Client;
let writer: pg.Pool;
let reader: pg.Pool;
let ingestion: IngestionStore;
let schedule: Fixture[];
let observation = 0;

before(async () => {
  administrator = new pg.Client({ ...connection, user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD });
  await administrator.connect();
  const identity = (await administrator.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(identity.name, database);
  assert.equal(identity.identifier, clusterId, "refusing an unconfirmed PostgreSQL cluster");
  assert.equal(Math.trunc(Number(identity.version) / 10_000), 17);
  assert.equal((await administrator.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())")).rowCount, 0,
    "evaluation tests require a disposable PostgreSQL cluster without other databases");
  for (const command of ["provision", "migrate"]) await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), command], {
    cwd: root, timeout: 60_000, maxBuffer: 512_000,
  });
  writer = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD, max: 4 });
  reader = new pg.Pool({ ...connection, user: "lsp_reader", password: process.env.POSTGRES_READER_PASSWORD, max: 3 });
  ingestion = new IngestionStore(writer);
});

after(async () => { await Promise.allSettled([reader?.end(), writer?.end(), administrator?.end()]); });

function appearance(clubId = clubs[0].id, overrides: Partial<Appearance> = {}): Appearance {
  return { player, clubId, participation: "played", minutes: 97, rating: 7.5, goals: 1, assists: 0,
    shotsOnTarget: 3, keyPasses: 1, tackles: 2, interceptions: 1, saves: 0, goalsConceded: 1, ...overrides };
}

function fixture(home: number, away: number) {
  return schedule.find((item) => item.home.id === clubs[home].id && item.away.id === clubs[away].id)!;
}

async function importFixtures(fixtures: Fixture[], league: Readonly<Coverage> = coverage, registeredClubs: Club[] = clubs) {
  const batch: Batch = { coverage: league, clubs: registeredClubs, players: [player], fixtures, standings: [], issues: [] };
  const text = JSON.stringify(batch);
  const source = { action: "get_events" as const, resourceKey: `evaluation:${league.id}:${observation++}`,
    params: { league_id: league.id, timezone: "UTC" }, text, contentSha256: createHash("sha256").update(text).digest("hex"),
    retrievedAt: new Date(Date.parse("2026-11-10T12:00:00.000Z") + observation * 1000).toISOString() };
  const archive: ArchivedResponse = { ...source, id: archiveId(source) };
  await ingestion.import(archive, batch);
}

async function roster(at: string, leagueId = "153", entries: { playerId: string; clubId: string }[] = [{ playerId: player.id, clubId: clubs[0].id }]) {
  const token = randomUUID();
  const sourceId = (await writer.query(`INSERT INTO sports.source_revisions(action,resource_key,archive_ref,content_sha256,retrieved_at)
    VALUES ('get_teams',$1,$2,$3,$4) RETURNING id`, [token, token, "a".repeat(64), at])).rows[0].id;
  const revisionId = (await writer.query(`INSERT INTO sports.normalized_revisions(source_revision_id,entity_type,entity_key,content_sha256)
    VALUES ($1,'roster',$2,$3) RETURNING id`, [sourceId, token, "b".repeat(64)])).rows[0].id;
  const seasonId = (await writer.query(`SELECT cs.id FROM sports.competition_seasons cs JOIN sports.competitions c ON c.id=cs.competition_id
    WHERE c.provider='apifootball' AND c.provider_id=$1 AND cs.label='2026/27'`, [leagueId])).rows[0].id;
  const snapshotId = (await writer.query(`INSERT INTO sports.roster_snapshots(season_id,source_revision_id,observed_at,complete,normalized_revision_id)
    VALUES ($1,$2,$3,true,$4) RETURNING id`, [seasonId, sourceId, at, revisionId])).rows[0].id;
  for (const entry of entries) await writer.query(`INSERT INTO sports.roster_entries(snapshot_id,season_id,player_id,club_id)
    SELECT $1,$2,p.id,c.id FROM sports.players p,sports.clubs c
    WHERE p.provider='apifootball' AND c.provider='apifootball' AND p.provider_id=$3 AND c.provider_id=$4`,
  [snapshotId, seasonId, entry.playerId, entry.clubId]);
}

async function historical(date: string, leagueId = "153") {
  const client = await reader.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return (await prepareHistoricalInputs(client, cutoffUtc(date, coverageFor(leagueId).timezone), date, [player.id])).get(player.id)!;
  } finally { await client.query("ROLLBACK"); client.release(); }
}

async function fingerprint() {
  const tables = (await administrator.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  const result: { table: string; digest: string }[] = [];
  for (const { tablename } of tables) result.push({ table: tablename,
    digest: (await administrator.query(`SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text)::text,'[]')) AS digest FROM sports.${tablename} x`)).rows[0].digest as string });
  return result;
}

beforeEach(async () => {
  const tables = (await administrator.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  await administrator.query(`TRUNCATE ${tables.map((row) => `sports.${row.tablename}`).join(",")} RESTART IDENTITY CASCADE`);
  observation = 0;
  schedule = [];
  for (let home = 0; home < clubs.length; home++) for (let away = 0; away < clubs.length; away++) {
    if (home === away) continue;
    const history = home === 0 && away <= 5;
    const target = home === 0 && away === 6;
    const later = home === 0 && away === 7;
    const finished = history || target || later;
    schedule.push({ id: String(900000 + home * 100 + away), leagueId: "153", season: "2026/27", home: clubs[home], away: clubs[away],
      kickoffAt: history ? `2026-09-0${away}T14:00:00.000Z` : target ? "2026-10-01T14:00:00.000Z" : later ? "2026-11-20T14:00:00.000Z" : "2027-01-20T14:00:00.000Z",
      status: finished ? "final" : "scheduled", statisticsStatus: finished ? "complete" : "missing",
      homeScore: finished ? 2 : null, awayScore: finished ? 1 : null, detailed: finished,
      appearances: finished ? [appearance(clubs[0].id, target ? { rating: 8, goals: 2 } : {})] : [] });
  }
  await importFixtures(schedule);
});

test("a restricted read-only snapshot scores paired cases without changing any canonical or operational rows", async () => {
  await roster("2026-07-01T00:00:00.000Z");
  await new ForecastStore(writer).refresh(player.id, "2026-09-10T12:00:00.000Z");
  const before = await fingerprint();
  assert.equal((await reader.query("SELECT current_user AS name")).rows[0].name, "lsp_reader");
  await assert.rejects(reader.query("UPDATE sports.players SET name=name WHERE false"), { code: "42501" });
  await assert.rejects(readFrozenEvaluation(writer), /restricted reader role/);
  const { report, audit } = await readFrozenEvaluation(reader);
  assert.equal(report.candidateTargets, 1);
  assert.equal(report.eligibleTargets, 1);
  assert.equal(report.scoredTargetCases, 1);
  assert.equal(audit[0].selectedTargetFixtureId, fixture(0, 6).id);
  assert.deepEqual(audit[0].selectedFixtureIds, [1, 2, 3, 4, 5].map((away) => fixture(0, away).id));
  const goals = report.cohorts.find((item) => item.leagueId === "all" && item.position === "all" && item.output === "goals")!;
  assert.equal(goals.scored, 1);
  assert.equal(goals.coverage, 1);
  assert.equal(goals.errors.heuristic.count, 1);
  assert(goals.errors.heuristic.mae! > 0);
  for (const baseline of Object.values(goals.errors.baselines)) assert.equal(baseline.count, 1);
  const prepared = await historical("2026-10-01");
  assert.equal(prepared.input.targets.find((item) => item.fixtureId === fixture(0, 6).id)!.status, "scheduled");
  assert.equal(prepared.input.appearances.some((item) => item.fixtureId === fixture(0, 6).id), false);
  assert.equal((await reader.query("SELECT status FROM sports.fixtures WHERE provider_id=$1", [fixture(0, 6).id])).rows[0].status, "final");
  assert.deepEqual(await fingerprint(), before);
});

test("target and later outcomes cannot change the earlier frozen input hash", async () => {
  await roster("2026-07-01T00:00:00.000Z");
  const before = await readFrozenEvaluation(reader);
  const target = { ...fixture(0, 6), homeScore: 8, appearances: [appearance(clubs[0].id, { rating: 9.25, goals: 4 })] };
  const later = { ...fixture(0, 7), homeScore: 9, awayScore: 0, appearances: [appearance(clubs[0].id, { rating: 10, goals: 9 })] };
  await importFixtures([target, later]);
  const after = await readFrozenEvaluation(reader);
  assert.notEqual(before.report.source.sourceOrdinal, after.report.source.sourceOrdinal);
  assert.equal(before.audit[0].inputHash, after.audit[0].inputHash);
  assert.deepEqual(before.audit[0].selectedFixtureIds, after.audit[0].selectedFixtureIds);
  assert.equal(before.audit[0].selectedTargetFixtureId, after.audit[0].selectedTargetFixtureId);
  const goals = (result: typeof before) => result.report.cohorts.find((item) => item.leagueId === "all" && item.position === "all" && item.output === "goals")!;
  assert.equal(goals(before).scored, 1);
  assert.equal(goals(after).scored, 1);
  assert.notEqual(goals(before).errors.heuristic.mae, goals(after).errors.heuristic.mae, "changed actual outcomes affect errors, never frozen inputs");
});

test("a roster observed after the target freeze cannot establish historical current membership", async () => {
  await roster("2026-10-01T00:00:00.000Z");
  const prepared = await historical("2026-10-01");
  assert.equal(prepared.input.appearances.length, 5);
  assert.equal(prepared.input.currentClub, null);
  assert(prepared.input.rosterReasons.some((reason) => reason.code === "missing_roster_observation"));
  const { report } = await readFrozenEvaluation(reader);
  assert.equal(report.eligibleTargets, 1);
  assert.equal(report.scoredTargetCases, 0);
  for (const cohort of report.cohorts) {
    assert.equal(cohort.scored, 0);
    assert.equal(cohort.coverage, 0);
    assert.deepEqual(cohort.errors.heuristic, { count: 0, mae: null, medianAbsoluteError: null });
    assert(cohort.exclusions.some((reason) => reason.code === "missing_roster_observation"));
    for (const baseline of Object.values(cohort.errors.baselines)) assert.equal(baseline.mae, null);
  }
});

test("whole-match target statistics gaps remain visible outside the observed-player denominator", async () => {
  await roster("2026-07-01T00:00:00.000Z");
  await importFixtures([{ ...fixture(2, 3), kickoffAt: "2026-10-03T14:00:00.000Z", status: "final", statisticsStatus: "missing",
    homeScore: 1, awayScore: 0, detailed: false, appearances: [] }]);
  const { report } = await readFrozenEvaluation(reader);
  assert.equal(report.candidateTargets, 1);
  assert.equal(report.scoredTargetCases, 1);
  const profile = report.fixtureCoverage.find((item) => item.leagueId === "153")!;
  assert.equal(profile.finalFixtures, 2);
  assert.equal(profile.finalsWithAppearances, 1);
  assert.equal(profile.finalsWithoutAppearances, 1);
  assert.equal(profile.finalsWithMissingStatistics, 1);
});

test("the adapter excludes Paris same-day history that precedes the London UTC freeze", async () => {
  await roster("2026-07-01T00:00:00.000Z");
  const before = await readFrozenEvaluation(reader);
  const french = coverageFor("164");
  const frenchClubs = Array.from({ length: 18 }, (_, index) => ({ id: String(7000 + index), name: `Evaluation French club ${index + 1}` }));
  const frenchSchedule: Fixture[] = [];
  let boundaryId = "";
  for (let home = 0; home < frenchClubs.length; home++) for (let away = 0; away < frenchClubs.length; away++) {
    if (home === away) continue;
    const boundary = home === 0 && away === 1;
    const id = String(1000000 + home * 100 + away);
    if (boundary) boundaryId = id;
    frenchSchedule.push({ id, leagueId: "164", season: "2026/27", home: frenchClubs[home], away: frenchClubs[away],
      kickoffAt: boundary ? "2026-09-30T22:30:00.000Z" : "2027-01-20T14:00:00.000Z", status: boundary ? "final" : "scheduled",
      statisticsStatus: boundary ? "complete" : "missing", homeScore: boundary ? 3 : null, awayScore: boundary ? 0 : null,
      detailed: boundary, appearances: boundary ? [appearance(frenchClubs[0].id, { rating: 10, goals: 3 })] : [] });
  }
  await importFixtures(frenchSchedule, french, frenchClubs);
  await roster("2026-07-01T00:00:00.000Z", "164", []);
  const prepared = await historical("2026-10-01");
  assert.equal(prepared.input.appearances.some((item) => item.fixtureId === boundaryId), false);
  assert.equal(prepared.input.gaps.some((item) => item.fixtureId === boundaryId), false);
  assert.equal(prepared.input.currentClub?.leagueId, "153");
  const after = await readFrozenEvaluation(reader);
  const englishAudit = after.audit.find((item) => item.fixtureId === fixture(0, 6).id)!;
  assert.equal(englishAudit.inputHash, before.audit[0].inputHash);
  assert.deepEqual(englishAudit.selectedFixtureIds, before.audit[0].selectedFixtureIds);
});

test("historical SQL batches use the correct local midnight on both sides of the October clock change", async () => {
  await roster("2026-07-01T00:00:00.000Z");
  const first = { ...fixture(0, 6), kickoffAt: "2026-10-25T14:00:00.000Z" };
  const second = { ...fixture(0, 8), kickoffAt: "2026-10-26T14:00:00.000Z", status: "final" as const, statisticsStatus: "complete" as const,
    homeScore: 2, awayScore: 1, detailed: true, appearances: [appearance()] };
  await importFixtures([first, second]);
  const { report, audit } = await readFrozenEvaluation(reader);
  assert.equal(report.candidateTargets, 2);
  assert.equal(report.scoredTargetCases, 2);
  assert.equal(audit.find((item) => item.fixtureId === first.id)!.cutoffAt, "2026-10-24T23:00:00.000Z");
  assert.equal(audit.find((item) => item.fixtureId === second.id)!.cutoffAt, "2026-10-26T00:00:00.000Z");
  assert(audit.find((item) => item.fixtureId === second.id)!.selectedFixtureIds.includes(first.id));
});
