import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MongoClient, type Db } from "mongodb";
import pg from "pg";
import { ArchiveStore } from "../src/server/ingestion/archive";
import { CURRENT_SOURCE, LEGACY_SOURCE, sourceEntityKey } from "../src/server/ingestion/sources";
import { SorarePipeline, SORARE_FORMAT, SORARE_QUERIES } from "../src/server/ingestion/sorare";
import { IngestionStore, RateLimitError } from "../src/server/ingestion/store";
import type { Appearance, ArchivedResponse, Batch, Fixture, ProviderResponse } from "../src/server/ingestion/types";

function uuid(number: number): string { return `00000000-0000-0000-0000-${String(number).padStart(12, "0")}`; }

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
const coverage = CURRENT_SOURCE.coverage[0];
const clubs = Array.from({ length: 20 }, (_, index) => ({ id: `Club:${uuid(index + 1)}`, slug: `test-club-${index + 1}`, name: `Test club ${index + 1}` }));
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
  store = new IngestionStore(pool, CURRENT_SOURCE);
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

function appearance(goals = 1): Appearance {
  return { player: { id: `Player:${uuid(1)}`, slug: "test-player", name: "Test player", position: "FWD" }, clubId: clubs[0].id,
    participation: "played", minutes: 90, rating: null, goals, assists: 0, shotsOnTarget: 2, keyPasses: null,
    tackles: null, interceptions: 0, saves: null, goalsConceded: 0 };
}
function fixture(goals = 1): Fixture {
  return { id: `Game:${uuid(1)}`, leagueId: coverage.id, season: coverage.season, home: clubs[0], away: clubs[1],
    kickoffAt: "2026-11-01T15:00:00.000Z", status: "final", statisticsStatus: "partial", homeScore: 1, awayScore: 0,
    detailed: true, appearances: [appearance(goals)] };
}
function batch(goals = 1): Batch {
  return { coverage, clubs: [...clubs], players: [], fixtures: [fixture(goals)], standings: [], issues: [] };
}
function response(value: unknown, overrides: Partial<ProviderResponse> = {}): ProviderResponse {
  const text = JSON.stringify(value);
  return { action: "get_statistics", resourceKey: "sorare:test:statistics", params: { provider: "sorare", format: SORARE_FORMAT, league_id: coverage.id, match_id: fixture().id },
    text, retrievedAt: new Date(Date.UTC(2026, 10, 9, 0, 0, observation++)).toISOString(), contentSha256: createHash("sha256").update(text).digest("hex"), ...overrides };
}
function scheduleHeaders() {
  let index = 0;
  return clubs.flatMap((home) => clubs.filter((away) => home.id !== away.id).map((away) => ({
    id: `Game:${uuid(++index)}`, date: "2026-11-01T15:00:00Z", competition: { slug: coverage.id }, homeTeam: home, awayTeam: away,
    statusTyped: "played", homeGoals: 1, awayGoals: 0, lowCoverage: true,
  })));
}
function scheduleResponse(headers = scheduleHeaders(), retrievedAt = "2026-11-10T15:00:00Z"): ProviderResponse {
  const page = (kind: "past" | "future", field: string, nodes: unknown[], after: string | null, next: string | null) => ({
    query: SORARE_QUERIES[kind], variables: { slug: coverage.id, after }, retrievedAt,
    text: JSON.stringify({ data: { football: { competition: { slug: coverage.id,
      [field]: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } } } } }),
  });
  const captures = [];
  for (let offset = 0; offset < headers.length; offset += 50) {
    captures.push(page("past", "pastGames", headers.slice(offset, offset + 50), offset ? `past-${offset}` : null,
      offset + 50 < headers.length ? `past-${offset + 50}` : null));
  }
  if (!headers.length) captures.push(page("past", "pastGames", [], null, null));
  captures.push(page("future", "futureGames", [], null, null));
  return response({ format: SORARE_FORMAT, complete: true, captures }, { action: "get_events", resourceKey: "sorare:recovery", retrievedAt,
    params: { provider: "sorare", format: SORARE_FORMAT, league_id: coverage.id } });
}
async function importBatch(value: Batch = batch(), overrides: Partial<ProviderResponse> = {}): Promise<ArchivedResponse> {
  const archive = await archives.save(response(value, overrides));
  const result = await store.import(archive, value);
  await archives.mark(archive.id, "imported", value.issues, result);
  return archive;
}

