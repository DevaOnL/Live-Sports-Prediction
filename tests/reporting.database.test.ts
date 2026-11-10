import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { ForecastStore } from "../src/server/forecast/store";
import { JobQueue } from "../src/server/ingestion/jobs";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId)) {
  throw new Error("Reporting tests require NODE_ENV=test, a dedicated _test database and POSTGRES_TEST_CLUSTER_ID from a disposable PostgreSQL 17 cluster.");
}
const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cutoff = "2026-08-06T12:00:00.000Z";
const connection = {
  host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"), database,
  connectionTimeoutMillis: 5_000, statement_timeout: 30_000,
};
let admin: pg.Client;
let reader: pg.Client;
let pool: pg.Pool;
let season: string;
let home: string;
let away: string;
let player: string;
let otherPlayer: string;
let membership: string;
let source: string;

before(async () => {
  admin = new pg.Client({ ...connection, user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD });
  await admin.connect();
  const server = (await admin.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(server.name, database);
  assert.equal(server.identifier, clusterId, "refusing an unconfirmed PostgreSQL cluster");
  assert.equal(Math.trunc(Number(server.version) / 10_000), 17);
  assert.equal((await admin.query(`SELECT datname FROM pg_database
    WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())`)).rowCount, 0,
  "reporting tests require a disposable PostgreSQL cluster without other databases");
  for (const command of ["provision", "migrate"]) {
    const result = await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), command], {
      cwd: root, timeout: 60_000, maxBuffer: 512_000,
    });
    assert.equal(result.stderr, "");
  }
  pool = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD, max: 6 });
  reader = new pg.Client({ ...connection, user: "lsp_reader", password: process.env.POSTGRES_READER_PASSWORD });
  await reader.connect();
});
after(async () => { await Promise.allSettled([pool?.end(), reader?.end(), admin?.end()]); });

