import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MongoClient, type Db } from "mongodb";
import pg from "pg";
import { ArchiveStore, archiveId } from "../src/server/ingestion/archive";
import { coverageFor } from "../src/server/ingestion/coverage";
import { JobQueue } from "../src/server/ingestion/jobs";
import { normalizeResponse } from "../src/server/ingestion/normalize";
import { IngestionPipeline } from "../src/server/ingestion/pipeline";
import { ProviderError } from "../src/server/ingestion/provider";
import { localDate, reconstructStandings } from "../src/server/ingestion/standings";
import { IngestionStore, RateLimitError } from "../src/server/ingestion/store";
import type { Appearance, ArchivedResponse, Batch, Fixture, ProviderResponse } from "../src/server/ingestion/types";

// Provisioning mutates roles. Verify both disposable servers before any mutation.
const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
const mongoDatabase = process.env.MONGO_TEST_DATABASE ?? "";
const mongoPortText = process.env.MONGO_TEST_PORT ?? "";
const mongoHostId = process.env.MONGO_TEST_HOST_ID ?? "";
const testName = /^[a-z][a-z0-9_]{0,57}_test$/;
if (process.env.NODE_ENV !== "test" || !testName.test(database) || !/^\d{10,20}$/.test(clusterId)
  || !testName.test(mongoDatabase) || process.env.MONGO_DB !== mongoDatabase
  || !/^\d{1,5}$/.test(mongoPortText) || Number(mongoPortText) < 1 || Number(mongoPortText) > 65535
  || !mongoHostId || /[\s\u0000-\u001f]/.test(mongoHostId)) {
  throw new Error("Ingestion tests require dedicated _test databases, NODE_ENV=test, POSTGRES_TEST_CLUSTER_ID, MONGO_DB=MONGO_TEST_DATABASE, MONGO_TEST_PORT and MONGO_TEST_HOST_ID from disposable servers.");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const connection = {
  host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"),
  database, connectionTimeoutMillis: 5_000, statement_timeout: 30_000,
};
const coverage = coverageFor("153");
const clubs = Array.from({ length: 24 }, (_, index) => ({ id: index === 0 ? "3072" : String(5000 + index), name: `Test club ${index + 1}` }));
let administrator: pg.Client;
let pool: pg.Pool;
let mongoAdmin: MongoClient;
let mongoWorker: MongoClient;
let mongo: Db;
let archives: ArchiveStore;
let store: IngestionStore;
let observation = 0;

async function cli(script: string, args: string[] = []): Promise<void> {
  const result = await execute(process.execPath, ["--import", "tsx", join(root, "scripts", script), ...args], {
    cwd: root, timeout: 60_000, maxBuffer: 512_000,
    env: { ...process.env, MONGO_PORT: mongoPortText, MONGO_DB: mongoDatabase },
  });
  assert.equal(result.stderr, "");
}

before(async () => {
  administrator = new pg.Client({ ...connection, user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD });
  await administrator.connect();
  const server = (await administrator.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(server.name, database);
  assert.equal(server.identifier, clusterId, "refusing an unconfirmed PostgreSQL cluster");
  assert.equal(Math.trunc(Number(server.version) / 10_000), 17);
  assert.equal((await administrator.query(`SELECT datname FROM pg_database
    WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())`)).rowCount, 0,
  "ingestion tests require a disposable PostgreSQL cluster without other databases");
  const mongoHost = process.env.MONGO_HOST ?? "127.0.0.1";
  mongoAdmin = new MongoClient(`mongodb://${mongoHost}:${mongoPortText}`, {
    auth: { username: process.env.MONGO_BOOTSTRAP_USER ?? "sports_bootstrap", password: process.env.MONGO_BOOTSTRAP_PASSWORD ?? "" },
    authSource: "admin", serverSelectionTimeoutMS: 5_000,
  });
  await mongoAdmin.connect();
  const adminDb = mongoAdmin.db("admin");
  const [build, host, databases] = await Promise.all([
    adminDb.command({ buildInfo: 1 }), adminDb.command({ hostInfo: 1 }), adminDb.admin().listDatabases(),
  ]);
  assert.match(build.version, /^8\./);
  assert.equal(host.system.hostname, mongoHostId, "refusing an unconfirmed MongoDB server");
  assert.deepEqual(databases.databases.map((entry) => entry.name).filter((name) => !["admin", "config", "local", mongoDatabase].includes(name)), [],
    "ingestion tests require a disposable MongoDB server without other databases");
  await cli("db.ts", ["provision"]);
  await cli("db.ts", ["migrate"]);
  await cli("mongo.ts");
  pool = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD, max: 12 });
  mongoWorker = new MongoClient(`mongodb://${mongoHost}:${mongoPortText}`, {
    auth: { username: process.env.MONGO_WORKER_USER ?? "lsp_ingestion", password: process.env.MONGO_WORKER_PASSWORD ?? "" },
    authSource: mongoDatabase, serverSelectionTimeoutMS: 5_000,
  });
  await mongoWorker.connect();
  mongo = mongoWorker.db(mongoDatabase);
  archives = new ArchiveStore(mongo);
  store = new IngestionStore(pool);
});

