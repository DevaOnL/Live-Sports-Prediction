import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MongoClient, type Db } from "mongodb";
import pg from "pg";
import { seedDemo } from "../db/demo/seed";
import { runMongoExamples } from "../db/demo/mongo/operations";
import { ForecastStore } from "../src/server/forecast/store";
import { JobQueue } from "../src/server/ingestion/jobs";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const abort = new AbortController();
const interrupt = () => abort.abort();
const connectionLost = () => abort.abort(new Error("Isolated PostgreSQL connection lost"));
const token = randomBytes(8).toString("hex");
const label = "live-sports-demonstration";
const database = "synthetic_demo";
const resources: { name: string; id?: string }[] = [];
const passwords = Object.fromEntries(["BOOTSTRAP", "READER", "WRITER", "AUTH", "MIGRATOR"].map((role) => [role, randomBytes(24).toString("hex")]));

// Local dotenv files and existing database/provider credentials are never used.
const isolated: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(isolated)) {
  if (/^(POSTGRES_|MONGO_|APIFOOTBALL_|PG[A-Z_]|DATABASE_URL$)/.test(key)) delete isolated[key];
}
Object.assign(isolated, {
  NODE_ENV: "test", POSTGRES_HOST: "127.0.0.1", POSTGRES_DB: database, POSTGRES_USER: "sports_bootstrap",
  MONGO_HOST: "127.0.0.1", MONGO_DB: database, MONGO_BOOTSTRAP_USER: "sports_bootstrap", MONGO_WORKER_USER: "lsp_ingestion",
  MONGO_BOOTSTRAP_PASSWORD: randomBytes(24).toString("hex"), MONGO_WORKER_PASSWORD: randomBytes(24).toString("hex"),
  INGESTION_ENABLED: "false", APIFOOTBALL_API_KEY: "",
});
for (const [role, password] of Object.entries(passwords)) isolated[`POSTGRES_${role}_PASSWORD`] = password;

async function docker(args: string[], environment: NodeJS.ProcessEnv = isolated, cleanup = false): Promise<string> {
  const result = await execute("docker", args, {
    env: environment, cwd: root, signal: cleanup ? undefined : abort.signal, timeout: 120_000, maxBuffer: 1_048_576,
  });
  return result.stdout.trim();
}

async function start(kind: "pg" | "mongo"): Promise<{ name: string; id?: string }> {
  const resource: { name: string; id?: string } = { name: `lsp-demo-${kind}-${token}` };
  resources.push(resource);
  const args = ["run", "--rm", "-d", "--name", resource.name, "--hostname", resource.name, "--label", `${label}=${token}`];
  if (kind === "pg") {
    args.push("--tmpfs", "/var/lib/postgresql/data", "--env", "POSTGRES_DB", "--env", "POSTGRES_USER", "--env", "POSTGRES_PASSWORD",
      "--env", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256", "--publish", "127.0.0.1::5432", "postgres:17-alpine");
    resource.id = await docker(args, { ...isolated, POSTGRES_PASSWORD: passwords.BOOTSTRAP });
  } else {
    args.push("--tmpfs", "/data/db", "--tmpfs", "/data/configdb", "--env", "MONGO_INITDB_ROOT_USERNAME", "--env", "MONGO_INITDB_ROOT_PASSWORD",
      "--publish", "127.0.0.1::27017", "mongo:8");
    resource.id = await docker(args, { ...isolated, MONGO_INITDB_ROOT_USERNAME: isolated.MONGO_BOOTSTRAP_USER,
      MONGO_INITDB_ROOT_PASSWORD: isolated.MONGO_BOOTSTRAP_PASSWORD });
  }
  assert.match(resource.id, /^[0-9a-f]{64}$/);
  return resource;
}

async function inspect(resource: { name: string; id?: string }): Promise<void> {
  const containers = JSON.parse(await docker(["inspect", resource.id ?? resource.name])) as { Id: string; Config: { Labels: Record<string, string> } }[];
  assert.equal(containers.length, 1);
  assert.equal(containers[0].Config.Labels[label], token, "refusing a container outside this demonstration");
  if (resource.id) assert.equal(containers[0].Id, resource.id);
}

async function waitFor<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 90 && !abort.signal.aborted; attempt++) {
    try { return await operation(); } catch { await pause(500, undefined, { signal: abort.signal }); }
  }
  throw new Error("Isolated database did not become ready");
}

async function cli(script: string, args: string[] = []): Promise<void> {
  await execute(process.execPath, ["--import", "tsx", join(root, "scripts", script), ...args], {
    env: isolated, cwd: root, timeout: 90_000, maxBuffer: 1_048_576, signal: abort.signal,
  });
}