test("native Sorare IDs and slugs stay separate; revisions, outbox and idempotence stay source-specific", async () => {
  const current = batch();
  const archive = await importBatch(current);
  assert.equal((await store.import(archive, current)).duplicate, true);
  const existing = await store.fixture(fixture().id);
  assert.equal(existing?.id, fixture().id); assert.equal(existing?.appearances[0].player.id, appearance().player.id);
  assert.equal(existing?.home.slug, clubs[0].slug); assert.equal(existing?.appearances[0].player.slug, "test-player");
  const player = (await administrator.query("SELECT provider_id,provider_slug FROM sports.players WHERE provider='sorare'")).rows[0];
  assert.equal(player.provider_id, appearance().player.id); assert.equal(player.provider_slug, "test-player");
  assert.equal((await administrator.query("SELECT count(*)::integer AS count FROM sports.ingestion_batches")).rows[0].count, 1);
  assert.equal((await administrator.query("SELECT count(*)::integer AS count FROM sports.source_revisions WHERE provider='sorare'")).rows[0].count, 1);
  const revisions = (await administrator.query("SELECT entity_key FROM sports.normalized_revisions")).rows;
  assert(revisions.every((item) => item.entity_key.startsWith("sorare:")));
  assert(revisions.some((item) => item.entity_key === sourceEntityKey(CURRENT_SOURCE, "appearance", fixture().id, appearance().player.id)));
  assert((await administrator.query("SELECT payload FROM sports.outbox")).rows.every((item) => item.payload.provider === "sorare"));
  const legacy = new IngestionStore(pool);
  await assert.rejects(() => legacy.import(archive, current), /Unsupported competition|source mismatch/);
});

test("legacy and current canonical records and revision chains cannot share native identifiers", async () => {
  const value = batch();
  const legacyCoverage = LEGACY_SOURCE.coverage[0];
  const old: Batch = { ...value, coverage: legacyCoverage,
    fixtures: value.fixtures.map((item) => ({ ...item, leagueId: legacyCoverage.id, season: legacyCoverage.season })) };
  const legacy = new IngestionStore(pool);
  const legacyArchive = await archives.save(response(old, { resourceKey: "legacy:test", params: { league_id: legacyCoverage.id } }));
  await legacy.import(legacyArchive, old);
  const legacyKeys = (await administrator.query("SELECT entity_type,entity_key,content_sha256 FROM sports.normalized_revisions ORDER BY ordinal")).rows;
  await importBatch(value);
  const players = (await administrator.query("SELECT provider,provider_id FROM sports.players ORDER BY provider")).rows;
  assert.deepEqual(players.map((item) => item.provider), ["apifootball", "sorare"]);
  assert(players.every((item) => item.provider_id === appearance().player.id));
  const retained = (await administrator.query(`SELECT n.entity_type,n.entity_key,n.content_sha256 FROM sports.normalized_revisions n
    JOIN sports.source_revisions s ON s.id=n.source_revision_id WHERE s.provider='apifootball' ORDER BY n.ordinal`)).rows;
  assert.deepEqual(retained, legacyKeys);
  assert((await administrator.query(`SELECT o.payload FROM sports.outbox o WHERE NOT (o.payload ? 'provider')`)).rowCount! > 0);
  const invalid = { ...legacyArchive, params: { ...legacyArchive.params, provider: "sorare" } };
  await assert.rejects(() => legacy.import(invalid, old), /identity mismatch|source mismatch/);
});

test("opaque-ID manual correction protects its whole fixture against older current observations", async () => {
  await importBatch();
  const entityKey = sourceEntityKey(CURRENT_SOURCE, "appearance", fixture().id, appearance().player.id);
  const source = (await administrator.query(`INSERT INTO sports.source_revisions(provider,action,resource_key,archive_ref,content_sha256,retrieved_at)
    VALUES ('manual','appearance.correct',$1,'manual:sorare-test',$2,'2026-11-10T00:00:00Z') RETURNING id`, [entityKey, "f".repeat(64)])).rows[0].id;
  const parent = (await administrator.query("SELECT id FROM sports.normalized_revisions WHERE entity_type='appearance' AND entity_key=$1 ORDER BY ordinal DESC LIMIT 1", [entityKey])).rows[0].id;
  await administrator.query(`INSERT INTO sports.normalized_revisions(source_revision_id,entity_type,entity_key,content_sha256,parent_id)
    VALUES ($1,'appearance',$2,$3,$4)`, [source, entityKey, "e".repeat(64), parent]);
  const incoming = await importBatch(batch(3));
  assert.equal((await store.fixture(fixture().id))?.appearances[0].goals, 1);
  const marker = (await administrator.query("SELECT issues_json FROM sports.ingestion_batches WHERE archive_id=$1", [incoming.id])).rows[0];
  assert(marker.issues_json.some((issue: { code: string }) => issue.code === "superseded_by_manual_correction"));
});