beforeEach(async () => {
  const tables = (await administrator.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  await administrator.query(`TRUNCATE ${tables.map((row) => `sports.${row.tablename}`).join(",")} RESTART IDENTITY CASCADE`);
  const db = mongoAdmin.db(mongoDatabase);
  await db.collection("raw_archives").deleteMany({});
  await db.collection("import_metadata").deleteMany({});
});

after(async () => {
  await Promise.allSettled([pool?.end(), administrator?.end(), mongoWorker?.close(), mongoAdmin?.close()]);
});

function appearance(playerId = "8001", goals: number | null = 0): Appearance {
  return { player: { id: playerId, name: `Test player ${playerId}`, position: "FWD" }, clubId: clubs[0].id,
    participation: "played", minutes: 97, rating: 7.5, goals, assists: 0, shotsOnTarget: 2,
    keyPasses: null, tackles: 0, interceptions: 0, saves: 0, goalsConceded: 1 };
}

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return { id: "900001", leagueId: coverage.id, season: coverage.season, home: clubs[0], away: clubs[1],
    kickoffAt: "2026-08-01T15:00:00.000Z", status: "final", statisticsStatus: "partial",
    homeScore: 2, awayScore: 1, detailed: true, appearances: [appearance()], ...overrides };
}

function batch(fixtures: Fixture[] = [fixture()]): Batch {
  return { coverage, clubs: [...clubs], players: [], fixtures, standings: [], issues: [] };
}

function response(value: unknown, overrides: Partial<ProviderResponse> = {}): ProviderResponse {
  const text = JSON.stringify(value);
  return { action: "get_events", resourceKey: "test:153:events", params: { league_id: "153" }, text,
    retrievedAt: new Date(Date.UTC(2026, 10, 9, 0, 0, observation++)).toISOString(),
    contentSha256: createHash("sha256").update(text).digest("hex"), ...overrides };
}

async function importBatch(value: Batch): Promise<{ archive: ArchivedResponse; result: Awaited<ReturnType<IngestionStore["import"]>> }> {
  const archive = await archives.save(response(value));
  const result = await store.import(archive, value);
  await archives.mark(archive.id, "imported", value.issues, result);
  return { archive, result };
}

function sourceStatistics(clubId = clubs[0].id) {
  return {
    match_id: "900001", player_key: "8001", player_name: "Test player 8001", player_type: "Forwards",
    team_name: clubId === clubs[0].id ? "home" : "away", team_key: clubId,
    player_minutes_played: "97", player_rating: "7.5", player_goals: "1", player_assists: "0",
    player_shots_on_goal: "2", player_key_passes: "0", player_tackles: "0", player_interceptions: "0",
    player_saves: "0", player_goals_conceded: "1",
  };
}

async function importSourceStatistics(clubId = clubs[0].id) {
  await archives.save(response({ player_statistics: [sourceStatistics(clubId)] }, {
    action: "get_statistics", resourceKey: "test:153:statistics:900001", params: { league_id: "153", match_id: "900001" },
  }));
  const pipeline = new IngestionPipeline(pool, mongo, "offline-correction-test");
  assert.equal(await pipeline.reconcile(), 1);
}

async function importSummary(clubId: string) {
  await archives.save(response([{
    match_id: "900001", league_id: "153", league_year: "2026/27", stage_name: "Regular Season",
    match_hometeam_id: clubs[0].id, match_hometeam_name: clubs[0].name,
    match_awayteam_id: clubs[1].id, match_awayteam_name: clubs[1].name,
    match_date: "2026-08-01", match_time: "15:00", match_status: "Finished",
    match_hometeam_score: "2", match_awayteam_score: "1",
    lineup: { [clubId === clubs[0].id ? "home" : "away"]: {
      starting_lineups: [{ player_key: "8001", lineup_player: "Test player 8001" }],
    } },
  }], { params: { league_id: "153", timezone: "UTC" } }));
  const pipeline = new IngestionPipeline(pool, mongo, "offline-correction-test");
  assert.equal(await pipeline.reconcile(), 1);
}

function sourceRoster(position = "Forwards") {
  return clubs.map((club, index) => ({
    team_key: club.id, team_name: club.name,
    players: index === 0 ? [{ player_key: "8001", player_name: "Test player 8001", player_type: position }] : [],
  }));
}

async function importRoster(payload: unknown = sourceRoster()) {
  const archive = await archives.save(response(payload, {
    action: "get_teams", resourceKey: "test:153:teams", params: { league_id: "153" },
  }));
  const normalized = normalizeResponse(archive, coverage);
  const result = await store.import(archive, normalized);
  await archives.mark(archive.id, "imported", normalized.issues, result);
  return { archive, normalized };
}

async function counts() {
  return (await administrator.query(`SELECT
    (SELECT count(*)::integer FROM sports.fixtures) AS fixtures,
    (SELECT count(*)::integer FROM sports.appearances) AS appearances,
    (SELECT count(*)::integer FROM sports.normalized_revisions) AS revisions,
    (SELECT count(*)::integer FROM sports.audit_log) AS audit,
    (SELECT count(*)::integer FROM sports.outbox) AS outbox`)).rows[0];
}

test("raw bytes stay immutable, metadata stays separate, and orphan inserts recover", async () => {
  const text = " {\"label\": \"Test café\"}\n";
  const raw = response({}, { text, contentSha256: createHash("sha256").update(text).digest("hex") });
  const saved = await archives.save(raw);
  assert.equal(saved.text, text);
  assert.equal((await archives.get(saved.id))?.contentSha256, raw.contentSha256);
  const collection = mongo.collection<ProviderResponse & { _id: string }>("raw_archives");
  for (const operation of [
    () => collection.updateOne({ _id: saved.id }, { $set: { text: "changed" } }),
    () => collection.deleteOne({ _id: saved.id }),
  ]) await assert.rejects(operation, (error: unknown) => (error as { code?: number }).code === 13);
  await assert.rejects(() => archives.save({ ...raw, contentSha256: "0".repeat(64) }), /hash mismatch/);
  await assert.rejects(() => archives.save({ ...raw, params: { APIkey: "synthetic-test-secret" } }), /Secret parameters/);
  await mongoAdmin.db(mongoDatabase).collection("import_metadata").deleteOne({ _id: saved.id } as never);
  assert.deepEqual((await archives.pending()).map((entry) => entry.id), [saved.id]);
  assert.equal((await mongo.collection("import_metadata").findOne({ _id: saved.id } as never))?.state, "pending");
  await archives.mark(saved.id, "invalid", [{ code: "synthetic_invalid", resource: "test" }]);
  assert.equal((await archives.pending()).length, 0);
  assert.equal((await archives.get(saved.id))?.text, text);
});