beforeEach(async () => {
  const tables = (await admin.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  await admin.query(`TRUNCATE ${tables.map((row) => `sports.${row.tablename}`).join(",")} RESTART IDENTITY CASCADE`);
  const competition = (await pool.query(`INSERT INTO sports.competitions(provider_id,name,country_name,timezone,coefficient,enabled)
    VALUES ('153','Reporting test league','England','Europe/London',1.5,true) RETURNING id`)).rows[0].id;
  season = (await pool.query(`INSERT INTO sports.competition_seasons(competition_id,label,starts_on,ends_on,expected_clubs,enabled)
    VALUES ($1,'2026/27','2026-07-01','2027-06-30',24,true) RETURNING id`, [competition])).rows[0].id;
  [home, away] = (await pool.query(`INSERT INTO sports.clubs(provider_id,name)
    VALUES ('7001','Reporting home'),('7002','Reporting away') RETURNING id`)).rows.map((row) => row.id);
  await pool.query("INSERT INTO sports.season_clubs(season_id,club_id) VALUES ($1,$2),($1,$3)", [season, home, away]);
  [player, otherPlayer] = (await pool.query(`INSERT INTO sports.players(provider_id,name,position)
    VALUES ('8001','Reporting forward','FWD'),('8002','Other reporting player','GK') RETURNING id`)).rows.map((row) => row.id);
  membership = (await pool.query(`INSERT INTO sports.player_memberships(player_id,club_id,season_id,valid_from)
    VALUES ($1,$2,$3,'2026-07-01T00:00:00Z') RETURNING id`, [player, home, season])).rows[0].id;
  source = (await pool.query(`INSERT INTO sports.source_revisions(action,resource_key,archive_ref,content_sha256,retrieved_at)
    VALUES ('get_events','reporting:test','reporting:test',$1,'2026-08-06T11:00:00Z') RETURNING id`, ["a".repeat(64)])).rows[0].id;
});

async function addAppearance(fixtureId: string, at: string, options: {
  minutes?: number | null; participation?: string; status?: string; rating?: number | null; tackles?: number | null;
} = {}) {
  const revision = (await pool.query(`INSERT INTO sports.normalized_revisions(source_revision_id,entity_type,entity_key,content_sha256)
    VALUES ($1,'appearance',$2,$3) RETURNING id`, [source, `${fixtureId}:8001`, "b".repeat(64)])).rows[0].id;
  const fixture = (await pool.query(`INSERT INTO sports.fixtures(provider_id,season_id,home_club_id,away_club_id,kickoff_at,status,
    statistics_status,home_score,away_score,normalized_revision_id)
    VALUES ($1,$2,$3,$4,$5,$6,'partial',1,0,$7) RETURNING id`,
  [fixtureId, season, home, away, at, options.status ?? "final", revision])).rows[0].id;
  await pool.query(`INSERT INTO sports.appearances(fixture_id,player_id,season_id,club_id,membership_id,participation,
    minutes,rating,goals,assists,shots_on_target,key_passes,tackles,interceptions,saves,goals_conceded,normalized_revision_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,0,0,$9,0,0,0,$10)`,
  [fixture, player, season, home, membership, options.participation ?? "played",
    options.minutes === undefined ? 60 : options.minutes, options.rating === undefined ? 7 : options.rating,
    options.tackles === undefined ? 0 : options.tackles, revision]);
  return revision as string;
}

async function historySeed() {
  await addAppearance("900001", "2026-08-01T12:00:00Z");
  const missing = await addAppearance("900002", "2026-08-02T12:00:00Z", { rating: null, tackles: null });
  await addAppearance("900003", "2026-08-03T12:00:00Z", { minutes: 97 });
  await addAppearance("900004", "2026-08-04T12:00:00Z");
  await addAppearance("10", "2026-08-05T12:00:00Z");
  await addAppearance("9", "2026-08-05T12:00:00Z");
  await addAppearance("900007", cutoff);
  await addAppearance("900008", "2026-08-05T13:00:00Z", { minutes: 59 });
  await addAppearance("900009", "2026-08-05T14:00:00Z", { participation: "dnp", minutes: 0, rating: null });
  await addAppearance("900010", "2026-08-05T15:00:00Z", { participation: "unknown", minutes: null });
  await addAppearance("900011", "2026-08-05T16:00:00Z", { status: "live", minutes: 90 });
  return missing;
}

async function revision(parentId: string | null = null, targetPlayer = player) {
  const hash = createHash("sha256").update(randomUUID()).digest("hex");
  return (await pool.query(`INSERT INTO sports.forecast_revisions(player_id,parent_id,model_version,input_hash,source_ordinal,
    cutoff_at,input_json,provenance_json,result_json)
    VALUES ($1,$2,'reporting-test-v1',$3,0,$4,'{}','{}','{"status":"unavailable"}') RETURNING id,ordinal`,
  [targetPlayer, parentId, hash, cutoff])).rows[0] as { id: string; ordinal: string };
}

async function setHead(revisionId: string, targetPlayer = player) {
  await pool.query(`INSERT INTO sports.forecast_heads(player_id,revision_id,evaluation_cutoff_at,evaluation_source_ordinal,evaluation_provenance_json,checked_at)
    VALUES ($1,$2,$3,0,'{}',clock_timestamp()) ON CONFLICT(player_id) DO UPDATE SET revision_id=EXCLUDED.revision_id`,
  [targetPlayer, revisionId, cutoff]);
}

async function cli(args: string[]) {
  return execute(process.execPath, ["--import", "tsx", join(root, "scripts/forecast.ts"), ...args], {
    cwd: root, timeout: 60_000, maxBuffer: 512_000,
    env: { ...process.env, LSP_TEST_SOURCE: "legacy", APIFOOTBALL_API_KEY: "", MONGO_WORKER_PASSWORD: "", MONGO_BOOTSTRAP_PASSWORD: "" },
  });
}

test("qualifying history uses an exact stable window, strict cutoff and nullable metrics without claiming completeness", async () => {
  const missing = await historySeed();
  const rows = (await reader.query("SELECT * FROM sports.player_qualifying_history($1,$2)", ["8001", cutoff])).rows;
  assert.deepEqual(rows.map((row) => row.fixture_id), ["900002", "900003", "900004", "10", "9"]);
  assert.equal(rows[0].rating, null);
  assert.equal(rows[0].tackles, null);
  assert.equal(rows[0].goals, 0);
  assert.equal(rows[0].normalized_revision_id, missing);
  assert.equal(rows[1].minutes, 97);
  assert(rows.every((row) => row.league_id === "153" && row.club_id === "7001"));
  assert.deepEqual((await reader.query("SELECT * FROM sports.player_qualifying_history('999999',$1)", [cutoff])).rows, []);
  for (const badCutoff of [null, "infinity", "-infinity"]) {
    await assert.rejects(reader.query("SELECT * FROM sports.player_qualifying_history('8001',$1)", [badCutoff]), { code: "22023" });
  }
  const result = await cli(["history", "8001", cutoff]);
  const report = JSON.parse(result.stdout);
  assert.equal(report.completeHistoryVerified, false);
  assert.equal(report.scope, "eligible-candidates");
  assert.deepEqual(report.appearances.map((row: { fixture_id: string }) => row.fixture_id), rows.map((row) => row.fixture_id));
  assert.equal(result.stderr, "");
});

test("qualifying history requires all enabled approved coverage guards and accepts the other approved league", async () => {
  await historySeed();
  const changes = [
    "UPDATE sports.competitions SET enabled=false",
    "UPDATE sports.competition_seasons SET enabled=false",
    "UPDATE sports.competitions SET provider_id='152'",
    "UPDATE sports.competition_seasons SET label='2025/26'",
    "UPDATE sports.competition_seasons SET starts_on=DATE '2026-07-02'",
    "UPDATE sports.competition_seasons SET ends_on=DATE '2027-06-29'",
    "UPDATE sports.competition_seasons SET expected_clubs=23",
    "UPDATE sports.competitions SET coefficient=2",
    "UPDATE sports.competitions SET timezone='Europe/Paris'",
  ];
  const client = await pool.connect();
  try {
    for (const change of changes) {
      await client.query("BEGIN");
      try {
        await client.query(change);
        assert.deepEqual((await client.query("SELECT * FROM sports.player_qualifying_history('8001',$1)", [cutoff])).rows, [], change);
      } finally { await client.query("ROLLBACK"); }
    }
    await client.query("BEGIN");
    try {
      await client.query("UPDATE sports.competitions SET provider_id='164',timezone='Europe/Paris'");
      await client.query("UPDATE sports.competition_seasons SET expected_clubs=18");
      assert.equal((await client.query("SELECT * FROM sports.player_qualifying_history('8001',$1)", [cutoff])).rowCount, 5);
    } finally { await client.query("ROLLBACK"); }
  } finally { client.release(); }
});

test("recursive lineage follows only current-head ancestry and enforces its row limit", async () => {
  const first = await revision();
  const second = await revision(first.id);
  const third = await revision(second.id);
  await revision(first.id); // An unselected branch must not appear in the current lineage.
  await setHead(third.id);
  const other = await revision(null, otherPlayer);
  await setHead(other.id, otherPlayer);
  const rows = (await reader.query("SELECT * FROM sports.forecast_lineage('8001')")).rows;
  assert.deepEqual(rows.map((row) => row.revision_id), [third.id, second.id, first.id]);
  assert.deepEqual(rows.map((row) => row.depth), [0, 1, 2]);
  assert(rows.every((row) => row.status === "unavailable" && row.model_version === "reporting-test-v1"));
  assert.deepEqual((await reader.query("SELECT revision_id FROM sports.forecast_lineage('8001',1)")).rows, [{ revision_id: third.id }]);
  assert.equal((await reader.query("SELECT * FROM sports.forecast_lineage('8001',2)")).rowCount, 2);
  assert.equal((await reader.query("SELECT * FROM sports.forecast_lineage('8001',1000)")).rowCount, 3);
  assert.deepEqual((await reader.query("SELECT * FROM sports.forecast_lineage('999999')")).rows, []);
  for (const invalid of [null, 0, -1, 1001]) {
    await assert.rejects(reader.query("SELECT * FROM sports.forecast_lineage('8001',$1)", [invalid]), { code: "22023" });
  }
  assert.deepEqual(JSON.parse((await cli(["lineage", "8001"])).stdout).map((row: { revision_id: string }) => row.revision_id),
    rows.map((row) => row.revision_id));
});

test("refresh requests are concurrent-idempotent, transactional, credential-independent local work", async () => {
  const requestId = randomUUID();
  await Promise.all(Array.from({ length: 4 }, () => pool.query("CALL sports.request_forecast_refresh($1)", [requestId])));
  const events = (await pool.query("SELECT * FROM sports.outbox WHERE event_type='forecast.requested'")).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].deduplication_key, `forecast.manual:${requestId}`);
  assert.deepEqual(events[0].payload, {});
  const audit = (await pool.query("SELECT actor_id,detail FROM sports.audit_log WHERE action='forecast.request'")).rows;
  assert.deepEqual(audit, [{ actor_id: "lsp_writer", detail: { requestId, scope: "all" } }]);
  const rolledBackId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CALL sports.request_forecast_refresh($1)", [rolledBackId]);
    await client.query("ROLLBACK");
  } finally { client.release(); }
  assert.equal((await pool.query("SELECT * FROM sports.outbox WHERE deduplication_key=$1", [`forecast.manual:${rolledBackId}`])).rowCount, 0);
  assert.equal((await pool.query("SELECT * FROM sports.audit_log WHERE entity_key=$1", [rolledBackId])).rowCount, 0);
  assert.deepEqual(JSON.parse((await cli(["request", requestId])).stdout), { requestId, scope: "all" });
  assert.equal((await pool.query("SELECT * FROM sports.outbox WHERE event_type='forecast.requested'")).rowCount, 1);
  await pool.query("CALL sports.request_forecast_refresh()");
  assert.equal((await pool.query("SELECT * FROM sports.outbox WHERE event_type='forecast.requested'")).rowCount, 2);
  await assert.rejects(pool.query("CALL sports.request_forecast_refresh(NULL)"), { code: "22023" });
  await pool.query("UPDATE sports.competition_seasons SET enabled=false");
  await assert.rejects(pool.query("CALL sports.request_forecast_refresh()"), { code: "22023" });
});