test("Sorare request reservations share a sixty-per-minute limit and one-second pacing", async () => {
  const start = Date.parse("2026-11-10T16:00:00Z");
  await store.reserveRequest("get_events", "sorare:budget:0", new Date(start));
  await assert.rejects(() => store.reserveRequest("get_events", "sorare:budget:early", new Date(start + 999)),
    (error) => error instanceof RateLimitError && error.retryAt.getTime() === start + 1000);
  for (let index = 1; index < 60; index++) await store.reserveRequest("get_events", `sorare:budget:${index}`, new Date(start + index * 1000));
  await assert.rejects(() => store.reserveRequest("get_events", "sorare:budget:full", new Date(start + 59_999)),
    (error) => error instanceof RateLimitError && error.retryAt.getTime() === start + 60_000);
  assert.equal((await administrator.query("SELECT count(*)::integer AS count FROM sports.provider_requests")).rows[0].count, 60);
  await store.reserveRequest("get_events", "sorare:budget:next", new Date(start + 60_000));
  await assert.rejects(() => store.reserveRequest("get_events", "legacy:unscoped", new Date(start + 61_000)), /namespace/);
});

test("current recovery filters before the limit and leaves retired pending archives and metadata untouched", async () => {
  const oldCoverage = LEGACY_SOURCE.coverage[0];
  const oldBatch: Batch = { coverage: oldCoverage, clubs: [{ id: "100", name: "Former club" }], players: [], fixtures: [], standings: [], issues: [] };
  const oldStore = new IngestionStore(pool);
  const oldCommitted = await archives.save(response(oldBatch, { action: "get_teams", resourceKey: "legacy:committed", params: { league_id: oldCoverage.id } }));
  const oldResult = await oldStore.import(oldCommitted, oldBatch);
  await archives.mark(oldCommitted.id, "imported", [], oldResult);
  await administrator.query("UPDATE sports.competitions SET enabled=false WHERE provider='apifootball'");
  await administrator.query("UPDATE sports.competition_seasons SET enabled=false");
  const oldPending = await archives.save(response([{ old: true }], { action: "get_teams", resourceKey: "legacy:pending", params: { league_id: oldCoverage.id } }));
  const oldMetadata = await mongo.collection("import_metadata").findOne({ _id: oldPending.id } as never);
  const current = await archives.save(scheduleResponse());
  assert.deepEqual((await archives.pending(1, "sorare")).map((item) => item.id), [current.id]);
  const pipeline = new SorarePipeline(pool, mongo, "offline-synthetic-secret");
  assert.equal(await pipeline.reconcile(), 1);
  assert.equal((await archives.get(oldPending.id))?.text, oldPending.text);
  assert.deepEqual(await mongo.collection("import_metadata").findOne({ _id: oldPending.id } as never), oldMetadata);
  assert.deepEqual((await archives.pending(100, "apifootball")).map((item) => item.id), [oldPending.id]);
  assert.equal((await administrator.query("SELECT enabled FROM sports.competitions WHERE provider='apifootball'")).rows[0].enabled, false);
  assert.equal((await administrator.query("SELECT count(*)::integer AS count FROM sports.source_revisions WHERE provider='apifootball'")).rows[0].count, 1);
  assert.equal((await store.fixture(fixture().id))?.id, fixture().id);
});

test("fresh current schedule captures refresh REVIEWING statistics without changing fixture headers", async () => {
  const value = batch();
  value.fixtures[0].detailed = false;
  value.fixtures[0].appearances = [];
  await importBatch(value, { action: "get_events", resourceKey: "sorare:test:events" });
  value.issues.push({ code: "synthetic_new_observation", resource: coverage.id });
  await importBatch(value, { action: "get_events", resourceKey: "sorare:test:events" });
  const jobs = (await administrator.query("SELECT payload FROM sports.outbox WHERE event_type='fixture.statistics'")).rows;
  assert.equal(jobs.length, 2);
  assert(jobs.every((item) => item.payload.fixtureId === fixture().id && item.payload.provider === "sorare"));
});

