import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { JobQueue } from "../src/server/ingestion/jobs";
import { RateLimitError } from "../src/server/ingestion/store";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId)) {
  throw new Error("Forecast job tests require NODE_ENV=test, a dedicated _test database and POSTGRES_TEST_CLUSTER_ID from a disposable cluster.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const connection = { host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"), database,
  connectionTimeoutMillis: 5_000, statement_timeout: 30_000 };
let administrator: pg.Client;
let pool: pg.Pool;
let competition: string;

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
  "forecast job tests require a disposable cluster without other databases");
  for (const command of ["provision", "migrate"]) {
    const result = await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), command], { cwd: root, env: process.env, timeout: 60_000 });
    assert.equal(result.stderr, "");
  }
  pool = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD, max: 8 });
});

beforeEach(async () => {
  const tables = (await administrator.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  await administrator.query(`TRUNCATE ${tables.map((row) => `sports.${row.tablename}`).join(",")} RESTART IDENTITY CASCADE`);
  competition = (await administrator.query(`INSERT INTO sports.competitions(provider_id,name,country_name,timezone,coefficient,enabled)
    VALUES ('153','Test league','England','Europe/London',1.5,true) RETURNING id`)).rows[0].id;
});

after(async () => { await Promise.allSettled([pool?.end(), administrator?.end()]); });

async function event(type: string, payload: object = {}) {
  return (await pool.query(`INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
    VALUES ($1,'competition',$2,$3,$4) RETURNING id`, [type, competition, randomUUID(), JSON.stringify(payload)])).rows[0].id as string;
}

test("forecast dispatch coalesces changes and leaves unrelated consumers untouched", async () => {
  const queue = new JobQueue(pool, "coalesce", true);
  await Promise.all([event("canonical.changed"), event("standings.changed"), event("roster.changed"), event("unrelated.event")]);
  assert.equal(await queue.dispatch(), 3);
  assert.equal(await queue.dispatch(), 0);
  assert.equal((await pool.query("SELECT * FROM sports.jobs WHERE kind='forecast.refresh'")).rowCount, 1);
  assert.equal((await pool.query("SELECT * FROM sports.outbox WHERE published_at IS NULL AND event_type='unrelated.event'")).rowCount, 1);
  const seen: string[] = [];
  assert.equal(await queue.runOnce(async (job) => { seen.push(job.kind); assert.deepEqual(job.payload, {}); }), true);
  assert.deepEqual(seen, ["forecast.refresh"]);
  assert.equal(await queue.dispatch(), 0, "a forecast completion must not feed its own dispatcher");
  assert.equal(await queue.runOnce(async () => assert.fail("nothing should be queued")), false);
});

test("changes arriving during a running forecast produce a follow-up after completion", async () => {
  const queue = new JobQueue(pool, "follow-up", true);
  await event("canonical.changed");
  await queue.dispatch();
  await queue.runOnce(async () => {
    await event("roster.changed");
    assert.equal(await queue.dispatch(), 0);
    assert.equal((await pool.query("SELECT * FROM sports.outbox WHERE published_at IS NULL")).rowCount, 1);
  });
  assert.equal(await queue.dispatch(), 1);
  await queue.runOnce(async () => {});
  assert.equal((await pool.query("SELECT * FROM sports.jobs WHERE kind='forecast.refresh' AND status='succeeded'")).rowCount, 2);
});

test("concurrent dispatchers and claimers create and execute one forecast", async () => {
  const queues = Array.from({ length: 4 }, (_, index) => new JobQueue(pool, `concurrent-${index}`, true));
  for (let index = 0; index < 12; index++) await event("canonical.changed");
  assert.equal((await Promise.all(queues.map((queue) => queue.dispatch()))).reduce((sum, count) => sum + count, 0), 12);
  let executed = 0;
  const claims = await Promise.all(queues.map((queue) => queue.runOnce(async () => { executed++; })));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(executed, 1);
});

test("legacy consumers do not acknowledge or execute forecasts", async () => {
  const legacy = new JobQueue(pool, "legacy");
  const enabled = new JobQueue(pool, "enabled", true);
  await event("canonical.changed");
  assert.equal(await legacy.scheduleForecast(), 0);
  assert.equal(await legacy.dispatch(), 0);
  assert.equal(await enabled.dispatch(), 1);
  assert.equal(await legacy.runOnce(async () => assert.fail("legacy consumer claimed a forecast")), false);
  assert.deepEqual(await legacy.status(), []);
  assert.equal(await enabled.runOnce(async () => {}), true);
});

test("clock refreshes deduplicate within a minute and refresh the next minute", async () => {
  const queue = new JobQueue(pool, "clock", true);
  const at = new Date("2026-11-09T10:00:00Z");
  assert.equal((await Promise.all([queue.scheduleForecast(at), queue.scheduleForecast(new Date(at.getTime() + 59_999))])).reduce((a, b) => a + b), 1);
  assert.equal(await queue.scheduleForecast(new Date(at.getTime() + 60_000)), 1);
  assert.equal(await queue.dispatch(), 2);
  await queue.runOnce(async () => {});
  assert.equal(await queue.dispatch(), 0);
});

test("provider budget deferrals do not consume attempts or block local forecasts", async () => {
  const queue = new JobQueue(pool, "budget", true);
  await event("fixture.statistics", { leagueId: "153", fixtureId: "900001" });
  await queue.dispatch();
  await queue.runOnce(async () => { throw new RateLimitError(new Date(Date.now() + 60_000)); });
  const deferred = (await pool.query("SELECT status,attempts,last_error FROM sports.jobs WHERE kind='fixture.statistics'")).rows[0];
  assert.deepEqual(deferred, { status: "ready", attempts: 0, last_error: "request_budget_exhausted" });
  await event("canonical.changed");
  await queue.dispatch();
  let kind = "";
  assert.equal(await queue.runOnce(async (job) => { kind = job.kind; }), true);
  assert.equal(kind, "forecast.refresh");
});

test("the local forecast pass never starts a provider statistics job", async () => {
  const queue = new JobQueue(pool, "local-pass", true);
  await event("fixture.statistics", { leagueId: "153", fixtureId: "900001" });
  await queue.dispatch();
  assert.equal(await queue.runForecastOnce(async () => assert.fail("local pass invoked source work")), false);
  await event("canonical.changed");
  await queue.dispatch();
  assert.equal(await queue.runForecastOnce(async (job) => { assert.equal(job.kind, "forecast.refresh"); }), true);
  assert.equal((await pool.query("SELECT * FROM sports.jobs WHERE kind='fixture.statistics' AND attempts=0 AND status='ready'")).rowCount, 1);
});

test("forecast failures retry durably without acknowledging later changes", async () => {
  const queue = new JobQueue(pool, "retry", true);
  await event("canonical.changed");
  await queue.dispatch();
  await queue.runOnce(async () => { throw new Error("private upstream content"); });
  const failure = (await pool.query("SELECT status,attempts,last_error FROM sports.jobs WHERE kind='forecast.refresh'")).rows[0];
  assert.deepEqual(failure, { status: "ready", attempts: 1, last_error: "processing_failed" });
  await event("canonical.changed");
  assert.equal(await queue.dispatch(), 0);
  await administrator.query("UPDATE sports.jobs SET run_after=clock_timestamp() WHERE kind='forecast.refresh'");
  await queue.runOnce(async () => {});
  assert.equal(await queue.dispatch(), 1);
});