test("forecast-head changes audit every effective transition, skip no-ops and roll back their effects", async () => {
  const first = await revision();
  const second = await revision(first.id);
  await setHead(first.id);
  await setHead(first.id);
  await pool.query("UPDATE sports.forecast_heads SET checked_at=clock_timestamp(),evaluation_cutoff_at=$1", [cutoff]);
  assert.equal((await pool.query("SELECT * FROM sports.outbox WHERE event_type='forecast.updated'")).rowCount, 1);
  await setHead(second.id);
  await setHead(first.id);
  const events = (await pool.query("SELECT * FROM sports.outbox WHERE event_type='forecast.updated' ORDER BY created_at,id")).rows;
  assert.equal(events.length, 3, "returning to an existing revision is another effective pointer transition");
  assert.equal(new Set(events.map((row) => row.deduplication_key)).size, 3);
  const audits = (await pool.query("SELECT actor_id,entity_key,detail FROM sports.audit_log WHERE action='forecast.refresh' ORDER BY occurred_at,id")).rows;
  assert.equal(audits.length, 3);
  assert(audits.every((row) => row.actor_id === "lsp_writer" && row.entity_key === "8001"));
  assert.deepEqual(audits[0].detail, { forecastRevisionId: first.id, parentId: null, inputHash: events[0].payload.inputHash, sourceOrdinal: "0" });
  assert(events.every((row) => row.aggregate_id === player && row.payload.playerId === "8001" && row.payload.modelVersion === "reporting-test-v1"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE sports.forecast_heads SET revision_id=$1", [second.id]);
    await client.query("ROLLBACK");
  } finally { client.release(); }
  assert.equal((await pool.query("SELECT revision_id FROM sports.forecast_heads")).rows[0].revision_id, first.id);
  assert.equal((await pool.query("SELECT * FROM sports.outbox WHERE event_type='forecast.updated'")).rowCount, 3);
  assert.equal((await pool.query("SELECT * FROM sports.audit_log WHERE action='forecast.refresh'")).rowCount, 3);
  await assert.rejects(pool.query("UPDATE sports.forecast_heads SET revision_id=$1", [randomUUID()]), { code: "23503" });
  assert.equal((await pool.query("SELECT * FROM sports.outbox WHERE event_type='forecast.updated'")).rowCount, 3);
  assert.equal((await pool.query("SELECT * FROM sports.outbox WHERE event_type='canonical.changed'")).rowCount, 0);
});

test("the real forecast consumer emits one audit per revision and never consumes its own update events", async () => {
  const queue = new JobQueue(pool, "reporting-refresh", true);
  const forecasts = new ForecastStore(pool);
  await pool.query("CALL sports.request_forecast_refresh()");
  assert.equal(await queue.dispatch(), 1);
  assert.equal(await queue.runForecastOnce(async () => { await forecasts.refreshAll(cutoff); }), true);
  assert.equal((await pool.query("SELECT * FROM sports.forecast_revisions")).rowCount, 2);
  assert.equal((await pool.query("SELECT * FROM sports.audit_log WHERE action='forecast.refresh'")).rowCount, 2);
  assert.equal((await pool.query("SELECT * FROM sports.outbox WHERE event_type='forecast.updated' AND published_at IS NULL")).rowCount, 2);
  assert.equal(await queue.dispatch(), 0);
  assert.equal(await queue.runForecastOnce(async () => assert.fail("update events must not enqueue another refresh")), false);
  assert.equal((await forecasts.refreshAll(cutoff)).unchanged, 2);
  assert.equal((await pool.query("SELECT * FROM sports.audit_log WHERE action='forecast.refresh'")).rowCount, 2);
  assert.equal((await pool.query("SELECT * FROM sports.outbox WHERE event_type='forecast.updated'")).rowCount, 2);
});

test("reporting routines use invoker privileges and fixed paths with explicit role boundaries", async () => {
  const definitions = (await admin.query(`SELECT p.proname,oidvectortypes(p.proargtypes) AS arguments,p.prokind,p.prosecdef,p.proconfig,
    NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS no_public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='sports' AND p.proname IN ('player_qualifying_history','forecast_lineage','request_forecast_refresh','record_forecast_update')
    ORDER BY p.proname,p.pronargs`)).rows;
  assert.deepEqual(definitions.map((row) => [row.proname, row.arguments, row.prokind]), [
    ["forecast_lineage", "text, integer", "f"],
    ["forecast_lineage", "text, text, integer", "f"],
    ["player_qualifying_history", "text, timestamp with time zone", "f"],
    ["player_qualifying_history", "text, text, timestamp with time zone", "f"],
    ["record_forecast_update", "", "f"],
    ["request_forecast_refresh", "uuid", "p"],
    ["request_forecast_refresh", "text, uuid", "p"],
  ]);
  assert(definitions.every((row) => !row.prosecdef && row.no_public_execute && row.proconfig.includes("search_path=pg_catalog, sports")));
  await assert.rejects(reader.query("CALL sports.request_forecast_refresh()"), { code: "42501" });
  await assert.rejects(reader.query("CALL sports.request_forecast_refresh('sorare',$1::uuid)", [randomUUID()]), { code: "42501" });
  await assert.rejects(reader.query("INSERT INTO sports.outbox(event_type) VALUES ('forecast.requested')"), { code: "42501" });
  const grants = (await admin.query(`SELECT
    has_function_privilege('lsp_reader','sports.player_qualifying_history(text,timestamptz)','EXECUTE') AS reader_history,
    has_function_privilege('lsp_writer','sports.forecast_lineage(text,integer)','EXECUTE') AS writer_lineage,
    has_function_privilege('lsp_auth','sports.forecast_lineage(text,integer)','EXECUTE') AS auth_lineage,
    has_function_privilege('lsp_writer','sports.record_forecast_update()','EXECUTE') AS writer_helper`)).rows[0];
  assert.deepEqual(grants, { reader_history: true, writer_lineage: true, auth_lineage: false, writer_helper: false });
  for (const signature of ["sports.player_qualifying_history(text,text,timestamptz)", "sports.forecast_lineage(text,text,integer)"]) {
    const sourceGrants = (await admin.query(`SELECT has_function_privilege('lsp_reader',$1,'EXECUTE') AS reader,
      has_function_privilege('lsp_writer',$1,'EXECUTE') AS writer,has_function_privilege('lsp_auth',$1,'EXECUTE') AS auth`, [signature])).rows[0];
    assert.deepEqual(sourceGrants, { reader: true, writer: true, auth: false }, signature);
  }
  const requestGrants = (await admin.query(`SELECT
    has_function_privilege('lsp_reader','sports.request_forecast_refresh(text,uuid)','EXECUTE') AS reader,
    has_function_privilege('lsp_writer','sports.request_forecast_refresh(text,uuid)','EXECUTE') AS writer,
    has_function_privilege('lsp_auth','sports.request_forecast_refresh(text,uuid)','EXECUTE') AS auth`)).rows[0];
  assert.deepEqual(requestGrants, { reader: false, writer: true, auth: false });
});
