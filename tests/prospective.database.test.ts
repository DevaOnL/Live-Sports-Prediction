import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { readCaptureFile, writeCaptureFile, writeConfirmedCaptureFile } from "../scripts/measure";
import { captureProspective, scoreProspective } from "../src/server/evaluation/prospective";
import { archiveId } from "../src/server/ingestion/archive";
import { coverageFor } from "../src/server/ingestion/coverage";
import { IngestionStore } from "../src/server/ingestion/store";
import type { Appearance, ArchivedResponse, Batch, Club, Fixture, Player } from "../src/server/ingestion/types";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId)) {
  throw new Error("Prospective tests require NODE_ENV=test, a dedicated _test database and POSTGRES_TEST_CLUSTER_ID from a disposable PostgreSQL 17 cluster.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const connection = { host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"), database,
  connectionTimeoutMillis: 5_000, statement_timeout: 60_000 };
const coverage = coverageFor("153");
const clubs: Club[] = Array.from({ length: 24 }, (_, index) => ({ id: index === 0 ? "3072" : String(5000 + index), name: `Prospective club ${index + 1}` }));
const player: Player = { id: "8001", name: "Prospective forward", position: "FWD" };
const newcomer: Player = { id: "8002", name: "Later observed forward", position: "FWD" };
let administrator: pg.Client;
let writer: pg.Pool;
let reader: pg.Pool;
let ingestion: IngestionStore;
let schedule: Fixture[];
let observationAt: string;
let observation: number;
const capturedAt = "2026-11-10T12:00:00.000Z";
const scoredAt = "2026-11-13T12:00:00.000Z";

// Only this test adapter controls the exact wall-clock SELECT. Every connection,
// role check, SQL statement, transaction and canonical read uses the guarded real
// PostgreSQL cluster. Production measurement has no configurable clock.
function withClock(pool: pg.Pool, at: string): pg.Pool {
  return new Proxy(pool, {
    get(target, key) {
      if (key === "connect") return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(connection, property) {
            if (property === "query") return (text: unknown, ...args: unknown[]) => text === "SELECT clock_timestamp() AS at"
              ? Promise.resolve({ rows: [{ at: new Date(at) }] })
              : Reflect.apply(connection.query, connection, [text, ...args]);
            const value = Reflect.get(connection, property);
            return typeof value === "function" ? value.bind(connection) : value;
          },
        });
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

before(async () => {
  administrator = new pg.Client({ ...connection, user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD });
  await administrator.connect();
  const identity = (await administrator.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(identity.name, database);
  assert.equal(identity.identifier, clusterId, "refusing an unconfirmed PostgreSQL cluster");
  assert.equal(Math.trunc(Number(identity.version) / 10_000), 17);
  assert.equal((await administrator.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())")).rowCount, 0,
    "prospective tests require a disposable PostgreSQL cluster without other databases");
  for (const command of ["provision", "migrate"]) await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), command], {
    cwd: root, timeout: 60_000, maxBuffer: 512_000,
  });
  writer = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD, max: 3 });
  reader = new pg.Pool({ ...connection, user: "lsp_reader", password: process.env.POSTGRES_READER_PASSWORD, max: 2 });
  ingestion = new IngestionStore(writer);
});

after(async () => { await Promise.allSettled([reader?.end(), writer?.end(), administrator?.end()]); });

function appearance(athlete = player, clubId = clubs[0].id, overrides: Partial<Appearance> = {}): Appearance {
  return { player: athlete, clubId, participation: "played", minutes: 97, rating: 7.5, goals: 1, assists: 0,
    shotsOnTarget: 3, keyPasses: 1, tackles: 2, interceptions: 1, saves: 0, goalsConceded: 1, ...overrides };
}

function fixture(home: number, away: number) {
  return schedule.find((item) => item.home.id === clubs[home].id && item.away.id === clubs[away].id)!;
}