test("a SQL constraint failure rolls back canonical records, revisions, audit, outbox and marker while retaining the archive", async () => {
  const value = batch([fixture({ homeScore: -1 })]);
  const archive = await archives.save(response(value));
  await assert.rejects(() => store.import(archive, value), (error: unknown) => (error as { code?: string }).code === "23514");
  assert.deepEqual(await counts(), { fixtures: 0, appearances: 0, revisions: 0, audit: 0, outbox: 0 });
  assert.equal((await administrator.query("SELECT count(*) FROM sports.source_revisions")).rows[0].count, "0");
  assert.equal((await administrator.query("SELECT count(*) FROM sports.ingestion_batches")).rows[0].count, "0");
  assert.deepEqual((await archives.pending()).map((entry) => entry.id), [archive.id]);
});

test("pipeline reconciliation imports orphan archives, recovers a lost marker and quarantines empty responses without HTTP", async () => {
  const payload = [{
    match_id: "900001", league_id: "153", league_year: "2026/27", stage_name: "Regular Season",
    match_hometeam_id: clubs[0].id, match_hometeam_name: clubs[0].name,
    match_awayteam_id: clubs[1].id, match_awayteam_name: clubs[1].name,
    match_date: "2026-08-01", match_time: "15:00", match_status: "Finished",
    match_hometeam_score: "2", match_awayteam_score: "1",
  }];
  const raw = response(payload, { params: { league_id: "153", timezone: "UTC", from: coverage.startsOn, to: coverage.endsOn } });
  const id = archiveId(raw);
  await mongoAdmin.db(mongoDatabase).collection<ProviderResponse & { _id: string }>("raw_archives").insertOne({ _id: id, ...raw });
  const pipeline = new IngestionPipeline(pool, mongo, "offline-test");
  assert.equal(await pipeline.reconcile(), 1);
  assert.equal((await store.fixture("900001"))?.homeScore, 2);
  let metadata = await mongo.collection<{ _id: string; state: string; result: { duplicate: boolean } }>("import_metadata").findOne({ _id: id });
  assert.equal(metadata?.state, "imported");
  const previous = await counts();
  await mongoAdmin.db(mongoDatabase).collection<{ _id: string }>("import_metadata").deleteOne({ _id: id });
  assert.equal(await pipeline.reconcile(), 1);
  assert.deepEqual(await counts(), previous);
  metadata = await mongo.collection<{ _id: string; state: string; result: { duplicate: boolean } }>("import_metadata").findOne({ _id: id });
  assert.equal(metadata?.result.duplicate, true);
  const empty = await archives.save(response([], { params: { league_id: "153", timezone: "UTC" } }));
  assert.equal(await pipeline.reconcile(), 1);
  assert.equal((await mongo.collection<{ _id: string; state: string }>("import_metadata").findOne({ _id: empty.id }))?.state, "invalid");
  assert.equal((await administrator.query("SELECT count(*) FROM sports.provider_requests")).rows[0].count, "0");
});

test("SQL commit markers recover a lost Mongo marker and exact replay causes no effective writes", async () => {
  const value = batch();
  const archive = await archives.save(response(value));
  const first = await store.import(archive, value);
  const previous = await counts();
  assert.equal(first.duplicate, false);
  assert.equal((await archives.pending()).length, 1);
  const replay = await store.import((await archives.pending())[0], value);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(await counts(), previous);
  await archives.mark(archive.id, "imported", [], replay);
  assert.equal((await archives.pending()).length, 0);
  const unchanged = await importBatch(value);
  assert.equal(unchanged.result.fixtures, 0);
  assert.equal(unchanged.result.appearances, 0);
  assert.deepEqual(await counts(), previous);
  const stored = await store.fixture("900001");
  assert.equal(stored?.appearances[0].goals, 0);
  assert.equal(stored?.appearances[0].keyPasses, null);
  assert.equal(stored?.appearances[0].minutes, 97);
  const membership = (await administrator.query("SELECT extract(epoch FROM valid_until-valid_from)::numeric AS span FROM sports.player_memberships")).rows[0];
  assert.equal(Number(membership.span), 0.000001);
});

test("new A to B to A observations append revisions; older unimported observations cannot revert newer data", async () => {
  const original = batch();
  const first = await importBatch(original);
  const stale = await archives.save(response(batch([fixture({ homeScore: 8 })])));
  await importBatch(batch([fixture({ homeScore: 3 })]));
  const reverted = await importBatch(original);
  assert.notEqual(first.archive.id, reverted.archive.id);
  assert.equal(first.archive.contentSha256, reverted.archive.contentSha256);
  assert.equal((await store.fixture("900001"))?.homeScore, 2);
  assert.equal((await administrator.query("SELECT count(*) FROM sports.outbox WHERE event_type='fixture.statistics'")).rows[0].count, "3",
    "each new corrected header, including a return to earlier values, requires fresh detail");
  const previous = await counts();
  const superseded = await store.import(stale, batch([fixture({ homeScore: 8 })]));
  assert.equal(superseded.fixtures, 0);
  assert.deepEqual(await counts(), previous);
  assert.equal((await store.fixture("900001"))?.homeScore, 2);
  const marker = (await administrator.query("SELECT issues_json FROM sports.ingestion_batches WHERE archive_id=$1", [stale.id])).rows[0];
  assert(marker.issues_json.some((issue: { code: string }) => issue.code === "superseded_archive"));
  const revisions = (await administrator.query("SELECT id,parent_id FROM sports.normalized_revisions WHERE entity_type='fixture' AND entity_key='900001' ORDER BY ordinal")).rows;
  assert.equal(revisions.length, 3);
  assert.equal(revisions[1].parent_id, revisions[0].id);
  assert.equal(revisions[2].parent_id, revisions[1].id);
});

