import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { AdminError, AdminService, type AppearanceCorrection, type AppearanceMetrics } from "../src/server/api/admin";
import { archiveId } from "../src/server/ingestion/archive";
import { coverageFor } from "../src/server/ingestion/coverage";
import { JobQueue } from "../src/server/ingestion/jobs";
import { IngestionStore, RateLimitError } from "../src/server/ingestion/store";
import type { ArchivedResponse, Batch, Fixture, ProviderAction } from "../src/server/ingestion/types";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId)) {
  throw new Error("Administration tests require NODE_ENV=test, a dedicated _test database and POSTGRES_TEST_CLUSTER_ID from a disposable PostgreSQL 17 cluster.");
}
const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const connection = { host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"), database,
  connectionTimeoutMillis: 5_000, statement_timeout: 30_000 };
const actor = "admin_operator";
let bootstrap: pg.Client;
let pool: pg.Pool;
let reader: pg.Pool;
let service: AdminService;
let season: string;
let originalRevision: string;
let originalSource: string;
const initialMetrics: AppearanceMetrics = { minutes: 97, rating: 7.5, goals: 1, assists: 0, shotsOnTarget: 2,
  keyPasses: 1, tackles: 2, interceptions: 1, saves: null, goalsConceded: null };

before(async () => {
  bootstrap = new pg.Client({ ...connection, user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD });
  await bootstrap.connect();
  const server = (await bootstrap.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(server.name, database);
  assert.equal(server.identifier, clusterId, "refusing an unconfirmed PostgreSQL cluster");
  assert.equal(Math.trunc(Number(server.version) / 10_000), 17);
  assert.equal((await bootstrap.query(`SELECT datname FROM pg_database
    WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())`)).rowCount, 0,
  "administration tests require a disposable PostgreSQL cluster without other databases");
  for (const command of ["provision", "migrate"]) await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), command], {
    cwd: root, timeout: 60_000, maxBuffer: 512_000,
  });
  pool = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD, max: 8 });
  reader = new pg.Pool({ ...connection, user: "lsp_reader", password: process.env.POSTGRES_READER_PASSWORD, max: 2 });
  service = new AdminService(pool);
});
after(async () => { await Promise.allSettled([pool?.end(), reader?.end(), bootstrap?.end()]); });