async function importFixtures(fixtures: Fixture[], players = [player]) {
  const batch: Batch = { coverage, clubs, players, fixtures, standings: [], issues: [] };
  const text = JSON.stringify(batch);
  const source = { action: "get_events" as const, resourceKey: `prospective:${randomUUID()}`,
    params: { league_id: coverage.id, timezone: "UTC" }, text, contentSha256: createHash("sha256").update(text).digest("hex"),
    retrievedAt: new Date(Date.parse(observationAt) + observation++ * 1000).toISOString() };
  const archive: ArchivedResponse = { ...source, id: archiveId(source) };
  await ingestion.import(archive, batch);
}

async function roster() {
  const token = randomUUID();
  const at = "2026-10-01T00:00:00.000Z";
  const sourceId = (await writer.query(`INSERT INTO sports.source_revisions(action,resource_key,archive_ref,content_sha256,retrieved_at)
    VALUES ('get_teams',$1,$2,$3,$4) RETURNING id`, [token, token, "a".repeat(64), at])).rows[0].id;
  const revisionId = (await writer.query(`INSERT INTO sports.normalized_revisions(source_revision_id,entity_type,entity_key,content_sha256)
    VALUES ($1,'roster',$2,$3) RETURNING id`, [sourceId, token, "b".repeat(64)])).rows[0].id;
  const seasonId = (await writer.query(`SELECT cs.id FROM sports.competition_seasons cs JOIN sports.competitions c ON c.id=cs.competition_id
    WHERE c.provider='apifootball' AND c.provider_id='153' AND cs.label='2026/27'`)).rows[0].id;
  const snapshotId = (await writer.query(`INSERT INTO sports.roster_snapshots(season_id,source_revision_id,observed_at,complete,normalized_revision_id)
    VALUES ($1,$2,$3,true,$4) RETURNING id`, [seasonId, sourceId, at, revisionId])).rows[0].id;
  await writer.query(`INSERT INTO sports.roster_entries(snapshot_id,season_id,player_id,club_id)
    SELECT $1,$2,p.id,c.id FROM sports.players p,sports.clubs c
    WHERE p.provider='apifootball' AND c.provider='apifootball' AND p.provider_id=$3 AND c.provider_id=$4`,
  [snapshotId, seasonId, player.id, clubs[0].id]);
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
  observationAt = "2026-11-09T12:00:00.000Z";
  observation = 0;
  schedule = [];
  for (let home = 0; home < clubs.length; home++) for (let away = 0; away < clubs.length; away++) {
    if (home === away) continue;
    const history = home === 0 && away <= 5;
    schedule.push({ id: String(900000 + home * 100 + away), leagueId: "153", season: "2026/27", home: clubs[home], away: clubs[away],
      kickoffAt: history ? `2026-11-0${away}T14:00:00.000Z` : home === 0 && away === 6 ? "2026-11-12T14:00:00.000Z" : "2027-01-20T14:00:00.000Z",
      status: history ? "final" : "scheduled", statisticsStatus: history ? "complete" : "missing",
      homeScore: history ? 2 : null, awayScore: history ? 1 : null, detailed: history,
      appearances: history ? [appearance()] : [] });
  }
  await importFixtures(schedule);
  await roster();
});