test("summaries preserve enriched statistics; corrections invalidate removed players and unknown kickoff never confirms participation", async () => {
  await importBatch(batch([fixture({ appearances: [appearance("8001"), appearance("8002", 1)] })]));
  await importBatch(batch([fixture({ detailed: false, statisticsStatus: "missing", appearances: [] })]));
  assert.equal((await store.fixture("900001"))?.appearances[0].minutes, 97);
  await importBatch(batch([fixture({ homeScore: 3, appearances: [appearance("8001", 1)] })]));
  const corrected = await store.fixture("900001");
  const removed = corrected?.appearances.find((entry) => entry.player.id === "8002");
  assert.equal(removed?.participation, "unknown");
  assert.equal(removed?.minutes, null);
  assert.equal(removed?.goals, null);
  await importBatch(batch([fixture({ kickoffAt: null, appearances: [appearance()] })]));
  assert.equal((await store.fixture("900001"))?.appearances.find((entry) => entry.player.id === "8001")?.participation, "unknown");
  const enrichment = await administrator.query("SELECT payload FROM sports.outbox WHERE event_type='fixture.statistics'");
  assert(enrichment.rowCount! >= 2);
});

test("a summary adds unseen lineup players as uncertainty and downgrades previously complete statistics", async () => {
  await importBatch(batch([fixture({ statisticsStatus: "complete" })]));
  const unknown = { ...appearance("8002"), participation: "unknown" as const, minutes: null, rating: null, goals: null };
  await importBatch(batch([fixture({ detailed: false, statisticsStatus: "missing", appearances: [unknown] })]));
  const stored = await store.fixture("900001");
  assert.equal(stored?.statisticsStatus, "partial");
  assert.equal(stored?.appearances.find((entry) => entry.player.id === "8001")?.minutes, 97);
  assert.equal(stored?.appearances.find((entry) => entry.player.id === "8002")?.participation, "unknown");
  assert.equal((await administrator.query("SELECT count(*) FROM sports.outbox WHERE event_type='fixture.statistics'")).rows[0].count, "1");
});

test("fresh statistics correct a prior club attribution and repeated observations stay stable", async () => {
  await importBatch(batch([fixture({ appearances: [{ ...appearance(), clubId: clubs[1].id }] })]));
  await importSourceStatistics();
  const recovered = (await store.fixture("900001"))?.appearances[0];
  assert.equal(recovered?.clubId, clubs[0].id);
  assert.equal(recovered?.participation, "played");
  assert.equal(recovered?.minutes, 97);
  assert.equal(recovered?.goals, 1);
  const previous = await counts();
  await importSourceStatistics();
  assert.deepEqual(await counts(), previous);
});

test("statistics reintroduce a player whose earlier correction cleared membership", async () => {
  await importBatch(batch());
  await importBatch(batch([fixture({ appearances: [] })]));
  const removed = (await store.fixture("900001"))?.appearances[0];
  assert.equal(removed?.clubId, "");
  assert.equal(removed?.participation, "unknown");
  await importSourceStatistics();
  const recovered = (await store.fixture("900001"))?.appearances[0];
  assert.equal(recovered?.clubId, clubs[0].id);
  assert.equal(recovered?.participation, "played");
  assert.equal(recovered?.minutes, 97);
  assert.equal(recovered?.goals, 1);
});

for (const statisticsStatus of ["complete", "partial"] as const) {
  test(`a changed summary club clears ${statisticsStatus} detail, enqueues enrichment and recovers with fresh statistics`, async () => {
    await importBatch(batch([fixture({ statisticsStatus })]));
    const initialEnrichment = Number((await administrator.query("SELECT count(*) FROM sports.outbox WHERE event_type='fixture.statistics'")).rows[0].count);
    await importSummary(clubs[1].id);
    const changed = await store.fixture("900001");
    assert.equal(changed?.statisticsStatus, "partial");
    const uncertain = changed?.appearances[0];
    assert.equal(uncertain?.clubId, clubs[1].id);
    assert.equal(uncertain?.participation, "unknown");
    assert.equal(uncertain?.minutes, null);
    assert.equal(uncertain?.rating, null);
    assert.equal(uncertain?.goals, null);
    assert.equal(uncertain?.shotsOnTarget, null);
    const correctedRevision = (await administrator.query("SELECT normalized_revision_id FROM sports.appearances")).rows[0].normalized_revision_id;
    const enrichment = await administrator.query("SELECT deduplication_key FROM sports.outbox WHERE event_type='fixture.statistics'");
    assert.equal(enrichment.rowCount, initialEnrichment + 1);
    assert(enrichment.rows.some((row) => row.deduplication_key === `fixture.statistics:900001:${correctedRevision}`));
    const previous = await counts();
    await importSummary(clubs[1].id);
    assert.deepEqual(await counts(), previous);
    await importSourceStatistics(clubs[1].id);
    const recovered = (await store.fixture("900001"))?.appearances[0];
    assert.equal(recovered?.clubId, clubs[1].id);
    assert.equal(recovered?.participation, "played");
    assert.equal(recovered?.minutes, 97);
    assert.equal(recovered?.goals, 1);
  });
}

