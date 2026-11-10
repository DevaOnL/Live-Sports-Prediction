import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MongoClient, type Db } from "mongodb";
import pg from "pg";
import { ReadService } from "../src/server/api/read";
import { selectObservedWindow } from "../src/server/forecast/engine";
import { prepareObservedInputs } from "../src/server/forecast/inputs";
import { ArchiveStore, archiveId } from "../src/server/ingestion/archive";
import { EnrichmentPipeline } from "../src/server/ingestion/enrichment";
import { HIGHLIGHTLY_LEAGUES, highlightlyResponse, type HighlightlyCapture } from "../src/server/ingestion/highlightly-client";
import { primaryFingerprint, type EnrichmentFixture } from "../src/server/ingestion/highlightly-normalize";
import { CURRENT_SOURCE } from "../src/server/ingestion/sources";
import { IngestionStore } from "../src/server/ingestion/store";
import type { ArchivedResponse, Batch, Coverage } from "../src/server/ingestion/types";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
const mongoDatabase = process.env.MONGO_TEST_DATABASE ?? "";
const mongoPort = process.env.MONGO_TEST_PORT ?? "";
const mongoHostId = process.env.MONGO_TEST_HOST_ID ?? "";
const testName = /^[a-z][a-z0-9_]{0,57}_test$/;
if (process.env.NODE_ENV !== "test" || !testName.test(database) || !/^\d{10,20}$/.test(clusterId)
  || !testName.test(mongoDatabase) || process.env.MONGO_DB !== mongoDatabase
  || !/^\d{1,5}$/.test(mongoPort) || Number(mongoPort) < 1 || Number(mongoPort) > 65535
  || !mongoHostId || /[\s\u0000-\u001f]/.test(mongoHostId)) {
  throw new Error("Enrichment pipeline tests require guarded disposable PostgreSQL 17 and MongoDB 8 _test databases.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const connection = { host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"),
  database, connectionTimeoutMillis: 5000, statement_timeout: 30000 };
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const scopes = CURRENT_SOURCE.coverage.map((coverage, index) => ({ coverage, index,
  clubs: Array.from({ length: 20 }, (_, club) => ({ id: `Club:${uuid(index * 1000 + club + 1)}`,
    name: `Test club ${index * 1000 + club + 1}`, slug: `test-club-${index * 1000 + club + 1}` })),
  player: { id: `Player:${uuid(index + 1)}`, name: `Test footballer ${index + 1}`, position: "MID" as const },
  nativeFixtureId: `Game:${uuid(index + 1)}`, externalFixtureId: (index + 1) * 1_000_000 + 1,
  kickoffAt: `2026-11-0${index + 1}T15:00:00.000Z`,
}));
type Scope = typeof scopes[number];
let admin: pg.Client;
let writer: pg.Pool;
let reader: pg.Pool;
let mongoAdmin: MongoClient;
let mongoWorker: MongoClient;
let mongo: Db;
let archives: ArchiveStore;
let primary: IngestionStore;
let pipeline: EnrichmentPipeline;
let primaryMinutes: Map<string, number>;
let scheduleCalls: string[];
let boxCalls: string[];

async function cli(script: string, args: string[] = []) {
  await execute(process.execPath, ["--import", "tsx", join(root, "scripts", script), ...args], {
    cwd: root, timeout: 60000, maxBuffer: 512000,
    env: { ...process.env, MONGO_PORT: mongoPort, MONGO_DB: mongoDatabase },
  });
}