test("future capture and later paired scoring are read-only and retain newly observed players in coverage", async () => {
  await assert.rejects(captureProspective(withClock(writer, capturedAt)), /reader/i);
  const before = await fingerprint();
  const capture = await captureProspective(withClock(reader, capturedAt));
  assert.deepEqual(await fingerprint(), before);
  assert(capture.fixtures.length > 0);
  assert(capture.fixtures.every((target) => Date.parse(capture.completedAt) < Date.parse(target.issueCutoffAt)));
  const forecast = capture.players.find((item) => item.playerId === player.id)!;
  assert(forecast);
  assert.equal(forecast.result.forecastRating.status, "available");
  assert.equal(forecast.result.target?.fixtureId, fixture(0, 6).id);
  const frozen = JSON.stringify(capture);
  const pending = await scoreProspective(withClock(reader, capturedAt), capture);
  assert(pending.fixtureCoverage.pending > 0);
  assert.equal(pending.eligibleTargets, 0);
  assert.equal(pending.scoredTargetCases, 0);
  assert.deepEqual(await fingerprint(), before);

  observationAt = "2026-11-12T16:00:00.000Z";
  await importFixtures([{ ...fixture(0, 6), status: "final", statisticsStatus: "complete", homeScore: 2, awayScore: 1, detailed: true,
    appearances: [appearance(player, clubs[0].id, { rating: 8.5, goals: 2 }), appearance(newcomer, clubs[6].id)] }], [player, newcomer]);
  const finalized = await fingerprint();
  const report = await scoreProspective(withClock(reader, scoredAt), capture);
  assert.deepEqual(await fingerprint(), finalized);
  assert.equal(report.fixtureCoverage.finalsWithCompleteStatistics, 1);
  assert.equal(report.fixtureCoverage.finalsWithPartialStatistics, 0);
  assert.equal(report.fixtureCoverage.finalsWithMissingStatistics, 0);
  assert.equal(report.fixtureCoverage.finalsWithUnknownStatistics, 0);
  assert.equal(report.eligibleTargets, 2, "newly observed players remain in the observed-eligible denominator");
  assert.equal(report.scoredTargetCases, 1);
  const rating = report.cohorts.find((item) => item.leagueId === "all" && item.position === "all" && item.output === "rating")!;
  assert.equal(rating.eligibleTargets, 2);
  assert.equal(rating.scored, 1);
  assert.equal(rating.coverage, 0.5);
  assert.equal(rating.errors.heuristic.count, 1);
  assert.equal(rating.errors.baselines.ratingMean!.count, 1);
  assert(rating.exclusions.some((reason) => reason.code === "prediction_not_captured" && reason.count === 1));
  assert.equal(JSON.stringify(capture), frozen);

  await importFixtures([{ ...fixture(0, 1), appearances: [appearance(player, clubs[0].id, { rating: 1, goals: 0 })] }]);
  const corrected = await scoreProspective(withClock(reader, scoredAt), capture);
  assert.deepEqual(corrected.cohorts, report.cohorts, "later canonical history corrections cannot change frozen predictions or baselines");
  assert.equal(JSON.stringify(capture), frozen);
  await importFixtures([{ ...fixture(0, 6), status: "final", statisticsStatus: "complete", homeScore: 2, awayScore: 1, detailed: true,
    appearances: [appearance(player, clubs[0].id, { rating: 9.5, goals: 3 }), appearance(newcomer, clubs[6].id)] }], [player, newcomer]);
  const changedOutcome = await scoreProspective(withClock(reader, scoredAt), capture);
  const changedRating = changedOutcome.cohorts.find((item) => item.leagueId === "all" && item.position === "all" && item.output === "rating")!;
  assert.notEqual(changedRating.errors.heuristic.mae, rating.errors.heuristic.mae);
  assert.equal(JSON.stringify(capture), frozen);
  await assert.rejects(scoreProspective(withClock(writer, scoredAt), capture), /reader/i);
});

test("later schedule metadata and missing whole-match outcomes remain explicit exclusions", async () => {
  const capture = await captureProspective(withClock(reader, capturedAt));
  const target = fixture(0, 6);
  observationAt = "2026-11-12T16:00:00.000Z";
  await importFixtures([{ ...target, kickoffAt: new Date(Date.parse(target.kickoffAt!) + 3_600_000).toISOString(),
    status: "final", statisticsStatus: "complete", homeScore: 2, awayScore: 1, detailed: true, appearances: [appearance()] }]);
  let report = await scoreProspective(withClock(reader, scoredAt), capture);
  assert.equal(report.fixtureCoverage.metadataChanged, 1);
  assert.equal(report.scoredTargetCases, 0);
  await importFixtures([{ ...target, status: "final", statisticsStatus: "missing", homeScore: 2, awayScore: 1, detailed: false, appearances: [] }]);
  // The importer conservatively retains earlier appearance evidence; delete only
  // from this identity-guarded fixture to demonstrate an actually absent outcome.
  await writer.query("DELETE FROM sports.appearances WHERE fixture_id=(SELECT id FROM sports.fixtures WHERE provider='apifootball' AND provider_id=$1)", [target.id]);
  await writer.query("UPDATE sports.fixtures SET statistics_status='missing' WHERE provider='apifootball' AND provider_id=$1", [target.id]);
  report = await scoreProspective(withClock(reader, scoredAt), capture);
  assert.equal(report.fixtureCoverage.finalsWithoutAppearances, 1);
  assert.equal(report.fixtureCoverage.finalsWithCompleteStatistics, 0);
  assert.equal(report.fixtureCoverage.finalsWithPartialStatistics, 0);
  assert.equal(report.fixtureCoverage.finalsWithMissingStatistics, 1);
  assert.equal(report.fixtureCoverage.finalsWithUnknownStatistics, 0);
  assert.equal(report.eligibleTargets, 0);
  assert.equal(report.scoredTargetCases, 0);
});