test("a same-club summary preserves complete detail without extra enrichment", async () => {
  await importBatch(batch([fixture({ statisticsStatus: "complete" })]));
  const previous = await counts();
  await importSummary(clubs[0].id);
  const preserved = await store.fixture("900001");
  assert.equal(preserved?.statisticsStatus, "complete");
  assert.equal(preserved?.appearances[0].participation, "played");
  assert.equal(preserved?.appearances[0].minutes, 97);
  assert.equal(preserved?.appearances[0].rating, 7.5);
  assert.deepEqual(await counts(), previous);
});

test("roster observations are append only, grant reader access and retain removals in newer complete snapshots", async () => {
  const first = await importRoster();
  const second = await importRoster(sourceRoster().map((team) => ({ ...team, players: [] })));
  const snapshots = (await administrator.query(`SELECT s.id,s.complete,s.observed_at,sr.archive_ref FROM sports.roster_snapshots s
    JOIN sports.source_revisions sr ON sr.id=s.source_revision_id ORDER BY s.observed_at`)).rows;
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.map((row) => row.complete), [true, true]);
  assert.deepEqual(snapshots.map((row) => row.archive_ref), [first.archive.id, second.archive.id]);
  assert.equal(snapshots[0].observed_at.toISOString(), first.archive.retrievedAt);
  assert.equal((await administrator.query("SELECT count(*) FROM sports.roster_entries WHERE snapshot_id=$1", [snapshots[0].id])).rows[0].count, "1");
  assert.equal((await administrator.query("SELECT count(*) FROM sports.roster_entries WHERE snapshot_id=$1", [snapshots[1].id])).rows[0].count, "0");
  assert.equal((await administrator.query("SELECT count(*) FROM sports.player_memberships")).rows[0].count, "0",
    "a roster observation does not invent a transfer date or fixture membership interval");
  for (const table of ["roster_snapshots", "roster_entries"]) {
    for (const statement of [`DELETE FROM sports.${table}`, `UPDATE sports.${table} SET season_id=season_id`]) {
      await assert.rejects(() => pool.query(statement), (error: unknown) => (error as { code?: string }).code === "42501");
    }
    const permissions = (await administrator.query(`SELECT
      has_table_privilege('lsp_reader',$1,'SELECT') AS reader_select,
      has_table_privilege('lsp_reader',$1,'INSERT') AS reader_insert,
      has_table_privilege('lsp_writer',$1,'INSERT') AS writer_insert,
      has_table_privilege('lsp_writer',$1,'UPDATE') AS writer_update,
      has_table_privilege('lsp_writer',$1,'DELETE') AS writer_delete`, [`sports.${table}`])).rows[0];
    assert.deepEqual(permissions, { reader_select: true, reader_insert: false, writer_insert: true, writer_update: false, writer_delete: false });
  }
  assert.equal((await administrator.query("SELECT count(*) FROM sports.outbox WHERE event_type='roster.changed'")).rows[0].count, "2");
});

test("unchanged roster observations retain fresh provenance without repeated effective refresh events", async () => {
  const first = await importRoster();
  const second = await importRoster();
  assert.notEqual(first.archive.id, second.archive.id);
  const snapshots = (await administrator.query("SELECT normalized_revision_id FROM sports.roster_snapshots ORDER BY observed_at")).rows;
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].normalized_revision_id, snapshots[1].normalized_revision_id);
  assert.equal((await administrator.query("SELECT count(*) FROM sports.outbox WHERE event_type='roster.changed'")).rows[0].count, "1");
  assert.equal((await archives.latestRosters())[0].id, second.archive.id);
});

test("ambiguous and incomplete roster observations preserve membership evidence and do not claim completeness", async () => {
  await importRoster();
  const ambiguous = sourceRoster();
  ambiguous[1].players = [...ambiguous[0].players];
  const imported = await importRoster(ambiguous);
  assert.equal(imported.normalized.players.length, 1);
  const snapshot = (await administrator.query(`SELECT s.id,s.complete FROM sports.roster_snapshots s
    JOIN sports.source_revisions sr ON sr.id=s.source_revision_id WHERE sr.archive_ref=$1`, [imported.archive.id])).rows[0];
  assert.equal(snapshot.complete, false);
  const memberships = (await administrator.query(`SELECT p.provider_id AS player_id,c.provider_id AS club_id FROM sports.roster_entries e
    JOIN sports.players p ON p.id=e.player_id JOIN sports.clubs c ON c.id=e.club_id
    WHERE e.snapshot_id=$1 ORDER BY c.provider_id`, [snapshot.id])).rows;
  assert.deepEqual(memberships, [clubs[0], clubs[1]].sort((a, b) => a.id.localeCompare(b.id)).map((club) => ({ player_id: "8001", club_id: club.id })));
  const incomplete = sourceRoster().map((team, index) => index === 1 ? { ...team, players: undefined } : team);
  const latest = await importRoster(incomplete);
  assert.equal(latest.normalized.roster?.complete, false);
  assert.equal((await administrator.query("SELECT complete FROM sports.roster_snapshots ORDER BY observed_at DESC LIMIT 1")).rows[0].complete, false);
  assert.equal((await administrator.query("SELECT count(*) FROM sports.roster_snapshots WHERE complete")).rows[0].count, "1");
});

test("position corrections emit player refresh events even when roster membership is unchanged", async () => {
  await importRoster();
  await importRoster(sourceRoster("Midfielders"));
  assert.equal((await administrator.query("SELECT position FROM sports.players WHERE provider_id='8001'")).rows[0].position, "MID");
  const changes = (await administrator.query("SELECT payload FROM sports.outbox WHERE event_type='canonical.changed' AND aggregate_type='player'")).rows;
  assert.equal(changes.length, 2);
  assert(changes.every((row) => row.payload.playerId === "8001" && typeof row.payload.revisionId === "string"));
  assert.equal((await administrator.query("SELECT count(*) FROM sports.outbox WHERE event_type='roster.changed'")).rows[0].count, "1");
});