before(async () => {
  admin = new pg.Client({ ...connection, user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD });
  await admin.connect();
  const identity = (await admin.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(identity.name, database);
  assert.equal(identity.identifier, clusterId);
  assert.equal(Math.trunc(Number(identity.version) / 10000), 17);
  assert.equal((await admin.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())")).rowCount, 0);
  const mongoHost = process.env.MONGO_HOST ?? "127.0.0.1";
  mongoAdmin = new MongoClient(`mongodb://${mongoHost}:${mongoPort}`, {
    auth: { username: process.env.MONGO_BOOTSTRAP_USER ?? "sports_bootstrap", password: process.env.MONGO_BOOTSTRAP_PASSWORD ?? "" },
    authSource: "admin", serverSelectionTimeoutMS: 5000,
  });
  await mongoAdmin.connect();
  const control = mongoAdmin.db("admin");
  const [build, host, databases] = await Promise.all([control.command({ buildInfo: 1 }), control.command({ hostInfo: 1 }), control.admin().listDatabases()]);
  assert.match(build.version, /^8\./);
  assert.equal(host.system.hostname, mongoHostId);
  assert.deepEqual(databases.databases.map((entry) => entry.name).filter((name) => !["admin", "config", "local", mongoDatabase].includes(name)), []);
  await cli("db.ts", ["provision"]);
  await cli("db.ts", ["migrate"]);
  await cli("mongo.ts");
  writer = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD, max: 6 });
  reader = new pg.Pool({ ...connection, user: "lsp_reader", password: process.env.POSTGRES_READER_PASSWORD, max: 3 });
  mongoWorker = new MongoClient(`mongodb://${mongoHost}:${mongoPort}`, {
    auth: { username: process.env.MONGO_WORKER_USER ?? "lsp_ingestion", password: process.env.MONGO_WORKER_PASSWORD ?? "" },
    authSource: mongoDatabase, serverSelectionTimeoutMS: 5000,
  });
  await mongoWorker.connect();
  mongo = mongoWorker.db(mongoDatabase);
  archives = new ArchiveStore(mongo);
  primary = new IngestionStore(writer, CURRENT_SOURCE);
});
after(async () => { await Promise.allSettled([reader?.end(), writer?.end(), admin?.end(), mongoWorker?.close(), mongoAdmin?.close()]); });

async function importPrimary(scope: Scope, minutes = 90) {
  primaryMinutes.set(scope.coverage.id, minutes);
  const batch: Batch = { coverage: scope.coverage, clubs: scope.clubs, players: [scope.player], standings: [], issues: [],
    fixtures: [{ id: scope.nativeFixtureId, leagueId: scope.coverage.id, season: scope.coverage.season,
      home: scope.clubs[0], away: scope.clubs[1], kickoffAt: scope.kickoffAt, status: "final", statisticsStatus: "partial",
      homeScore: 1, awayScore: 0, detailed: true,
      appearances: [{ player: scope.player, clubId: scope.clubs[0].id, participation: "played", minutes, rating: null,
        goals: 1, assists: 0, shotsOnTarget: 2, keyPasses: null, tackles: null, interceptions: 0, saves: null, goalsConceded: 0 }] }] };
  const text = JSON.stringify(batch);
  const response = { action: "get_statistics" as const, resourceKey: `sorare:synthetic:${scope.coverage.id}`,
    params: { provider: "sorare", league_id: scope.coverage.id, match_id: scope.nativeFixtureId }, text,
    retrievedAt: new Date().toISOString(), contentSha256: createHash("sha256").update(text).digest("hex") };
  await primary.import({ ...response, id: archiveId(response) }, batch);
}