test("a same-day earliest fixture misses its midnight issue cutoff without promoting a later fixture", async () => {
  const target = fixture(0, 6);
  await importFixtures([{ ...target, kickoffAt: "2026-11-10T14:00:00.000Z" }]);
  const before = await fingerprint();
  const capture = await captureProspective(withClock(reader, capturedAt));
  assert.deepEqual(await fingerprint(), before);
  assert(capture.missedIssueCutoffs.some((item) => item.fixtureId === target.id));
  assert(!capture.fixtures.some((item) => item.fixtureId === target.id));
  assert(capture.fixtures.every((item) => !item.earliestForClubIds.includes(clubs[0].id)),
    "another club's earliest target cannot silently become the missed club's next issue");
  const report = await scoreProspective(withClock(reader, capturedAt), capture);
  assert.equal(report.fixtureCoverage.missedIssueCutoffs, capture.missedIssueCutoffs.length);
});

test("durable capture files require an on-time reader confirmation and preserve existing destinations", async () => {
  const capture = await captureProspective(withClock(reader, capturedAt));
  const before = await fingerprint();
  const directory = await mkdtemp(join(tmpdir(), "lsp-prospective-confirmation-"));
  try {
    const path = join(directory, "on-time.private.json");
    const confirmedAt = "2026-11-10T12:01:00.000Z";
    assert.equal(await writeConfirmedCaptureFile(path, capture, withClock(reader, confirmedAt)), confirmedAt);
    assert.deepEqual(await readCaptureFile(path), capture);
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[1]), { schemaVersion: 1, kind: "prospective-confirmation-v1",
      captureDigest: capture.digest, durablyConfirmedAt: confirmedAt });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const pendingPath = join(directory, "unconfirmed.private.json");
    await writeCaptureFile(pendingPath, capture);
    await assert.rejects(readCaptureFile(pendingPath), /unconfirmed/i);
    const latePath = join(directory, "late.private.json");
    const firstMidnight = capture.fixtures.map((fixture) => fixture.issueCutoffAt).sort()[0];
    await assert.rejects(writeConfirmedCaptureFile(latePath, capture, withClock(reader, firstMidnight)));
    await assert.rejects(stat(latePath), { code: "ENOENT" });
    const existingPath = join(directory, "existing.private.json");
    await writeFile(existingPath, "existing private evidence", { mode: 0o600 });
    await assert.rejects(writeConfirmedCaptureFile(existingPath, capture, withClock(reader, confirmedAt)));
    assert.equal(await readFile(existingPath, "utf8"), "existing private evidence");
    assert.deepEqual(await fingerprint(), before);
  } finally { await rm(directory, { recursive: true, force: true }); }

  const statuses = ["complete", "partial", "missing", "unknown"];
  assert(capture.fixtures.length >= statuses.length);
  for (const [index, status] of statuses.entries()) await writer.query(`UPDATE sports.fixtures
    SET status='final',statistics_status=$1,home_score=1,away_score=0 WHERE provider='apifootball' AND provider_id=$2`,
  [status, capture.fixtures[index].fixtureId]);
  const report = await scoreProspective(withClock(reader, scoredAt), capture);
  assert.equal(report.fixtureCoverage.finalsWithCompleteStatistics, 1);
  assert.equal(report.fixtureCoverage.finalsWithPartialStatistics, 1);
  assert.equal(report.fixtureCoverage.finalsWithMissingStatistics, 1);
  assert.equal(report.fixtureCoverage.finalsWithUnknownStatistics, 1);
});