test("offline reconciliation projects committed roster archives after upgrade and ignores uncommitted or invalid observations", async () => {
  const archive = await archives.save(response(sourceRoster(), {
    action: "get_teams", resourceKey: "test:153:teams", params: { league_id: "153" },
  }));
  const normalized = normalizeResponse(archive, coverage);
  const olderImport = { ...normalized };
  delete olderImport.roster;
  const result = await store.import(archive, olderImport);
  await archives.mark(archive.id, "imported", normalized.issues, result);
  assert.equal((await administrator.query("SELECT count(*) FROM sports.roster_snapshots")).rows[0].count, "0");
  const uncommitted = await archives.save(response(sourceRoster().map((team) => ({ ...team, players: [] })), {
    action: "get_teams", resourceKey: "test:153:teams", params: { league_id: "153" },
  }));
  await store.replayRoster(uncommitted, normalizeResponse(uncommitted, coverage));
  assert.equal((await administrator.query("SELECT count(*) FROM sports.roster_snapshots")).rows[0].count, "0");
  assert.deepEqual((await archives.latestRosters()).map((observation) => observation.id), [archive.id]);
  await archives.mark(uncommitted.id, "invalid", [{ code: "synthetic_uncommitted", resource: "get_teams" }]);
  const invalid = await archives.save(response({}, {
    action: "get_teams", resourceKey: "test:153:teams", params: { league_id: "153" },
  }));
  await archives.mark(invalid.id, "invalid", [{ code: "invalid_payload", resource: "get_teams" }]);
  const pipeline = new IngestionPipeline(pool, mongo, "offline-upgrade-test");
  pipeline.provider.request = async () => assert.fail("offline reconciliation must not call the provider");
  assert.equal(await pipeline.reconcile(), 0);
  const snapshot = (await administrator.query(`SELECT s.*,sr.archive_ref FROM sports.roster_snapshots s
    JOIN sports.source_revisions sr ON sr.id=s.source_revision_id`)).rows[0];
  assert.equal(snapshot.archive_ref, archive.id);
  assert.equal(snapshot.observed_at.toISOString(), archive.retrievedAt);
  assert.equal(snapshot.complete, true);
  assert.equal((await administrator.query("SELECT count(*) FROM sports.roster_entries")).rows[0].count, "1");
  const previous = await counts();
  assert.equal(await pipeline.reconcile(), 0);
  assert.deepEqual(await counts(), previous);
  assert.equal((await administrator.query("SELECT count(*) FROM sports.roster_snapshots")).rows[0].count, "1");
  assert.equal((await administrator.query("SELECT count(*) FROM sports.provider_requests")).rows[0].count, "0");
});

test("offline reconciliation retains every conflicting latest-time roster observation", async () => {
  const latestAt = "2026-11-09T10:00:00.000Z";
  const transferred = sourceRoster();
  transferred[1].players = transferred[0].players;
  transferred[0].players = [];
  const imported: ArchivedResponse[] = [];
  for (const [payload, retrievedAt] of [
    [sourceRoster(), "2026-11-09T09:00:00.000Z"],
    [sourceRoster(), latestAt],
    [transferred, latestAt],
  ] as const) {
    const archive = await archives.save(response(payload, {
      action: "get_teams", resourceKey: "test:153:teams", params: { league_id: "153" }, retrievedAt,
    }));
    const normalized = normalizeResponse(archive, coverage);
    const olderImport = { ...normalized };
    delete olderImport.roster;
    const result = await store.import(archive, olderImport);
    await archives.mark(archive.id, "imported", normalized.issues, result);
    imported.push(archive);
  }
  const latestIds = imported.slice(1).map((archive) => archive.id).sort();
  assert.deepEqual((await archives.latestRosters()).map((archive) => archive.id), latestIds);
  const pipeline = new IngestionPipeline(pool, mongo, "offline-tied-roster-test");
  pipeline.provider.request = async () => assert.fail("offline reconciliation must not call the provider");
  assert.equal(await pipeline.reconcile(), 0);
  const snapshots = (await administrator.query(`SELECT s.observed_at,s.complete,sr.archive_ref,c.provider_id AS club_id
    FROM sports.roster_snapshots s JOIN sports.source_revisions sr ON sr.id=s.source_revision_id
    JOIN sports.roster_entries e ON e.snapshot_id=s.id JOIN sports.clubs c ON c.id=e.club_id
    ORDER BY sr.archive_ref`)).rows;
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.archive_ref), latestIds);
  assert(snapshots.every((snapshot) => snapshot.observed_at.toISOString() === latestAt && snapshot.complete));
  assert.deepEqual(snapshots.map((snapshot) => snapshot.club_id).sort(), [clubs[0].id, clubs[1].id].sort());
  const previous = await counts();
  assert.equal(await pipeline.reconcile(), 0);
  assert.deepEqual(await counts(), previous);
  assert.equal((await administrator.query("SELECT count(*) FROM sports.roster_snapshots")).rows[0].count, "2");
  assert.equal((await administrator.query("SELECT count(*) FROM sports.provider_requests")).rows[0].count, "0");
});

test("latest roster archive lookup validates authoritative hashes", async () => {
  const imported = await importRoster();
  await mongoAdmin.db(mongoDatabase).collection("raw_archives").updateOne({ _id: imported.archive.id } as never, { $set: { text: "changed bytes" } });
  await assert.rejects(() => archives.latestRosters(), /hash mismatch/);
});