function headers(scope: Scope) {
  let index = 0;
  return scope.clubs.flatMap((home, h) => scope.clubs.flatMap((away, a) => {
    if (h === a) return [];
    const finished = h === 0 && a === 1;
    return [{ id: (scope.index + 1) * 1_000_000 + ++index,
      date: finished ? scope.kickoffAt : "2027-01-20T15:00:00.000Z",
      league: { id: HIGHLIGHTLY_LEAGUES[scope.coverage.id], season: 2026 },
      homeTeam: { id: scope.index * 1000 + h + 1, name: home.name },
      awayTeam: { id: scope.index * 1000 + a + 1, name: away.name },
      state: { description: finished ? "Finished" : "Not started", score: { current: finished ? "1 - 0" : null } } }];
  }));
}
function schedule(coverage: Coverage, subset?: ReturnType<typeof headers>) {
  const scope = scopes.find((item) => item.coverage.id === coverage.id)!;
  const rows = subset ?? headers(scope);
  if (!subset) assert.equal(rows.length, 380);
  const captures = Array.from({ length: Math.max(1, Math.ceil(rows.length / 100)) }, (_, index) => ({
    path: `/matches?${new URLSearchParams({ leagueId: String(HIGHLIGHTLY_LEAGUES[coverage.id]), season: "2026", limit: "100", offset: String(index * 100) })}`,
    retrievedAt: new Date().toISOString(),
    text: JSON.stringify({ data: rows.slice(index * 100, (index + 1) * 100), plan: { tier: "BASIC", message: "Synthetic coverage" },
      pagination: { totalCount: rows.length, offset: index * 100, limit: 100 } }),
  }));
  return highlightlyResponse("get_events", coverage.id, { format: "highlightly-schedule-v1", captures });
}
function box(scope: Scope): HighlightlyCapture {
  return { path: `/box-score/${scope.externalFixtureId}`, retrievedAt: new Date().toISOString(), text: JSON.stringify([
    { team: { id: scope.index * 1000 + 1 }, players: [{ id: 8_000_000 + scope.index, name: scope.player.name,
      minutesPlayed: primaryMinutes.get(scope.coverage.id), matchRating: "7.50",
      statistics: { goalsScored: 1, assists: 0, shotsOnTarget: 2, passesKey: 2, tacklesTotal: 4, interceptionsTotal: 1 } }] },
    { team: { id: scope.index * 1000 + 2 }, players: [] },
  ]) };
}
function mockProvider() {
  pipeline.provider.schedule = async (coverage) => { scheduleCalls.push(coverage.id); return schedule(coverage); };
  pipeline.provider.get = async (action, path) => {
    assert.equal(action, "get_statistics"); boxCalls.push(path);
    const scope = scopes.find((item) => path === `/box-score/${item.externalFixtureId}`);
    assert(scope, "unexpected synthetic fixture request");
    return box(scope);
  };
}
beforeEach(async () => {
  const tables = (await admin.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  await admin.query(`TRUNCATE ${tables.map((row) => `sports.${row.tablename}`).join(",")} RESTART IDENTITY CASCADE`);
  const control = mongoAdmin.db(mongoDatabase);
  await control.collection("raw_archives").deleteMany({});
  await control.collection("import_metadata").deleteMany({});
  primaryMinutes = new Map(); scheduleCalls = []; boxCalls = [];
  for (const scope of scopes) await importPrimary(scope);
  pipeline = new EnrichmentPipeline(writer, mongo, "offline-synthetic-secret");
  mockProvider();
});

async function context(scope: Scope): Promise<EnrichmentFixture> {
  const f = (await reader.query(`SELECT f.*,h.name AS home_name,a.name AS away_name,c.provider_id AS league_id
    FROM sports.fixtures f JOIN sports.clubs h ON h.id=f.home_club_id JOIN sports.clubs a ON a.id=f.away_club_id
    JOIN sports.competition_seasons cs ON cs.id=f.season_id JOIN sports.competitions c ON c.id=cs.competition_id
    WHERE f.provider='sorare' AND f.provider_id=$1`, [scope.nativeFixtureId])).rows[0];
  const appearances = (await reader.query(`SELECT a.*,p.name FROM sports.appearances a JOIN sports.players p ON p.id=a.player_id WHERE a.fixture_id=$1 ORDER BY a.id`, [f.id])).rows;
  return { id: f.id, nativeId: f.provider_id, revisionId: f.normalized_revision_id, leagueId: f.league_id,
    kickoffAt: f.kickoff_at.toISOString(), home: { id: f.home_club_id, name: f.home_name }, away: { id: f.away_club_id, name: f.away_name },
    homeScore: f.home_score, awayScore: f.away_score, appearances: appearances.map((a) => ({ id: a.id,
      primaryRevisionId: a.normalized_revision_id, playerId: a.player_id, name: a.name, clubId: a.club_id,
      participation: a.participation, minutes: a.minutes, goals: a.goals, assists: a.assists, shotsOnTarget: a.shots_on_target })) };
}
async function importedSchedules(): Promise<Map<string, ArchivedResponse>> {
  const result = new Map<string, ArchivedResponse>();
  for (const scope of scopes) {
    const archive = await archives.save(schedule(scope.coverage));
    const imported = await pipeline.store.recordSchedule(archive);
    await archives.mark(archive.id, "imported", [], imported);
    result.set(scope.coverage.id, archive);
  }
  return result;
}

test("pipeline archives and supplements both leagues without replacing primary facts or refetching completed captures", async () => {
  assert.deepEqual(await pipeline.run(2), { fixtures: 2, appearances: 2, pending: 0, unmapped: 0 });
  assert.deepEqual(new Set(scheduleCalls), new Set(CURRENT_SOURCE.coverage.map((coverage) => coverage.id)));
  assert.equal(boxCalls.length, 2);
  assert.equal(await mongo.collection("raw_archives").countDocuments({ "params.provider": "highlightly" }), 4);
  const metadata = await mongo.collection("import_metadata").find({}).toArray();
  assert.equal(metadata.length, 4);
  assert(metadata.every((row) => row.state === "imported"));
  const reads = new ReadService(reader, CURRENT_SOURCE);
  for (const scope of scopes) {
    const base = (await reader.query(`SELECT a.rating,a.key_passes,a.tackles FROM sports.appearances a
      JOIN sports.players p ON p.id=a.player_id WHERE p.provider_id=$1`, [scope.player.id])).rows[0];
    assert.deepEqual(base, { rating: null, key_passes: null, tackles: null });
    const profile = await reads.player(scope.player.id);
    assert.equal(profile.observedAppearances[0].rating, 7.5);
    assert.equal(profile.observedAppearances[0].metrics.keyPasses, 2);
    assert.equal(profile.observedAppearances[0].metrics.tackles, 4);
    assert.equal(profile.observedAppearances[0].metrics.interceptions, 0);
    assert.equal(profile.observedAppearances[0].fieldSources.rating.provider, "highlightly");
  }
  assert.deepEqual(await pipeline.run(2), { fixtures: 0, appearances: 0, pending: 0, unmapped: 0 });
  assert.equal(scheduleCalls.length, 2);
  assert.equal(boxCalls.length, 2);
});

test("rejected raw captures never establish completion and are quarantined before a valid retry", async () => {
  const validGet = pipeline.provider.get.bind(pipeline.provider);
  let invalidId = "";
  pipeline.provider.get = async (action, path) => {
    const capture = await validGet(action, path);
    const rows = JSON.parse(capture.text);
    rows[1].team.id = rows[0].team.id;
    return { ...capture, text: JSON.stringify(rows) };
  };
  await assert.rejects(pipeline.run(2), /team identity/);
  const invalid = await mongo.collection("raw_archives").findOne({ action: "get_statistics", "params.provider": "highlightly" });
  assert(invalid); invalidId = String(invalid._id);
  assert.notEqual((await mongo.collection("import_metadata").findOne({ _id: invalid._id }))?.state, "imported");
  assert.equal((await writer.query("SELECT count(*)::int AS count FROM sports.appearance_enrichments")).rows[0].count, 0);
  pipeline.provider.get = validGet;
  assert.deepEqual(await pipeline.run(2), { fixtures: 2, appearances: 2, pending: 0, unmapped: 0 });
  assert.equal((await mongo.collection("import_metadata").findOne({ _id: invalidId } as never))?.state, "invalid");
  assert.equal(boxCalls.length, 3);
  assert.equal((await reader.query("SELECT count(*)::int AS count FROM sports.effective_appearances WHERE rating IS NOT NULL")).rows[0].count, 2);
});

test("pending immutable box captures recover through SQL and markers without provider refetches", async () => {
  const schedules = await importedSchedules();
  const pending: ArchivedResponse[] = [];
  for (const scope of scopes) {
    const fixture = await context(scope);
    pending.push(await archives.save(highlightlyResponse("get_statistics", scope.coverage.id, { format: "highlightly-box-v1",
      fixture: headers(scope)[0], scheduleArchiveId: schedules.get(scope.coverage.id)!.id,
      primaryFingerprint: primaryFingerprint(fixture), capture: box(scope) })));
  }
  pipeline.provider.schedule = async () => { throw new Error("Recovery must not fetch schedules"); };
  pipeline.provider.get = async () => { throw new Error("Recovery must not fetch box scores"); };
  assert.deepEqual(await pipeline.run(2), { fixtures: 0, appearances: 0, pending: 0, unmapped: 0 });
  for (const archive of pending) {
    assert.equal((await archives.get(archive.id))?.text, archive.text);
    assert.equal((await mongo.collection("import_metadata").findOne({ _id: archive.id } as never))?.state, "imported");
    assert.equal((await writer.query("SELECT count(*)::int AS count FROM sports.ingestion_batches WHERE archive_id=$1", [archive.id])).rows[0].count, 1);
  }
  assert.equal((await reader.query("SELECT count(*)::int AS count FROM sports.effective_appearances WHERE rating=7.5")).rows[0].count, 2);
});

test("changed primary evidence invalidates the cached supplement and causes a newly anchored fetch", async () => {
  await pipeline.run(2);
  const previous = await mongo.collection("raw_archives").findOne({ action: "get_statistics", "params.league_id": scopes[0].coverage.id });
  assert(previous);
  await importPrimary(scopes[0], 80);
  const changed = await context(scopes[0]);
  assert.equal((await reader.query("SELECT rating FROM sports.effective_appearances WHERE fixture_id=$1", [changed.id])).rows[0].rating, null);
  assert.deepEqual(await pipeline.run(2), { fixtures: 1, appearances: 1, pending: 0, unmapped: 0 });
  assert.equal(boxCalls.length, 3);
  assert.equal(boxCalls.at(-1), `/box-score/${scopes[0].externalFixtureId}`);
  assert.equal((await reader.query("SELECT rating FROM sports.effective_appearances WHERE fixture_id=$1", [changed.id])).rows[0].rating, "7.50");
  const current = await mongo.collection("raw_archives").find({ action: "get_statistics", "params.league_id": scopes[0].coverage.id }).toArray();
  assert.equal(current.length, 2);
  assert(current.some((row) => row._id === previous._id && row.text === previous.text));
  assert.equal((await writer.query("SELECT count(*)::int AS count FROM sports.appearance_enrichments WHERE fixture_id=$1", [changed.id])).rows[0].count, 2);
});

test("reported partial catalogues enrich available matches without changing the primary five-match window or participation", async () => {
  const missingScope = scopes[1];
  const extra: Batch = { coverage: missingScope.coverage, clubs: missingScope.clubs, players: [missingScope.player], standings: [], issues: [],
    fixtures: Array.from({ length: 4 }, (_, index) => ({ id: `Game:${uuid(20_000 + index)}`,
      leagueId: missingScope.coverage.id, season: missingScope.coverage.season,
      home: missingScope.clubs[0], away: missingScope.clubs[index + 2], kickoffAt: `2026-11-0${index + 3}T15:00:00.000Z`,
      status: "final", statisticsStatus: "partial", homeScore: 1, awayScore: 0, detailed: true,
      appearances: [{ player: missingScope.player, clubId: missingScope.clubs[0].id, participation: "played", minutes: 90,
        rating: null, goals: 1, assists: 0, shotsOnTarget: 2, keyPasses: null, tackles: null, interceptions: 0, saves: null, goalsConceded: 0 }] })) };
  const text = JSON.stringify(extra);
  const response = { action: "get_statistics" as const, resourceKey: "sorare:synthetic:additional-primary-appearances",
    params: { provider: "sorare", league_id: missingScope.coverage.id }, text, retrievedAt: new Date().toISOString(),
    contentSha256: createHash("sha256").update(text).digest("hex") };
  await primary.import({ ...response, id: archiveId(response) }, extra);
  const cutoff = new Date().toISOString();
  const window = async () => {
    const client = await reader.connect();
    try { return selectObservedWindow((await prepareObservedInputs(client, cutoff, CURRENT_SOURCE)).get(missingScope.player.id)!.input); }
    finally { client.release(); }
  };
  const beforeWindow = await window();
  assert.equal(beforeWindow.ready, true);
  assert.equal(beforeWindow.selected.length, 5);
  const beforeFixtures = (await reader.query("SELECT * FROM sports.fixtures ORDER BY id")).rows;
  const beforeAppearances = (await reader.query("SELECT * FROM sports.appearances ORDER BY id")).rows;
  pipeline.provider.schedule = async (coverage) => {
    scheduleCalls.push(coverage.id);
    const scope = scopes.find((item) => item.coverage.id === coverage.id)!;
    const rows = headers(scope);
    return schedule(coverage, scope.index === 0 ? rows.slice(0, 290) : rows.slice(1, 281));
  };
  assert.deepEqual(await pipeline.run(2), { fixtures: 1, appearances: 1, pending: 0, unmapped: 5 });
  assert.equal(boxCalls.length, 1);
  assert.equal(boxCalls[0], `/box-score/${scopes[0].externalFixtureId}`);
  assert.deepEqual((await reader.query("SELECT * FROM sports.fixtures ORDER BY id")).rows, beforeFixtures);
  assert.deepEqual((await reader.query("SELECT * FROM sports.appearances ORDER BY id")).rows, beforeAppearances);
  const afterWindow = await window();
  assert.deepEqual(afterWindow, beforeWindow);
  assert(afterWindow.selected.every((appearance) => appearance.participation === "played" && appearance.minutes === 90 && appearance.rating === null));
  const reads = new ReadService(reader, CURRENT_SOURCE);
  assert.equal((await reads.player(scopes[0].player.id)).observedAppearances[0].rating, 7.5);
  assert((await reads.player(missingScope.player.id)).observedAppearances.every((appearance) => appearance.rating === null && appearance.participation === "played"));
});

test("absence from a newer partial catalogue preserves earlier verified supplements without inventing DNP", async () => {
  await pipeline.run(2);
  const reads = new ReadService(reader, CURRENT_SOURCE);
  const original = (await reads.player(scopes[1].player.id)).observedAppearances[0];
  const boxArchive = await mongo.collection("raw_archives").findOne({ action: "get_statistics", "params.league_id": scopes[1].coverage.id });
  assert(boxArchive);
  for (const scope of scopes) {
    const rows = headers(scope);
    const archive = await archives.save(schedule(scope.coverage, scope.index === 0 ? rows.slice(0, 290) : rows.slice(1, 281)));
    const result = await pipeline.store.recordSchedule(archive);
    await archives.mark(archive.id, "imported", [], result);
  }
  pipeline.provider.schedule = async () => { throw new Error("Fresh partial catalogues must be reused"); };
  assert.deepEqual(await pipeline.run(2), { fixtures: 0, appearances: 0, pending: 0, unmapped: 1 });
  assert.equal(boxCalls.length, 2);
  const current = (await reads.player(scopes[1].player.id)).observedAppearances[0];
  assert.equal(current.rating, 7.5);
  assert.equal(current.metrics.keyPasses, 2);
  assert.equal(current.participation, "played");
  assert.equal(current.minutes, 90);
  assert.deepEqual(current.fieldSources, original.fieldSources);
  assert.equal((await mongo.collection("import_metadata").findOne({ _id: boxArchive._id }))?.state, "imported");
});