beforeEach(async () => {
  const tables = (await bootstrap.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  await bootstrap.query(`TRUNCATE ${tables.map((row) => `sports.${row.tablename}`).join(",")} RESTART IDENTITY CASCADE`);
  const competition = (await pool.query(`INSERT INTO sports.competitions(provider_id,name,country_name,timezone,coefficient,enabled)
    VALUES ('153','Administration test league','England','Europe/London',1.5,true) RETURNING id`)).rows[0].id;
  season = (await pool.query(`INSERT INTO sports.competition_seasons(competition_id,label,starts_on,ends_on,expected_clubs,enabled)
    VALUES ($1,'2026/27','2026-07-01','2027-06-30',24,true) RETURNING id`, [competition])).rows[0].id;
  const [home, away] = (await pool.query(`INSERT INTO sports.clubs(provider_id,name)
    VALUES ('7001','Administration home'),('7002','Administration away') RETURNING id`)).rows.map((row) => row.id);
  await pool.query("INSERT INTO sports.season_clubs(season_id,club_id) VALUES ($1,$2),($1,$3)", [season, home, away]);
  const player = (await pool.query(`INSERT INTO sports.players(provider_id,name,position)
    VALUES ('8001','Administration player','FWD') RETURNING id`)).rows[0].id;
  const membership = (await pool.query(`INSERT INTO sports.player_memberships(player_id,club_id,season_id,valid_from)
    VALUES ($1,$2,$3,'2026-07-01T00:00:00Z') RETURNING id`, [player, home, season])).rows[0].id;
  originalSource = (await pool.query(`INSERT INTO sports.source_revisions(action,resource_key,archive_ref,content_sha256,retrieved_at)
    VALUES ('get_events','administration:test','administration:test',$1,'2026-08-02T12:00:00Z') RETURNING id`, ["a".repeat(64)])).rows[0].id;
  originalRevision = (await pool.query(`INSERT INTO sports.normalized_revisions(source_revision_id,entity_type,entity_key,content_sha256)
    VALUES ($1,'appearance','900001:8001',$2) RETURNING id`, [originalSource, "b".repeat(64)])).rows[0].id;
  const fixture = (await pool.query(`INSERT INTO sports.fixtures(provider_id,season_id,home_club_id,away_club_id,kickoff_at,status,
    statistics_status,home_score,away_score) VALUES ('900001',$1,$2,$3,'2026-08-01T15:00:00Z','final','complete',1,0) RETURNING id`,
  [season, home, away])).rows[0].id;
  await pool.query(`INSERT INTO sports.appearances(fixture_id,player_id,season_id,club_id,membership_id,participation,
    minutes,rating,goals,assists,shots_on_target,key_passes,tackles,interceptions,saves,goals_conceded,normalized_revision_id)
    VALUES ($1,$2,$3,$4,$5,'played',97,7.5,1,0,2,1,2,1,NULL,NULL,$6)`, [fixture, player, season, home, membership, originalRevision]);
});

function correction(overrides: Partial<AppearanceCorrection> = {}): AppearanceCorrection {
  return { playerId: "8001", fixtureId: "900001", requestId: randomUUID(), expectedRevisionId: originalRevision,
    reason: "Reviewed a reported statistic", changes: { rating: 8.25, goals: 2 }, ...overrides };
}
const rejected = (status: number, code?: string) => (error: unknown) => error instanceof AdminError
  && error.status === status && (code === undefined || error.code === code);
async function state() {
  const result: Record<string, unknown> = {};
  for (const table of ["source_revisions", "normalized_revisions", "appearances", "outbox", "audit_log", "jobs", "ingestion_batches", "provider_requests"]) {
    result[table] = (await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS records FROM sports.${table} t`)).rows[0].records;
  }
  return result;
}

function observedFixture(overrides: Partial<Fixture> = {}): Fixture {
  const player = { id: "8001", name: "Administration player", position: "FWD" as const };
  return { id: "900001", leagueId: "153", season: "2026/27", home: { id: "7001", name: "Administration home" },
    away: { id: "7002", name: "Administration away" }, kickoffAt: "2026-08-01T15:00:00.000Z", status: "final",
    statisticsStatus: "complete", homeScore: 1, awayScore: 0, detailed: true,
    appearances: [{ player, clubId: "7001", participation: "played", ...initialMetrics, rating: 6.5 }], ...overrides };
}
function observedBatch(fixtures: Fixture[] = [observedFixture()]): Batch {
  return { coverage: coverageFor("153"), clubs: [observedFixture().home, observedFixture().away],
    players: [...new Map(fixtures.flatMap((fixture) => fixture.appearances.map((appearance) => [appearance.player.id, appearance.player] as const))).values()],
    standings: [], issues: [], fixtures };
}
function observation(batch: Batch, retrievedAt: string, action: ProviderAction = "get_events"): ArchivedResponse {
  const text = JSON.stringify(batch);
  const params: Record<string, string> = action === "get_statistics" ? { league_id: "153", match_id: "900001" } : { league_id: "153", timezone: "UTC" };
  const source = { action, resourceKey: `administration:observation:${randomUUID()}`, params,
    text, contentSha256: createHash("sha256").update(text).digest("hex"), retrievedAt };
  return { ...source, id: archiveId(source) };
}
async function manualObservationTime(sourceId: string, seconds = 0): Promise<string> {
  return (await pool.query(`SELECT to_char((retrieved_at+$2::integer*interval '1 second') AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at FROM sports.source_revisions WHERE id=$1`, [sourceId, seconds])).rows[0].observed_at;
}
async function fixtureState(fixtureId = "900001") {
  const header = (await pool.query("SELECT to_jsonb(f) AS record FROM sports.fixtures f WHERE f.provider='apifootball' AND f.provider_id=$1", [fixtureId])).rows[0]?.record;
  const appearances = (await pool.query(`SELECT to_jsonb(a) AS record FROM sports.appearances a JOIN sports.fixtures f ON f.id=a.fixture_id
    WHERE f.provider='apifootball' AND f.provider_id=$1 ORDER BY a.player_id`, [fixtureId])).rows.map((row) => row.record);
  return { header, appearances };
}
async function addOtherAppearance() {
  const player = (await pool.query("INSERT INTO sports.players(provider_id,name,position) VALUES ('8002','Other administration player','MID') RETURNING id")).rows[0].id;
  const membership = (await pool.query(`INSERT INTO sports.player_memberships(player_id,club_id,season_id,valid_from)
    SELECT $1,home_club_id,season_id,'2026-07-01T00:00:00Z' FROM sports.fixtures WHERE provider='apifootball' AND provider_id='900001' RETURNING id`, [player])).rows[0].id;
  const revision = (await pool.query(`INSERT INTO sports.normalized_revisions(source_revision_id,entity_type,entity_key,content_sha256)
    VALUES ($1,'appearance','900001:8002',$2) RETURNING id`, [originalSource, "c".repeat(64)])).rows[0].id;
  await pool.query(`INSERT INTO sports.appearances(fixture_id,player_id,season_id,club_id,membership_id,participation,minutes,rating,
    goals,assists,shots_on_target,key_passes,tackles,interceptions,normalized_revision_id)
    SELECT id,$1,season_id,home_club_id,$2,'played',60,6,0,0,0,0,0,0,$3 FROM sports.fixtures WHERE provider='apifootball' AND provider_id='900001'`,
  [player, membership, revision]);
}

test("import and forecast commands queue once and return the original outcome after publication", async () => {
  const requestId = randomUUID();
  const [first, repeated] = await Promise.all([service.requestImport(actor, requestId), service.requestImport(actor, requestId.toUpperCase())]);
  assert.deepEqual(first, repeated);
  assert.equal(first.kind, "source.sync");
  assert.deepEqual((await pool.query("SELECT payload FROM sports.outbox WHERE id=$1", [first.eventId])).rows[0].payload, {});
  const queue = new JobQueue(pool, "admin-command-test", true);
  assert.equal(await queue.dispatch(), 1);
  assert.equal((await service.jobs()).items[0].outboxId, first.eventId);
  await queue.runOnce(async (job) => { assert.equal(job.kind, "source.sync"); });
  assert.deepEqual(await service.requestImport(actor, requestId), first);
  await assert.rejects(service.requestRefresh(actor, requestId), rejected(409, "request_conflict"));
  await assert.rejects(service.requestImport("another_admin", requestId), rejected(409, "request_conflict"));
  const refresh = await service.requestRefresh(actor, randomUUID());
  assert.equal(refresh.kind, "forecast.refresh");
  assert.equal((await pool.query("SELECT event_type FROM sports.outbox WHERE id=$1", [refresh.eventId])).rows[0].event_type, "forecast.requested");
  const audit = (await pool.query("SELECT actor_type,actor_id,detail FROM sports.audit_log WHERE id=$1", [requestId])).rows[0];
  assert.equal(audit.actor_type, "user");
  assert.equal(audit.actor_id, actor);
  assert.match(audit.detail.commandHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(audit.detail.result, first);
});

test("a UUID already occupied by another audit record conflicts without changing any data", async () => {
  const requestId = randomUUID();
  await pool.query(`INSERT INTO sports.audit_log(id,actor_type,action,entity_type,entity_key,detail)
    VALUES ($1,'worker','normalize','appearance','900001:8001','{}')`, [requestId]);
  const before = await state();
  await assert.rejects(service.correctAppearance(actor, correction({ requestId })), rejected(409, "request_conflict"));
  assert.deepEqual(await state(), before);
});

test("statistics requests validate the exact covered fixture and preserve request idempotency", async () => {
  const options = { leagueId: "153", fixtureId: "900001", requestId: randomUUID() };
  const first = await service.requestStatistics(actor, options);
  assert.deepEqual(await service.requestStatistics(actor, options), first);
  assert.deepEqual((await pool.query("SELECT payload FROM sports.outbox WHERE id=$1", [first.eventId])).rows[0].payload,
    { leagueId: "153", fixtureId: "900001" });
  await assert.rejects(service.requestStatistics(actor, { ...options, leagueId: "164" }), rejected(409, "request_conflict"));
  await assert.rejects(service.requestStatistics(actor, { ...options, leagueId: "164", requestId: randomUUID() }), rejected(409, "statistics_unavailable"));
  await pool.query("UPDATE sports.fixtures SET status='scheduled'");
  await assert.rejects(service.requestStatistics(actor, { ...options, requestId: randomUUID() }), rejected(409, "statistics_unavailable"));
  await pool.query("UPDATE sports.fixtures SET status='live'");
  assert.equal((await service.requestStatistics(actor, { ...options, requestId: randomUUID() })).kind, "fixture.statistics");
});

test("manual correction appends complete SQL lineage, audits its actual actor and preserves authoritative source records", async () => {
  const original = (await pool.query("SELECT * FROM sports.source_revisions WHERE id=$1", [originalSource])).rows[0];
  const request = correction({ changes: { rating: 8.25, goals: 0, tackles: null, minutes: 107 } });
  const result = await service.correctAppearance(actor, request);
  assert.equal(result.provider, "manual");
  assert.equal(result.providerMaySupersede, true);
  assert.deepEqual(result.metrics, { ...initialMetrics, rating: 8.25, goals: 0, tackles: null, minutes: 107 });
  const lineage = (await pool.query(`SELECT n.entity_type,n.entity_key,n.parent_id,n.source_revision_id,s.provider,s.action,s.archive_ref,s.content_sha256
    FROM sports.normalized_revisions n JOIN sports.source_revisions s ON s.id=n.source_revision_id WHERE n.id=$1`, [result.revisionId])).rows[0];
  assert.equal(lineage.entity_type, "appearance");
  assert.equal(lineage.entity_key, "900001:8001");
  assert.equal(lineage.parent_id, originalRevision);
  assert.equal(lineage.source_revision_id, result.sourceRevisionId);
  assert.equal(lineage.provider, "manual");
  assert.equal(lineage.archive_ref, `manual:${request.requestId}`);
  const audit = (await pool.query("SELECT * FROM sports.audit_log WHERE id=$1", [request.requestId])).rows[0];
  assert.equal(audit.actor_type, "user");
  assert.equal(audit.actor_id, actor);
  assert.equal(audit.normalized_revision_id, result.revisionId);
  assert.equal(audit.detail.commandHash, lineage.content_sha256);
  assert.equal(audit.detail.reason, request.reason);
  assert.deepEqual(audit.detail.before, { revisionId: originalRevision, metrics: initialMetrics });
  assert.deepEqual(audit.detail.after, { revisionId: result.revisionId, metrics: result.metrics });
  assert.deepEqual((await pool.query("SELECT * FROM sports.source_revisions WHERE id=$1", [originalSource])).rows[0], original);
  const canonical = (await pool.query("SELECT * FROM sports.appearances")).rows[0];
  assert.equal(canonical.participation, "played");
  assert.equal(canonical.minutes, 107);
  assert.equal(canonical.tackles, null);
  assert.equal(canonical.normalized_revision_id, result.revisionId);
  assert.equal((await pool.query("SELECT * FROM sports.ingestion_batches")).rowCount, 0, "manual corrections cannot invent an archived provider batch");
  const event = (await pool.query("SELECT * FROM sports.outbox")).rows[0];
  assert.equal(event.event_type, "canonical.changed");
  assert.deepEqual(event.payload, { fixtureId: "900001", playerId: "8001", revisionId: result.revisionId });
});

test("concurrent identical corrections append once and UUID reuse with different metrics conflicts", async () => {
  const request = correction();
  const results = await Promise.all(Array.from({ length: 4 }, () => service.correctAppearance(actor, request)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal((await pool.query("SELECT * FROM sports.source_revisions WHERE provider='manual'")).rowCount, 1);
  assert.equal((await pool.query("SELECT * FROM sports.audit_log WHERE action='admin.appearance.correct'")).rowCount, 1);
  const before = await state();
  await assert.rejects(service.correctAppearance(actor, { ...request, changes: { rating: 1 } }), rejected(409, "request_conflict"));
  assert.deepEqual(await state(), before);
});

test("optimistic concurrency permits one correction and rejects a second stale revision without side effects", async () => {
  const outcomes = await Promise.allSettled([service.correctAppearance(actor, correction()), service.correctAppearance(actor, correction({ changes: { rating: 6 } }))]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  const conflict = outcomes.find((item) => item.status === "rejected") as PromiseRejectedResult;
  assert(rejected(409, "revision_conflict")(conflict.reason));
  assert.equal((await pool.query("SELECT * FROM sports.source_revisions WHERE provider='manual'")).rowCount, 1);
  assert.equal((await pool.query("SELECT * FROM sports.outbox")).rowCount, 1);
});

test("an audit failure rolls back canonical metrics, source lineage and the outbox together", async () => {
  const before = await state();
  await bootstrap.query(`CREATE FUNCTION sports.reject_admin_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='admin.appearance.correct' THEN RAISE EXCEPTION 'unexposed database diagnostic'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_admin_audit_test BEFORE INSERT ON sports.audit_log FOR EACH ROW EXECUTE FUNCTION sports.reject_admin_audit_test()`);
  try {
    await assert.rejects(service.correctAppearance(actor, correction()), (error: unknown) => rejected(503, "admin_unavailable")(error)
      && error instanceof Error && !error.message.includes("diagnostic"));
  } finally { await bootstrap.query("DROP TRIGGER reject_admin_audit_test ON sports.audit_log; DROP FUNCTION sports.reject_admin_audit_test()"); }
  assert.deepEqual(await state(), before);
});

test("only allowlisted nullable numeric metrics can change, with integer counts and two-decimal bounded ratings", async () => {
  const invalidChanges: unknown[] = [{}, { participation: "played" }, { clubId: "7002" }, { membershipId: randomUUID() }, { status: "final" },
    { minutes: -1 }, { minutes: 1.5 }, { goals: "2" }, { assists: true }, { rating: 10.01 }, { rating: 1.005 }, { rating: 1.00000000001 }, { rating: Number.NaN },
    { rating: Number.POSITIVE_INFINITY }, { saves: 2_147_483_648 }, { tackles: undefined }, { "goals=0;DELETE FROM sports.players": 0 }];
  for (const changes of invalidChanges) await assert.rejects(service.correctAppearance(actor,
    correction({ changes: changes as AppearanceCorrection["changes"] })), rejected(400));
  const before = await state();
  await assert.rejects(service.correctAppearance(actor, correction({ reason: " " })), rejected(400));
  await assert.rejects(service.correctAppearance(actor, correction({ reason: "a\nb" })), rejected(400));
  assert.deepEqual(await state(), before);
  const nullable = Object.fromEntries(Object.keys(initialMetrics).map((key) => [key, null])) as AppearanceMetrics;
  const result = await service.correctAppearance(actor, correction({ changes: nullable }));
  assert.deepEqual(result.metrics, nullable);
  assert.equal((await pool.query("SELECT participation FROM sports.appearances")).rows[0].participation, "played");
});

test("corrections require every approved coverage guard and known played finalized context", async () => {
  const cases: [string, unknown[], unknown[]][] = [
    ["UPDATE sports.competitions SET enabled=$1", [false], [true]],
    ["UPDATE sports.competition_seasons SET enabled=$1", [false], [true]],
    ["UPDATE sports.competitions SET provider_id=$1", ["152"], ["153"]],
    ["UPDATE sports.competitions SET provider=$1", ["other"], ["apifootball"]],
    ["UPDATE sports.competitions SET coefficient=$1", [2], [1.5]],
    ["UPDATE sports.competitions SET timezone=$1", ["Europe/Paris"], ["Europe/London"]],
    ["UPDATE sports.competition_seasons SET label=$1", ["2025/26"], ["2026/27"]],
    ["UPDATE sports.competition_seasons SET starts_on=$1", ["2026-07-02"], ["2026-07-01"]],
    ["UPDATE sports.competition_seasons SET ends_on=$1", ["2027-06-29"], ["2027-06-30"]],
    ["UPDATE sports.competition_seasons SET expected_clubs=$1", [23], [24]],
    ["UPDATE sports.fixtures SET status=$1", ["live"], ["final"]],
    ["UPDATE sports.fixtures SET kickoff_at=$1", [null], ["2026-08-01T15:00:00Z"]],
    ["UPDATE sports.appearances SET participation=$1", ["unknown"], ["played"]],
  ];
  for (const [sql, changed, restored] of cases) {
    await pool.query(sql, changed);
    try { await assert.rejects(service.correctAppearance(actor, correction()), rejected(409, "correction_unavailable"), sql); }
    finally { await pool.query(sql, restored); }
  }
  await pool.query("UPDATE sports.competitions SET provider_id='164',timezone='Europe/Paris'");
  await pool.query("UPDATE sports.competition_seasons SET expected_clubs=18");
  assert.equal((await service.correctAppearance(actor, correction())).provider, "manual");
});

test("unknown or DNP participation, missing membership and missing revision cannot be repaired by a metric correction", async () => {
  await pool.query(`UPDATE sports.appearances SET participation='dnp',minutes=0,rating=NULL,goals=0,assists=0,
    shots_on_target=0,key_passes=0,tackles=0,interceptions=0`);
  await assert.rejects(service.correctAppearance(actor, correction()), rejected(409, "correction_unavailable"));
  await pool.query("UPDATE sports.appearances SET participation='unknown',club_id=NULL,membership_id=NULL");
  await assert.rejects(service.correctAppearance(actor, correction()), rejected(409, "correction_unavailable"));
  await pool.query("UPDATE sports.appearances SET normalized_revision_id=NULL");
  await assert.rejects(service.correctAppearance(actor, correction()), rejected(409, "revision_conflict"));
  assert.equal((await pool.query("SELECT * FROM sports.source_revisions WHERE provider='manual'")).rowCount, 0);
  await assert.rejects(service.correctAppearance(actor, correction({ playerId: "8999" })), rejected(404, "appearance_not_found"));
});

test("an older provider archive preserves the whole corrected fixture while other fixtures import normally", async () => {
  await addOtherAppearance();
  const manual = await service.correctAppearance(actor, correction());
  const before = await fixtureState();
  const sourceBefore = (await pool.query("SELECT * FROM sports.source_revisions WHERE id=ANY($1::uuid[]) ORDER BY id", [[originalSource, manual.sourceRevisionId]])).rows;
  const batch = observedBatch([observedFixture({ homeScore: 9, status: "cancelled" }), observedFixture({
    id: "900002", kickoffAt: "2026-08-02T15:00:00.000Z", homeScore: 3,
  })]);
  const archive = observation(batch, await manualObservationTime(manual.sourceRevisionId, -1));
  const result = await new IngestionStore(pool).import(archive, batch);
  assert.deepEqual(await fixtureState(), before, "the corrected metrics, header and omitted second player must all remain unchanged");
  assert.equal(before.appearances.length, 2);
  assert.equal((await new IngestionStore(pool).fixture("900002"))?.homeScore, 3);
  assert.equal(result.fixtures, 1);
  assert.equal(result.appearances, 1);
  const marker = (await pool.query(`SELECT b.issues_json,s.archive_ref FROM sports.ingestion_batches b
    JOIN sports.source_revisions s ON s.id=b.source_revision_id WHERE b.archive_id=$1`, [archive.id])).rows[0];
  assert.equal(marker.archive_ref, archive.id);
  assert.deepEqual(marker.issues_json, [{ code: "superseded_by_manual_correction", resource: "900001" }]);
  assert.deepEqual((await pool.query("SELECT * FROM sports.source_revisions WHERE id=ANY($1::uuid[]) ORDER BY id", [[originalSource, manual.sourceRevisionId]])).rows, sourceBefore);
  assert.equal((await pool.query("SELECT * FROM sports.audit_log WHERE id=$1", [manual.requestId])).rowCount, 1);
  assert.equal((await new IngestionStore(pool).import(archive, batch)).duplicate, true);
});

test("provider observations at the exact manual correction timestamp cannot replace its fixture", async () => {
  const manual = await service.correctAppearance(actor, correction());
  const before = await fixtureState();
  const batch = observedBatch([observedFixture({ homeScore: 8, appearances: [] })]);
  const archive = observation(batch, await manualObservationTime(manual.sourceRevisionId), "get_statistics");
  const result = await new IngestionStore(pool).import(archive, batch);
  assert.deepEqual(await fixtureState(), before);
  assert.equal(result.fixtures, 0);
  assert.equal(result.appearances, 0);
  assert.equal((await pool.query(`SELECT s.retrieved_at=m.retrieved_at AS same_time FROM sports.source_revisions s,sports.source_revisions m
    WHERE s.archive_ref=$1 AND m.id=$2`, [archive.id, manual.sourceRevisionId])).rows[0].same_time, true);
  assert.deepEqual((await pool.query("SELECT issues_json FROM sports.ingestion_batches WHERE archive_id=$1", [archive.id])).rows[0].issues_json,
    [{ code: "superseded_by_manual_correction", resource: "900001" }]);
});

test("strictly newer provider observations supersede manual values and retain the correction ancestry and audit", async () => {
  const result = await service.correctAppearance(actor, correction());
  const batch = observedBatch();
  const archive = observation(batch, await manualObservationTime(result.sourceRevisionId, 1));
  await new IngestionStore(pool).import(archive, batch);
  const canonical = (await pool.query(`SELECT a.rating,a.goals,n.parent_id,s.provider FROM sports.appearances a
    JOIN sports.normalized_revisions n ON n.id=a.normalized_revision_id JOIN sports.source_revisions s ON s.id=n.source_revision_id`)).rows[0];
  assert.equal(Number(canonical.rating), 6.5);
  assert.equal(canonical.goals, 1);
  assert.equal(canonical.parent_id, result.revisionId);
  assert.equal(canonical.provider, "apifootball");
  assert.equal((await pool.query(`SELECT s.retrieved_at>m.retrieved_at AS newer FROM sports.source_revisions s,sports.source_revisions m
    WHERE s.archive_ref=$1 AND m.id=$2`, [archive.id, result.sourceRevisionId])).rows[0].newer, true);
  assert.equal((await pool.query("SELECT * FROM sports.source_revisions WHERE id=$1 AND archive_ref=$2", [result.sourceRevisionId, `manual:${result.requestId}`])).rowCount, 1);
  assert.equal((await pool.query("SELECT * FROM sports.audit_log WHERE id=$1", [result.requestId])).rowCount, 1);
});

test("historical manual lineage blocks an older cross-endpoint replay after newer provider data becomes current", async () => {
  const manual = await service.correctAppearance(actor, correction());
  const newerBatch = observedBatch();
  const newer = observation(newerBatch, await manualObservationTime(manual.sourceRevisionId, 1));
  const store = new IngestionStore(pool);
  await store.import(newer, newerBatch);
  const current = await fixtureState();
  assert.notEqual(current.appearances[0].normalized_revision_id, manual.revisionId);
  const olderBatch = observedBatch([observedFixture({ homeScore: 9, appearances: [] })]);
  const older = observation(olderBatch, await manualObservationTime(manual.sourceRevisionId, -1), "get_statistics");
  assert.notEqual(newer.action, older.action);
  assert.notEqual(newer.resourceKey, older.resourceKey);
  await store.import(older, olderBatch);
  assert.deepEqual(await fixtureState(), current);
  assert.deepEqual((await pool.query("SELECT issues_json FROM sports.ingestion_batches WHERE archive_id=$1", [older.id])).rows[0].issues_json,
    [{ code: "superseded_by_manual_correction", resource: "900001" }]);
  assert.equal((await pool.query("SELECT * FROM sports.normalized_revisions WHERE id=$1 AND source_revision_id=$2", [manual.revisionId, manual.sourceRevisionId])).rowCount, 1);
  assert.equal((await pool.query("SELECT * FROM sports.audit_log WHERE id=$1", [manual.requestId])).rowCount, 1);
});

test("failed-job retry preserves its original outcome and cannot reset a running or malformed job", async () => {
  const requested = await service.requestImport(actor, randomUUID());
  const queue = new JobQueue(pool, "retry-admin-test", true);
  await queue.dispatch();
  const job = (await pool.query("SELECT id FROM sports.jobs WHERE outbox_id=$1", [requested.eventId])).rows[0].id;
  await pool.query("UPDATE sports.jobs SET status='failed',attempts=max_attempts,completed_at=clock_timestamp(),last_error='processing_failed' WHERE id=$1", [job]);
  const requestId = randomUUID();
  const first = await service.retry(actor, job, requestId);
  assert.deepEqual((await pool.query("SELECT status,attempts,last_error,completed_at FROM sports.jobs WHERE id=$1", [job])).rows[0],
    { status: "ready", attempts: 0, last_error: null, completed_at: null });
  await queue.runOnce(async () => {});
  assert.deepEqual(await service.retry(actor, job, requestId), first);
  assert.equal((await pool.query("SELECT status FROM sports.jobs WHERE id=$1", [job])).rows[0].status, "succeeded");
  await assert.rejects(service.retry(actor, job, randomUUID()), rejected(409, "job_not_failed"));
  await assert.rejects(service.retry(actor, randomUUID(), randomUUID()), rejected(404, "job_not_found"));
  await bootstrap.query("UPDATE sports.jobs SET status='failed',completed_at=clock_timestamp(),payload=$1 WHERE id=$2", [{ apiKey: "unexposed-value" }, job]);
  await assert.rejects(service.retry(actor, job, randomUUID()), rejected(409, "invalid_job"));
});

test("source requests share provider-budget deferral while the separate forecast lane progresses without feedback", async () => {
  const queue = new JobQueue(pool, "admin-lanes-test", true);
  await service.requestImport(actor, randomUUID());
  await service.requestRefresh(actor, randomUUID());
  assert.equal(await queue.dispatch(), 2);
  assert.equal(await queue.runForecastOnce(async (job) => assert.equal(job.kind, "forecast.refresh")), true);
  assert.equal(await queue.runForecastOnce(async () => assert.fail("provider work reached local forecast lane")), false);
  await queue.runOnce(async (job) => { assert.equal(job.kind, "source.sync"); throw new RateLimitError(new Date(Date.now() + 60_000)); });
  assert.deepEqual((await pool.query("SELECT status,attempts,last_error FROM sports.jobs WHERE kind='source.sync'")).rows[0],
    { status: "ready", attempts: 0, last_error: "request_budget_exhausted" });
  assert.equal(await queue.dispatch(), 0, "job completion cannot schedule its own forecast");
  await service.requestRefresh(actor, randomUUID());
  await queue.dispatch();
  assert.equal(await queue.runForecastOnce(async (job) => assert.equal(job.kind, "forecast.refresh")), true);
  assert.equal((await pool.query("SELECT * FROM sports.provider_requests")).rowCount, 0);
});

test("operational lists are bounded, filtered and sanitize arbitrary stored payloads and diagnostics", async () => {
  for (let index = 0; index < 3; index++) await service.requestImport(actor, randomUUID());
  const queue = new JobQueue(pool, "admin-lists-test", true);
  await queue.dispatch();
  await bootstrap.query("UPDATE sports.jobs SET payload=$1,last_error=$2", [{ apiKey: "unexposed-value" }, "unexposed-value"]);
  await pool.query(`INSERT INTO sports.audit_log(actor_type,action,entity_type,entity_key,detail)
    VALUES ('worker','normalize','fixture','900001',$1)`, [{ rawPayload: "unexposed-value", apiKey: "unexposed-value" }]);
  const jobs = await service.jobs({ status: "ready", kind: "source.sync", page: 2, pageSize: 2 });
  assert.equal(jobs.total, 3);
  assert.equal(jobs.items.length, 1);
  assert.equal(jobs.items[0].lastError, "processing_failed");
  assert.deepEqual(jobs.items[0].payload, {});
  assert.match(jobs.items[0].outboxId!, /^[0-9a-f-]{36}$/);
  assert.equal((await service.jobs({ status: "failed" })).total, 0);
  assert.equal((await service.jobs({ page: 10_000, pageSize: 100 })).items.length, 0);
  const audits = await service.audit({ pageSize: 100 });
  assert.equal(audits.total, 4);
  assert.equal(audits.items.filter((item) => item.actorId === actor).length, 3);
  assert.equal(JSON.stringify([jobs, audits]).includes("unexposed-value"), false);
  await pool.query(`INSERT INTO sports.provider_requests(action,resource_key)
    SELECT 'get_events','administration:budget' FROM generate_series(1,120)`);
  const status = await service.status();
  assert.equal(status.providerBudget.used, 120);
  assert.equal(status.providerBudget.remaining, 0);
  assert(status.providerBudget.retryAt);
  assert.deepEqual(status.coverage[0], { leagueId: "153", season: "2026/27", fixtures: 1, finalFixtures: 1, incompleteStatistics: 0 });
});

test("committed imports bound issue previews and disclose only approved codes, resource identities and counts", async () => {
  const issues = [
    { code: "missing_metric", resource: "fixture:900001/player:8001", field: "player_rating", rawPayload: "unexposed-value" },
    { code: "unexposed-value", resource: "https://example.test/?APIkey=unexposed-value" },
    { code: "invalid_number", resource: { apiKey: "unexposed-value" } },
    null, "unexposed-value",
    ...Array.from({ length: 51 }, () => ({ code: "missing_statistics", resource: "900001" })),
  ];
  await pool.query(`INSERT INTO sports.ingestion_batches(archive_id,source_revision_id,fixture_count,appearance_count,issues_json,committed_at)
    VALUES ($1,$2,3,22,$3,'2026-08-03T00:00:00Z')`, ["a".repeat(64), originalSource, JSON.stringify(issues)]);
  const hostileSource = (await pool.query(`INSERT INTO sports.source_revisions(action,resource_key,archive_ref,content_sha256,retrieved_at)
    VALUES ('unexposed-value','unexposed-value','unexposed-value',$1,'2026-08-04T00:00:00Z') RETURNING id`, ["c".repeat(64)])).rows[0].id;
  await pool.query(`INSERT INTO sports.ingestion_batches(archive_id,source_revision_id,fixture_count,appearance_count,issues_json,committed_at)
    VALUES ($1,$2,0,0,'[]','2026-08-05T00:00:00Z')`, ["b".repeat(64), hostileSource]);
  const latest = await service.imports({ page: 1, pageSize: 1 });
  assert.equal(latest.total, 2);
  assert.equal(latest.items.length, 1);
  assert.equal(latest.items[0].id, hostileSource);
  assert.equal(latest.items[0].action, "unknown");
  assert.equal(latest.items[0].issueTotal, 0);
  assert.equal(latest.items[0].issuesTruncated, false);
  const imported = (await service.imports({ page: 2, pageSize: 1 })).items[0];
  assert.equal(imported.id, originalSource);
  assert.equal(imported.action, "get_events");
  assert.deepEqual(imported.counts, { fixtures: 3, appearances: 22 });
  assert.equal(imported.retrievedAt, "2026-08-02T12:00:00.000Z");
  assert.equal(imported.committedAt, "2026-08-03T00:00:00.000Z");
  assert.equal(imported.issueTotal, 56);
  assert.equal(imported.issues.length, 50);
  assert.equal(imported.issuesTruncated, true);
  assert.deepEqual(imported.issues.slice(0, 5), [
    { code: "missing_metric", resource: "fixture:900001/player:8001" },
    { code: "validation_issue", resource: "unavailable" },
    { code: "invalid_number", resource: "unavailable" },
    { code: "validation_issue", resource: "unavailable" },
    { code: "validation_issue", resource: "unavailable" },
  ]);
  assert(!JSON.stringify([latest, imported]).includes("unexposed-value"));
  assert(!JSON.stringify(imported).includes("rawPayload"));
  assert(!JSON.stringify(imported).includes("archive"));
  assert.deepEqual((await service.imports({ page: 10_000, pageSize: 100 })).items, []);
  await assert.rejects(reader.query("SELECT * FROM sports.ingestion_batches"), { code: "42501" });
});

test("strict identifiers, command fields and pagination reject malformed or expanded requests before SQL changes", async () => {
  const before = await state();
  for (const id of ["0", "01", "-1", "9007199254740992", "1 OR 1=1", "1;DELETE FROM sports.players"]) {
    await assert.rejects(service.correctAppearance(actor, correction({ playerId: id })), rejected(400));
  }
  await assert.rejects(service.requestImport(actor, "00000000-0000-0000-0000-000000000000"), rejected(400));
  await assert.rejects(service.requestImport("forged role/admin", randomUUID()), rejected(400));
  await assert.rejects(service.requestStatistics(actor, { leagueId: "152", fixtureId: "900001", requestId: randomUUID() }), rejected(400));
  await assert.rejects(service.correctAppearance(actor, { ...correction(), role: "admin" } as AppearanceCorrection), rejected(400));
  for (const options of [{ page: 0 }, { page: 10_001 }, { pageSize: 0 }, { pageSize: 101 }, { page: 1.1 }, { pageSize: Number.NaN }]) {
    await assert.rejects(service.jobs(options), rejected(400));
    await assert.rejects(service.audit(options), rejected(400));
    await assert.rejects(service.imports(options), rejected(400));
  }
  await assert.rejects(service.jobs({ status: "ready' OR true --" }), rejected(400));
  await assert.rejects(service.jobs({ kind: "unknown.consumer" }), rejected(400));
  assert.deepEqual(await state(), before);
});

test("reader credentials cannot execute administration and writer access preserves append-only audit/source boundaries", async () => {
  const before = await state();
  const restricted = new AdminService(reader);
  await assert.rejects(restricted.requestImport(actor, randomUUID()), rejected(503, "admin_unavailable"));
  await assert.rejects(restricted.correctAppearance(actor, correction()), rejected(503, "admin_unavailable"));
  await assert.rejects(restricted.imports(), rejected(503, "admin_unavailable"));
  await assert.rejects(reader.query("UPDATE sports.appearances SET goals=0"), { code: "42501" });
  await assert.rejects(reader.query("INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key) VALUES ('source.sync','request',$1,$2)", [randomUUID(), randomUUID()]), { code: "42501" });
  await assert.rejects(pool.query("UPDATE sports.source_revisions SET provider='manual'"), { code: "42501" });
  await assert.rejects(pool.query("UPDATE sports.audit_log SET actor_id='forged'"), { code: "42501" });
  await assert.rejects(pool.query('SELECT role FROM auth."user"'), { code: "42501" });
  assert.deepEqual(await state(), before);
});