test("the shared rolling request cap is atomic across concurrent callers and request records are append only", async () => {
  const now = new Date("2026-11-09T10:00:00.000Z");
  const results = await Promise.allSettled(Array.from({ length: 125 }, (_, index) => store.reserveRequest("get_events", `test:${index}`, now)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 120);
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(rejected.length, 5);
  assert(rejected.every((result) => result.reason instanceof RateLimitError && result.reason.retryAt.getTime() === now.getTime() + 3_600_000));
  assert.equal((await administrator.query("SELECT count(*) FROM sports.provider_requests")).rows[0].count, "120");
  await store.reserveRequest("get_teams", "test:after-window", new Date(now.getTime() + 3_600_000));
  await assert.rejects(() => pool.query("DELETE FROM sports.provider_requests"), (error: unknown) => (error as { code?: string }).code === "42501");
  await assert.rejects(() => pool.query("UPDATE sports.provider_requests SET action='get_teams'"), (error: unknown) => (error as { code?: string }).code === "42501");
});

function fullSchedule(): Fixture[] {
  return clubs.flatMap((home, h) => clubs.flatMap((away, a) => h === a ? [] : [fixture({
    id: String(910000 + h * 24 + a), home, away, kickoffAt: "2027-01-01T15:00:00.000Z",
    status: "scheduled", detailed: false, statisticsStatus: "unknown", homeScore: null, awayScore: null, appearances: [],
  })]));
}

test("standings keep archived fixture provenance, deductions, historical cutoffs and append only corrections without future snapshots", async () => {
  const schedule = fullSchedule();
  schedule[0] = { ...schedule[0], kickoffAt: "2026-08-01T15:00:00.000Z", status: "final", homeScore: 2, awayScore: 1 };
  const imported = await importBatch(batch(schedule));
  const rebuilt = await store.rebuild(coverage, "2026-08-02");
  assert.equal(rebuilt.complete, true);
  assert.equal(rebuilt.snapshots, 1);
  const row = (await administrator.query(`SELECT r.*,s.cutoff_at,n.source_revision_id,sr.archive_ref FROM sports.standings_rows r
    JOIN sports.standings_snapshots s ON s.id=r.snapshot_id JOIN sports.clubs c ON c.id=r.club_id
    JOIN sports.normalized_revisions n ON n.id=s.normalized_revision_id JOIN sports.source_revisions sr ON sr.id=n.source_revision_id
    WHERE c.provider_id='3072'`)).rows[0];
  assert.equal(row.points, -1);
  assert.equal(row.played, 1);
  assert.equal(row.goals_for, 2);
  assert.equal(row.cutoff_at.toISOString(), "2026-08-01T23:00:00.000Z");
  assert.equal(row.archive_ref, imported.archive.id);
  assert.equal((await administrator.query("SELECT points,provenance_url FROM sports.points_adjustments")).rows[0].points, -4);
  const previous = await counts();
  assert.equal((await store.rebuild(coverage, "2026-08-02")).snapshots, 0);
  assert.deepEqual(await counts(), previous);
  await importBatch(batch([{ ...schedule[0], homeScore: 3 }]));
  assert.equal((await store.rebuild(coverage, "2026-08-02")).snapshots, 1);
  assert.equal((await administrator.query("SELECT count(*) FROM sports.standings_snapshots WHERE cutoff_local_date='2026-08-02'")).rows[0].count, "2");
  await store.rebuild(coverage);
  const today = localDate(new Date().toISOString(), coverage.timezone);
  assert.equal((await administrator.query("SELECT count(*) FROM sports.standings_snapshots WHERE cutoff_local_date>$1", [today])).rows[0].count, "0");
  const provenance = (await administrator.query("SELECT detail FROM sports.audit_log WHERE action='reconstruct' ORDER BY occurred_at LIMIT 1")).rows[0].detail;
  assert(provenance.fixtureRevisions.some((entry: { sourceRevisionId: string }) => entry.sourceRevisionId === row.source_revision_id));
});

test("provider standings reconcile all totals as provenance without overwriting computed standings", async () => {
  const value = batch();
  const imported = await importBatch(value);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const reference = reconstructStandings(coverage, [...clubs], value.fixtures, tomorrow).rows;
  const standings = { ...batch([]), standings: reference.map((row) => ({ ...row, points: row.clubId === clubs[0].id ? row.points + 1 : row.points })) };
  const archive = await archives.save(response(standings, { action: "get_standings", resourceKey: "test:153:standings" }));
  const result = await store.import(archive, standings);
  assert(result.issues >= 2, "the missing full schedule and mismatched points remain explicit");
  const audit = (await administrator.query("SELECT detail FROM sports.audit_log WHERE action='reconcile'")).rows[0].detail;
  assert.equal(audit.complete, false);
  assert(audit.mismatches.some((issue: { code: string; field: string }) => issue.code === "standings_reference_mismatch" && issue.field === "points"));
  assert.equal((await administrator.query("SELECT count(*) FROM sports.standings_rows")).rows[0].count, "0");
  assert.equal((await store.fixture("900001"))?.homeScore, 2);
  assert(await archives.get(imported.archive.id));
});

async function event(kind: string, key: string, payload: Record<string, unknown> = { leagueId: "153", fixtureId: "900001" }): Promise<string> {
  return (await administrator.query(`INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
    VALUES ($1,'fixture',$2,$3,$4) RETURNING id`, [kind, randomUUID(), key, JSON.stringify(payload)])).rows[0].id;
}

test("concurrent dispatch is idempotent and acknowledges only ingestion events; concurrent workers claim a job once", async () => {
  const first = await event("fixture.statistics", "test:statistics");
  const future = await event("canonical.changed", "test:future");
  const queue = new JobQueue(pool, "test-one");
  assert.equal((await Promise.all([queue.dispatch(), queue.dispatch()])).reduce((sum, count) => sum + count, 0), 1);
  assert.equal(await queue.dispatch(), 0);
  assert.equal((await administrator.query("SELECT count(*) FROM sports.jobs")).rows[0].count, "1");
  assert((await administrator.query("SELECT published_at FROM sports.outbox WHERE id=$1", [first])).rows[0].published_at);
  assert.equal((await administrator.query("SELECT published_at FROM sports.outbox WHERE id=$1", [future])).rows[0].published_at, null);
  let calls = 0;
  const handler = async () => { calls++; await pause(40); };
  const results = await Promise.all([queue.runOnce(handler), new JobQueue(pool, "test-two").runOnce(handler)]);
  assert.equal(calls, 1);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await administrator.query("SELECT status,attempts FROM sports.jobs")).rows[0].status, "succeeded");
});