type Statement = { command: string; rowCount: number | null; rows: Record<string, unknown>[] };
async function examples(client: pg.Pool, file: string): Promise<Statement[]> {
  const connection = await client.connect();
  try {
    const result = await connection.query(await readFile(join(root, "db/demo/sql", file), "utf8")) as unknown as Statement | Statement[];
    return (Array.isArray(result) ? result : [result]).filter((statement) => statement.rows.length > 0);
  } finally { await connection.query("ROLLBACK").catch(() => undefined); connection.release(); }
}

async function fingerprint(pool: pg.Pool): Promise<string> {
  const tables = (await pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  const hash = createHash("sha256");
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    const rows = await pool.query(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text,',' ORDER BY to_jsonb(t)::text),'')) AS hash FROM sports.${tablename} t`);
    hash.update(tablename).update(rows.rows[0].hash);
  }
  return hash.digest("hex");
}

async function rawFingerprint(db: Db): Promise<string> {
  const records = await db.collection("raw_archives").find({}).sort({ _id: 1 }).toArray();
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("Usage: npm run demo");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let administrator: pg.Client | undefined;
  let mongo: MongoClient | undefined;
  let writer: pg.Pool | undefined;
  let reader: pg.Pool | undefined;
  try {
    assert.equal(await docker(["info", "--format", "{{.OSType}}"]), "linux", "Linux Docker is required");
    const postgres = await start("pg");
    const document = await start("mongo");
    await inspect(postgres);
    await inspect(document);
    isolated.POSTGRES_PORT = (await docker(["port", postgres.id!, "5432/tcp"])).split(":").at(-1)!;
    isolated.MONGO_PORT = (await docker(["port", document.id!, "27017/tcp"])).split(":").at(-1)!;
    const postgresConfig = { host: "127.0.0.1", port: Number(isolated.POSTGRES_PORT), database, connectionTimeoutMillis: 3_000, query_timeout: 15_000, statement_timeout: 15_000 };
    administrator = await waitFor(async () => {
      const client = new pg.Client({ ...postgresConfig, user: isolated.POSTGRES_USER, password: passwords.BOOTSTRAP });
      client.on("error", connectionLost);
      try { await client.connect(); return client; } catch (error) { await client.end().catch(() => undefined); throw error; }
    });
    const identity = (await administrator.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
      current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
    const expected = await docker(["exec", postgres.id!, "psql", "-U", "sports_bootstrap", "-d", database, "-Atqc", "SELECT system_identifier::text FROM pg_control_system()"]);
    assert.equal(identity.name, database);
    assert.equal(identity.identifier, expected);
    assert.equal(Math.trunc(Number(identity.version) / 10_000), 17);
    assert.equal((await administrator.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())")).rowCount, 0);
    mongo = await waitFor(async () => {
      const client = new MongoClient(`mongodb://127.0.0.1:${isolated.MONGO_PORT}`, {
        auth: { username: isolated.MONGO_BOOTSTRAP_USER!, password: isolated.MONGO_BOOTSTRAP_PASSWORD! }, authSource: "admin", serverSelectionTimeoutMS: 3_000, connectTimeoutMS: 3_000, socketTimeoutMS: 15_000,
      });
      try { await client.connect(); return client; } catch (error) { await client.close(); throw error; }
    });
    const mongoAdmin = mongo.db("admin");
    assert.match((await mongoAdmin.command({ buildInfo: 1 })).version, /^8\./);
    assert.equal((await mongoAdmin.command({ hostInfo: 1 })).system.hostname, document.name);
    assert.deepEqual((await mongoAdmin.admin().listDatabases()).databases.map((entry) => entry.name).filter((name) => !["admin", "config", "local"].includes(name)), []);
    await cli("db.ts", ["provision"]);
    await cli("db.ts", ["migrate"]);
    await cli("mongo.ts");
    const db = mongo.db(database);
    writer = new pg.Pool({ ...postgresConfig, user: "lsp_writer", password: passwords.WRITER, max: 6 });
    reader = new pg.Pool({ ...postgresConfig, user: "lsp_reader", password: passwords.READER, max: 2 });
    writer.on("error", connectionLost);
    reader.on("error", connectionLost);
    const seeded = await seedDemo(writer, db);
    assert.equal(seeded.fixtures, 552);
    assert.equal(seeded.players, 4);
    assert.equal(seeded.revisions, 6);
    const before = await fingerprint(writer);
    const dml = await examples(writer, "dml.sql");
    assert.deepEqual(dml.map((result) => result.command), ["INSERT", "UPDATE", "DELETE"]);
    assert(dml.every((result) => result.rowCount === 1));
    assert.equal(await fingerprint(writer), before, "DML examples must roll back");
    const queries = await examples(reader, "queries.sql");
    assert.deepEqual(queries.map((result) => result.rows.length), [28, 4, 4, 20, 3]);
    assert(queries[2].rows.every((row) => row.eligible_appearances === "5" && row.short_appearances === "1" && row.confirmed_dnps === "1"));
    assert(queries[4].rows.every((row) => row.forecast_rating_0_to_10 !== null && Number.isFinite(Number(row.forecast_rating_0_to_10))));
    const advanced = await examples(writer, "advanced.sql");
    assert(advanced.some((result) => result.rows.some((row) => row.foreign_key_rejection_verified === true)));
    assert(advanced.some((result) => result.rows.some((row) => row.trigger_transition_verified === true)));
    assert.equal(await fingerprint(writer), before, "procedure/trigger examples must roll back");
    const candidates = (await reader.query("SELECT * FROM sports.player_qualifying_history($1,$2)", ["8001", seeded.cutoffAt])).rows;
    assert.equal(candidates.length, 5);
    assert.equal(candidates[0].minutes, 60);
    assert(candidates.some((row) => row.minutes > 90));
    const lineage = (await reader.query("SELECT * FROM sports.forecast_lineage($1)", ["8001"])).rows;
    assert.equal(lineage.length, 3);
    assert.equal(lineage[0].input_hash, lineage[2].input_hash, "returning to A must append a new revision");
    assert.notEqual(lineage[0].revision_id, lineage[2].revision_id);
    const events = (await writer.query("SELECT count(*)::integer AS count FROM sports.outbox WHERE event_type='forecast.updated'")).rows[0].count;
    const audits = (await writer.query("SELECT count(*)::integer AS count FROM sports.audit_log WHERE action='forecast.refresh'")).rows[0].count;
    assert.equal(events, 6);
    assert.equal(audits, 6);
    const requestId = randomUUID();
    await writer.query("CALL sports.request_forecast_refresh($1)", [requestId]);
    await writer.query("CALL sports.request_forecast_refresh($1)", [requestId]);
    assert.equal((await writer.query("SELECT count(*)::integer AS count FROM sports.outbox WHERE deduplication_key=$1", [`forecast.manual:${requestId}`])).rows[0].count, 1);
    await assert.rejects(reader.query("CALL sports.request_forecast_refresh($1)", [randomUUID()]), { code: "42501" });
    const queue = new JobQueue(writer, "synthetic-demonstration", true);
    await queue.dispatch(500);
    assert.equal(await queue.runForecastOnce(async () => {
      const result = await new ForecastStore(writer!).refreshAll(seeded.cutoffAt);
      assert.equal(result.created, 0);
      assert.equal(result.unchanged, 4);
    }), true);
    assert.equal(await queue.dispatch(500), 0);
    assert.equal(await queue.runForecastOnce(async () => assert.fail("forecast notifications must not feed refreshes")), false);
    assert.equal((await new ForecastStore(writer).status()).revisions, 6);
    const rawBefore = await rawFingerprint(db);
    const documents = await runMongoExamples(db);
    assert.equal(await rawFingerprint(db), rawBefore, "document examples cannot change authoritative archives");
    assert.equal((await writer.query("SELECT count(*)::integer AS count FROM sports.provider_requests")).rows[0].count, 0);
    abort.signal.throwIfAborted();
    console.info(JSON.stringify({ dataset: "synthetic", isolated: true, seeded,
      sql: { dml, queries, advanced, candidateHistory: candidates, lineage, forecastNotifications: events,
        forecastAudits: audits, idempotentRefreshRequest: true, readerWriteDenied: true, rolledBackExamples: true, noRefreshLoop: true },
      mongo: documents, providerRequests: 0 }, null, 2));
  } finally {
    await Promise.allSettled([writer?.end(), reader?.end(), administrator?.end(), mongo?.close()]);
    let cleanupFailed = false;
    for (const resource of resources.reverse()) {
      try {
        const containers = JSON.parse(await docker(["inspect", resource.id ?? resource.name], isolated, true)) as { Id: string; Config: { Labels: Record<string, string> } }[];
        assert.equal(containers[0]?.Config.Labels[label], token, "refusing to remove an unrelated container");
        if (resource.id) assert.equal(containers[0].Id, resource.id);
        await docker(["rm", "--force", containers[0].Id], isolated, true);
      } catch {
        // A failed docker run may have created no container at all.
        const remaining = await docker(["ps", "-aq", "--filter", `name=^/${resource.name}$`, "--filter", `label=${label}=${token}`], isolated, true).catch(() => "unknown");
        if (remaining) cleanupFailed = true;
      }
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (cleanupFailed) throw new Error("Could not clean up this demonstration's temporary containers");
  }
}

main().catch(() => {
  console.error("Database demonstration failed. Check Linux Docker availability, supported PostgreSQL 17/MongoDB 8 images and the project migrations. Existing project databases are never used.");
  process.exitCode = 1;
});
