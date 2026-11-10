import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { CURRENT_SOURCE, LEGACY_SOURCE, sourceSeasonGuard } from "../src/server/ingestion/sources";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId)) {
  throw new Error("Source reporting requires a guarded disposable PostgreSQL 17 _test database and exact POSTGRES_TEST_CLUSTER_ID.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const connection = { host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"), database,
  connectionTimeoutMillis: 5_000, statement_timeout: 30_000 };
const cutoff = "2026-08-08T00:00:00.000Z";
let administrator: pg.Client;
let reader: pg.Client;
let writer: pg.Pool;

async function cli(args: string[], requestedDatabase = database) {
  const result = await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), ...args], {
    cwd: root, env: { ...process.env, POSTGRES_DB: requestedDatabase }, timeout: 90_000, maxBuffer: 512_000,
  });
  assert.equal(result.stderr, "");
}

before(async () => {
  administrator = new pg.Client({ ...connection, user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD });
  await administrator.connect();
  const identity = (await administrator.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(identity.name, database);
  assert.equal(identity.identifier, clusterId, "refusing an unconfirmed PostgreSQL cluster");
  assert.equal(Math.trunc(Number(identity.version) / 10_000), 17);
  assert.equal((await administrator.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())")).rowCount, 0);
  await cli(["provision"]);
  await cli(["migrate"]);
  writer = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD, max: 6 });
  reader = new pg.Client({ ...connection, user: "lsp_reader", password: process.env.POSTGRES_READER_PASSWORD });
  await reader.connect();
});
after(async () => { await Promise.allSettled([writer?.end(), reader?.end(), administrator?.end()]); });
beforeEach(async () => {
  const tables = (await administrator.query("SELECT tablename FROM pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.length && tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  await administrator.query(`TRUNCATE ${tables.map((row) => `sports.${row.tablename}`).join(",")} RESTART IDENTITY CASCADE`);
});

type Connection = Pick<pg.Pool, "query">;
async function seed(client: Connection, provider = "sorare", playerProviderId = `Player:${randomUUID()}`, includeSlugs = true) {
  const current = provider === "sorare";
  const competition = (await client.query(`INSERT INTO sports.competitions(provider,provider_id,name,country_name,timezone,coefficient,enabled)
    VALUES ($1,$2,'Synthetic source league','England','Europe/London',$3,true) RETURNING id`,
  [provider, current ? "premier-league-gb-eng" : "153", current ? 2 : 1.5])).rows[0].id as string;
  const season = (await client.query(`INSERT INTO sports.competition_seasons(competition_id,label,starts_on,ends_on,expected_clubs,enabled)
    VALUES ($1,'2026/27','2026-07-01','2027-06-30',$2,true) RETURNING id`, [competition, current ? 20 : 24])).rows[0].id as string;
  const clubIds = [current ? `Club:${randomUUID()}` : "7001", current ? `Club:${randomUUID()}` : "7002"];
  const clubs = (await client.query(`INSERT INTO sports.clubs(provider,provider_id,name${includeSlugs ? ",provider_slug" : ""})
    VALUES ($1,$2,'Synthetic home'${includeSlugs ? ",'synthetic-home'" : ""}),($1,$3,'Synthetic away'${includeSlugs ? ",'synthetic-away'" : ""}) RETURNING id`,
  [provider, ...clubIds])).rows.map((row) => row.id as string);
  await client.query("INSERT INTO sports.season_clubs(season_id,club_id) VALUES ($1,$2),($1,$3)", [season, ...clubs]);
  const player = (await client.query(`INSERT INTO sports.players(provider,provider_id,name,position${includeSlugs ? ",provider_slug" : ""})
    VALUES ($1,$2,'Synthetic source player','FWD'${includeSlugs ? ",'synthetic-player'" : ""}) RETURNING id`, [provider, playerProviderId])).rows[0].id as string;
  const membership = (await client.query(`INSERT INTO sports.player_memberships(player_id,club_id,season_id,valid_from)
    VALUES ($1,$2,$3,'2026-07-01T00:00:00Z') RETURNING id`, [player, clubs[0], season])).rows[0].id as string;
  const source = (await client.query(`INSERT INTO sports.source_revisions(provider,action,resource_key,archive_ref,content_sha256,retrieved_at)
    VALUES ($1,'fixture','synthetic-source',$2,$3,'2026-08-07T23:00:00Z') RETURNING id`, [provider, randomUUID(), "a".repeat(64)])).rows[0].id as string;
  const fixtureIds: string[] = [];
  for (let index = 1; index <= 7; index++) {
    const fixtureId = current ? `Game:${randomUUID()}` : `90000${index}`;
    fixtureIds.push(fixtureId);
    const revision = (await client.query(`INSERT INTO sports.normalized_revisions(source_revision_id,entity_type,entity_key,content_sha256)
      VALUES ($1,'appearance',$2,$3) RETURNING id`, [source, `${provider}:${fixtureId}:${playerProviderId}`, "b".repeat(64)])).rows[0].id;
    const fixture = (await client.query(`INSERT INTO sports.fixtures(provider,provider_id,season_id,home_club_id,away_club_id,kickoff_at,status,
      statistics_status,home_score,away_score,normalized_revision_id)
      VALUES ($1,$2,$3,$4,$5,$6,'final','partial',1,0,$7) RETURNING id`,
    [provider, fixtureId, season, ...clubs, `2026-08-0${index}T12:00:00Z`, revision])).rows[0].id;
    await client.query(`INSERT INTO sports.appearances(fixture_id,player_id,season_id,club_id,membership_id,participation,minutes,rating,
      goals,assists,shots_on_target,key_passes,tackles,interceptions,saves,goals_conceded,normalized_revision_id)
      VALUES ($1,$2,$3,$4,$5,'played',$6,NULL,0,0,1,NULL,NULL,0,NULL,NULL,$7)`,
    [fixture, player, season, clubs[0], membership, index === 7 ? 59 : index === 3 ? 97 : 60, revision]);
  }
  return { provider, competition, season, clubs, clubIds, player, playerProviderId, source, fixtureIds };
}

async function revision(client: Connection, player: string, parentId: string | null = null) {
  return (await client.query(`INSERT INTO sports.forecast_revisions(player_id,parent_id,model_version,input_hash,source_ordinal,
    cutoff_at,input_json,provenance_json,result_json)
    VALUES ($1,$2,'source-report-test',$3,0,$4,'{}','{}','{"status":"unavailable"}') RETURNING id`,
  [player, parentId, randomUUID().replaceAll("-", "").repeat(2), cutoff])).rows[0].id as string;
}

async function head(client: Connection, player: string, revisionId: string) {
  await client.query(`INSERT INTO sports.forecast_heads(player_id,revision_id,evaluation_cutoff_at,evaluation_source_ordinal,evaluation_provenance_json,checked_at)
    VALUES ($1,$2,$3,0,'{}',clock_timestamp()) ON CONFLICT(player_id) DO UPDATE SET revision_id=EXCLUDED.revision_id`, [player, revisionId, cutoff]);
}

test("source history preserves native IDs, exact windows, null counts and source separation", async () => {
  const current = await seed(writer);
  await seed(writer, "apifootball", current.playerProviderId);
  const rows = (await reader.query("SELECT * FROM sports.player_qualifying_history($1,$2,$3)", ["sorare", current.playerProviderId, cutoff])).rows;
  assert.deepEqual(rows.map((row) => row.fixture_id), current.fixtureIds.slice(1, 6));
  assert(rows.every((row) => row.league_id === "premier-league-gb-eng" && row.club_id === current.clubIds[0]));
  assert.equal(rows[1].minutes, 97);
  assert.equal(rows[0].goals, 0);
  assert.equal(rows[0].rating, null);
  assert.equal(rows[0].tackles, null);
  const metadata = (await reader.query("SELECT provider_slug FROM sports.players WHERE id=$1", [current.player])).rows[0];
  assert.equal(metadata.provider_slug, "synthetic-player");
  assert.deepEqual((await reader.query("SELECT * FROM sports.player_qualifying_history('sorare','Player:unknown',$1)", [cutoff])).rows, []);
  assert((await reader.query("SELECT * FROM sports.player_qualifying_history('apifootball',$1,$2)", [current.playerProviderId, cutoff])).rows.every((row) => row.league_id === "153"));
  for (const invalid of [null, "infinity", "-infinity"]) {
    await assert.rejects(reader.query("SELECT * FROM sports.player_qualifying_history('sorare',$1,$2)", [current.playerProviderId, invalid]), { code: "22023" });
  }
  await assert.rejects(reader.query("SELECT * FROM sports.player_qualifying_history('other',$1,$2)", [current.playerProviderId, cutoff]), { code: "22023" });
});

test("current SQL guards reject a matching ID with wrong provider, season, timezone or coefficient", async () => {
  const current = await seed(writer);
  const client = await writer.connect();
  try {
    for (const change of [
      "UPDATE sports.competitions SET enabled=false",
      "UPDATE sports.competition_seasons SET enabled=false",
      "UPDATE sports.competitions SET provider='other'",
      "UPDATE sports.competitions SET provider_id='153'",
      "UPDATE sports.competition_seasons SET label='2025/26'",
      "UPDATE sports.competition_seasons SET starts_on=DATE '2026-07-02'",
      "UPDATE sports.competition_seasons SET ends_on=DATE '2027-06-29'",
      "UPDATE sports.competition_seasons SET expected_clubs=19",
      "UPDATE sports.competitions SET coefficient=1.5",
      "UPDATE sports.competitions SET timezone='Europe/Paris'",
    ]) {
      await client.query("BEGIN");
      try {
        await client.query(change);
        assert.equal((await client.query("SELECT * FROM sports.player_qualifying_history('sorare',$1,$2)", [current.playerProviderId, cutoff])).rowCount, 0, change);
        assert.equal((await client.query(`SELECT 1 FROM sports.competition_seasons cs JOIN sports.competitions c ON c.id=cs.competition_id WHERE ${sourceSeasonGuard(CURRENT_SOURCE)}`)).rowCount, 0, change);
        await assert.rejects(client.query("CALL sports.request_forecast_refresh('sorare',$1)", [randomUUID()]), { code: "22023" });
      } finally { await client.query("ROLLBACK"); }
    }
    await client.query("BEGIN");
    try {
      await client.query("UPDATE sports.competitions SET provider_id='laliga-es',timezone='Europe/Madrid'");
      assert.equal((await client.query("SELECT * FROM sports.player_qualifying_history('sorare',$1,$2)", [current.playerProviderId, cutoff])).rowCount, 5);
      assert.equal((await client.query(`SELECT 1 FROM sports.competition_seasons cs JOIN sports.competitions c ON c.id=cs.competition_id WHERE ${sourceSeasonGuard(CURRENT_SOURCE)}`)).rowCount, 1);
      assert.equal((await client.query(`SELECT 1 FROM sports.competition_seasons cs JOIN sports.competitions c ON c.id=cs.competition_id WHERE ${sourceSeasonGuard(LEGACY_SOURCE)}`)).rowCount, 0);
    } finally { await client.query("ROLLBACK"); }
  } finally { client.release(); }
});

test("source lineage follows only its own immutable head ancestry and enforces bounds", async () => {
  const current = await seed(writer);
  const legacy = await seed(writer, "apifootball", current.playerProviderId);
  const first = await revision(writer, current.player);
  const second = await revision(writer, current.player, first);
  const third = await revision(writer, current.player, second);
  await revision(writer, current.player, first);
  await head(writer, current.player, third);
  const legacyRevision = await revision(writer, legacy.player);
  await head(writer, legacy.player, legacyRevision);
  const rows = (await reader.query("SELECT * FROM sports.forecast_lineage('sorare',$1,50)", [current.playerProviderId])).rows;
  assert.deepEqual(rows.map((row) => row.revision_id), [third, second, first]);
  assert.deepEqual(rows.map((row) => row.depth), [0, 1, 2]);
  assert.equal((await reader.query("SELECT * FROM sports.forecast_lineage('sorare',$1,1)", [current.playerProviderId])).rowCount, 1);
  assert.deepEqual((await reader.query("SELECT revision_id FROM sports.forecast_lineage('apifootball',$1,50)", [current.playerProviderId])).rows, [{ revision_id: legacyRevision }]);
  for (const limit of [null, 0, 1001]) await assert.rejects(reader.query("SELECT * FROM sports.forecast_lineage('sorare',$1,$2)", [current.playerProviderId, limit]), { code: "22023" });
  await assert.rejects(reader.query("SELECT * FROM sports.forecast_lineage('other',$1,50)", [current.playerProviderId]), { code: "22023" });
  await writer.query("UPDATE sports.competitions SET enabled=false");
  assert.equal((await reader.query("SELECT * FROM sports.forecast_lineage('sorare',$1,50)", [current.playerProviderId])).rowCount, 3, "retirement does not erase revision ancestry");
});

test("source refresh commands are provider-marked, concurrent-idempotent, atomic and writer-only", async () => {
  await seed(writer);
  const requestId = randomUUID();
  await Promise.all(Array.from({ length: 4 }, () => writer.query("CALL sports.request_forecast_refresh('sorare',$1)", [requestId])));
  const events = (await writer.query("SELECT * FROM sports.outbox WHERE event_type='forecast.requested'")).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].deduplication_key, `forecast-request:sorare:${requestId}`);
  assert.deepEqual(events[0].payload, { provider: "sorare" });
  const audits = (await writer.query("SELECT detail FROM sports.audit_log WHERE action='forecast.request'")).rows;
  assert.deepEqual(audits, [{ detail: { requestId, scope: "all", provider: "sorare" } }]);
  const rolledBack = randomUUID();
  const client = await writer.connect();
  try {
    await client.query("BEGIN");
    await client.query("CALL sports.request_forecast_refresh('sorare',$1)", [rolledBack]);
    await client.query("ROLLBACK");
  } finally { client.release(); }
  assert.equal((await writer.query("SELECT 1 FROM sports.outbox WHERE deduplication_key=$1", [`forecast-request:sorare:${rolledBack}`])).rowCount, 0);
  await assert.rejects(reader.query("CALL sports.request_forecast_refresh('sorare',$1)", [randomUUID()]), { code: "42501" });
  await assert.rejects(writer.query("CALL sports.request_forecast_refresh('sorare',NULL)"), { code: "22023" });
  await assert.rejects(writer.query("CALL sports.request_forecast_refresh('other',$1)", [randomUUID()]), { code: "22023" });
  assert.equal((await writer.query("SELECT count(*)::integer AS count FROM sports.provider_requests")).rows[0].count, 0);
  const publicExecute = (await administrator.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE n.nspname='sports' AND p.oid IN ('sports.player_qualifying_history(text,text,timestamptz)'::regprocedure,
      'sports.forecast_lineage(text,text,integer)'::regprocedure,'sports.request_forecast_refresh(text,uuid)'::regprocedure)
      AND a.grantee=0 AND a.privilege_type='EXECUTE'`)).rows;
  assert.deepEqual(publicExecute, []);
});

test("coverage upgrade disables former leagues without altering stored evidence or existing report definitions", { timeout: 120_000 }, async () => {
  const upgradeDatabase = `source_upgrade_${randomUUID().replaceAll("-", "").slice(0, 12)}_test`;
  const directory = await mkdtemp(join(tmpdir(), "source-upgrade-"));
  let upgrade: pg.Client | undefined;
  let created = false;
  try {
    const files = (await readdir(join(root, "db/migrations"))).filter((name) => /^00[1-9]_.*\.sql$/.test(name)).sort();
    assert.equal(files.length, 9);
    for (const file of files) await cp(join(root, "db/migrations", file), join(directory, file));
    await administrator.query(`CREATE DATABASE "${upgradeDatabase}"`);
    created = true;
    await cli(["provision"], upgradeDatabase);
    await cli(["migrate", "--dir", directory], upgradeDatabase);
    upgrade = new pg.Client({ ...connection, database: upgradeDatabase, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD });
    await upgrade.connect();
    const legacy = await seed(upgrade, "apifootball", "8001", false);
    await head(upgrade, legacy.player, await revision(upgrade, legacy.player));
    const immutable = async () => {
      const result: Record<string, unknown> = {};
      for (const table of ["source_revisions", "normalized_revisions", "fixtures", "appearances", "player_memberships", "forecast_revisions", "forecast_heads"]) {
        result[table] = (await upgrade!.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS rows FROM sports.${table} t`)).rows[0].rows;
      }
      return result;
    };
    const oldFunctions = async () => (await upgrade!.query(`SELECT p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p WHERE p.oid IN ('sports.player_qualifying_history(text,timestamptz)'::regprocedure,
        'sports.forecast_lineage(text,integer)'::regprocedure,'sports.request_forecast_refresh(uuid)'::regprocedure)
      ORDER BY signature`)).rows;
    const evidence = await immutable();
    const definitions = await oldFunctions();
    await cli(["migrate"], upgradeDatabase);
    assert.deepEqual(await immutable(), evidence);
    assert.deepEqual(await oldFunctions(), definitions);
    assert.equal((await upgrade.query("SELECT enabled FROM sports.competitions WHERE id=$1", [legacy.competition])).rows[0].enabled, false);
    assert.equal((await upgrade.query("SELECT enabled FROM sports.competition_seasons WHERE id=$1", [legacy.season])).rows[0].enabled, false);
    assert.equal((await upgrade.query("SELECT provider_slug FROM sports.players WHERE id=$1", [legacy.player])).rows[0].provider_slug, null);
    assert.equal((await upgrade.query("SELECT count(*)::integer AS count FROM sports.forecast_lineage('8001')")).rows[0].count, 1);
  } finally {
    await upgrade?.end();
    if (created) await administrator.query(`DROP DATABASE "${upgradeDatabase}"`);
    await rm(directory, { recursive: true, force: true });
  }
});