test("incomplete schedules are quarantined before publication and cannot overwrite a complete canonical season", async () => {
  const pipeline = new SorarePipeline(pool, mongo, "offline-synthetic-secret");
  const first = await archives.save(scheduleResponse(scheduleHeaders().slice(0, 1), "2026-11-10T15:00:00Z"));
  assert.equal(await pipeline.reconcile(), 1);
  const initial = (await administrator.query(`SELECT
    (SELECT count(*)::integer FROM sports.fixtures) AS fixtures,
    (SELECT count(*)::integer FROM sports.players) AS players,
    (SELECT count(*)::integer FROM sports.clubs) AS clubs,
    (SELECT count(*)::integer FROM sports.source_revisions) AS sources,
    (SELECT count(*)::integer FROM sports.normalized_revisions) AS revisions,
    (SELECT count(*)::integer FROM sports.ingestion_batches) AS imports,
    (SELECT count(*)::integer FROM sports.outbox) AS outbox,
    (SELECT count(*)::integer FROM sports.forecast_revisions) AS forecasts`)).rows[0];
  assert(Object.values(initial).every((count) => count === 0), "an initial incomplete schedule must not publish source rows, entities or forecast work");
  const firstMetadata = await mongo.collection("import_metadata").findOne({ _id: first.id } as never);
  assert.equal(firstMetadata?.state, "invalid");
  assert(firstMetadata?.issues.some((issue: { code: string }) => issue.code === "incomplete_schedule"));
  assert.equal((await archives.get(first.id))?.text, first.text);

  const complete = await archives.save(scheduleResponse(scheduleHeaders(), "2026-11-10T15:01:00Z"));
  assert.equal(await pipeline.reconcile(), 1);
  assert.equal((await administrator.query("SELECT count(*)::integer AS count FROM sports.fixtures")).rows[0].count, 380);
  assert.equal((await mongo.collection("import_metadata").findOne({ _id: complete.id } as never))?.state, "imported");
  const canonical = (await administrator.query(`SELECT f.provider_id,f.home_score,f.away_score,f.status,f.normalized_revision_id,
    h.name AS home_name,a.name AS away_name FROM sports.fixtures f
    JOIN sports.clubs h ON h.id=f.home_club_id JOIN sports.clubs a ON a.id=f.away_club_id ORDER BY f.provider_id`)).rows;
  const counts = async () => (await administrator.query(`SELECT
    (SELECT count(*)::integer FROM sports.source_revisions) AS sources,
    (SELECT count(*)::integer FROM sports.normalized_revisions) AS revisions,
    (SELECT count(*)::integer FROM sports.ingestion_batches) AS imports,
    (SELECT count(*)::integer FROM sports.outbox) AS outbox,
    (SELECT count(*)::integer FROM sports.forecast_revisions) AS forecasts`)).rows[0];
  const before = await counts();
  const corrupting = scheduleHeaders().slice(0, 379).map((header, index) => index === 0
    ? { ...header, homeGoals: 99, homeTeam: { ...header.homeTeam, name: "Rejected club name" } } : header);
  const refresh = await archives.save(scheduleResponse(corrupting, "2026-11-10T15:02:00Z"));
  assert.equal(await pipeline.reconcile(), 1);
  assert.deepEqual(await counts(), before);
  assert.deepEqual((await administrator.query(`SELECT f.provider_id,f.home_score,f.away_score,f.status,f.normalized_revision_id,
    h.name AS home_name,a.name AS away_name FROM sports.fixtures f
    JOIN sports.clubs h ON h.id=f.home_club_id JOIN sports.clubs a ON a.id=f.away_club_id ORDER BY f.provider_id`)).rows, canonical);
  const metadata = await mongo.collection("import_metadata").findOne({ _id: refresh.id } as never);
  assert.equal(metadata?.state, "invalid");
  assert(metadata?.issues.some((issue: { code: string }) => issue.code === "incomplete_schedule"));
  assert.equal((await archives.get(refresh.id))?.text, refresh.text);
  assert.equal(await pipeline.reconcile(), 0, "quarantined incomplete schedules must not retry forever");
});