test("expired leases retry unfinished work, terminate exhausted work, and allow explicit operator recovery", async () => {
  await event("fixture.statistics", "test:lease");
  const queue = new JobQueue(pool);
  await queue.dispatch();
  await administrator.query("UPDATE sports.jobs SET status='running',attempts=1,locked_by='lost-worker',locked_until=clock_timestamp()-interval '1 second'");
  assert.equal(await queue.runOnce(async () => {}), true);
  let row = (await administrator.query("SELECT * FROM sports.jobs")).rows[0];
  assert.equal(row.attempts, 2);
  await administrator.query("UPDATE sports.jobs SET status='running',completed_at=NULL,attempts=max_attempts,locked_by='lost-worker',locked_until=clock_timestamp()-interval '1 second'");
  assert.equal(await queue.runOnce(async () => { assert.fail("exhausted work cannot execute"); }), false);
  row = (await administrator.query("SELECT * FROM sports.jobs")).rows[0];
  assert.equal(row.status, "failed");
  assert.equal(row.last_error, "lease_expired");
  assert.equal(await queue.retryFailed(row.id), true);
  assert.equal(await queue.runOnce(async () => {}), true);
});

test("job retries distinguish transport, permanent, and shared-budget failures without storing upstream messages", async () => {
  await event("fixture.statistics", "test:retry");
  const queue = new JobQueue(pool);
  await queue.dispatch();
  await queue.runOnce(async () => { throw new ProviderError("transport_failed", true); });
  let row = (await administrator.query("SELECT * FROM sports.jobs")).rows[0];
  assert.equal(row.status, "ready");
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, "transport_failed");
  assert(row.run_after.getTime() > Date.now());
  await administrator.query("UPDATE sports.jobs SET run_after=clock_timestamp()");
  await queue.runOnce(async () => { throw new ProviderError("http_rejected", false); });
  row = (await administrator.query("SELECT * FROM sports.jobs")).rows[0];
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 2);
  await queue.retryFailed(row.id);
  await queue.runOnce(async () => { throw new RateLimitError(new Date(Date.now() + 60_000)); });
  row = (await administrator.query("SELECT * FROM sports.jobs")).rows[0];
  assert.equal(row.status, "ready");
  assert.equal(row.attempts, 0);
  assert.equal(row.last_error, "request_budget_exhausted");
  await administrator.query("UPDATE sports.jobs SET run_after=clock_timestamp()");
  await queue.runOnce(async () => { throw new Error("synthetic-sensitive-upstream-detail"); });
  row = (await administrator.query("SELECT * FROM sports.jobs")).rows[0];
  assert.equal(row.last_error, "processing_failed");
  assert(!JSON.stringify(row).includes("synthetic-sensitive-upstream-detail"));
});

test("malformed jobs fail visibly and recurring statistics scheduling avoids initial pending work", async () => {
  await event("fixture.statistics", "test:invalid", { leagueId: "999", fixtureId: "900001" });
  const queue = new JobQueue(pool);
  await queue.dispatch();
  await queue.runOnce(async () => { assert.fail("invalid payload cannot reach the handler"); });
  assert.equal((await administrator.query("SELECT last_error FROM sports.jobs")).rows[0].last_error, "invalid_job");
  await importBatch(batch());
  assert.equal(await queue.scheduleStatistics(), 0);
  assert.equal(await queue.scheduleStatistics(), 0);
});

test("coverage cannot be extended through a direct persistence call", async () => {
  const value = { ...batch(), coverage: { ...coverage, expectedClubs: 2 } };
  const archive = await archives.save(response(value));
  await assert.rejects(() => store.import(archive, value), /approved allowlist/);
  await assert.rejects(() => store.rebuild({ ...coverage, season: "2025/26" }), /approved allowlist/);
  assert.equal(archive.id, archiveId(archive));
});

test("a permanently rejected observation is quarantined so newer corrections can recover", async () => {
  const schedule = fullSchedule();
  await importBatch(batch(schedule));
  assert.equal((await store.rebuild(coverage, "2026-08-02")).complete, true);
  const teams = clubs.map((club) => ({ team_key: club.id, team_name: club.name, players: [] }));
  const invalid = await archives.save(response([...teams, { team_key: "70001", team_name: "Unexpected extra club", players: [] }], {
    action: "get_teams", resourceKey: "test:153:teams", params: { league_id: "153" },
  }));
  const corrected = await archives.save(response(teams, { action: "get_teams", resourceKey: "test:153:teams", params: { league_id: "153" } }));
  const pipeline = new IngestionPipeline(pool, mongo, "offline-reconciliation-test");
  assert.equal(await pipeline.reconcile(), 2);
  const rejected = await mongo.collection("import_metadata").findOne({ _id: invalid.id } as never);
  assert.equal(rejected?.state, "invalid");
  assert.ok(rejected?.issues.some((issue: { code: string }) => issue.code === "relational_validation_failed"));
  assert.equal((await mongo.collection("import_metadata").findOne({ _id: corrected.id } as never))?.state, "imported");
  assert.equal((await administrator.query("SELECT count(*) FROM sports.clubs")).rows[0].count, "24");
  assert.equal((await archives.pending()).length, 0);
});
