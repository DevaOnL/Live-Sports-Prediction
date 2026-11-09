import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hashPassword } from "better-auth/crypto";
import { MongoClient } from "mongodb";
import pg from "pg";
import { seedDemo } from "../db/demo/seed";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
const mongoName = process.env.MONGO_TEST_DATABASE ?? "";
const mongoHostId = process.env.MONGO_TEST_HOST_ID ?? "";
const mongoPort = Number(process.env.MONGO_TEST_PORT);
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId) ||
    !/^[a-z][a-z0-9_]{0,57}_test$/.test(mongoName) || process.env.MONGO_DB !== mongoName ||
    !mongoHostId || !Number.isInteger(mongoPort) || mongoPort < 1 || mongoPort > 65535) {
  throw new Error("HTTP integration requires guarded disposable PostgreSQL 17/MongoDB 8 _test databases and exact server identity markers.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const connection = { host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"), database,
  connectionTimeoutMillis: 5_000, statement_timeout: 30_000 };
const password = randomBytes(24).toString("hex");
const authSecret = randomBytes(32).toString("hex");
const viewerId = randomUUID();
const adminId = randomUUID();
let administrator: pg.Client;
let writer: pg.Pool;
let mongo: MongoClient;
let server: ChildProcess | undefined;
let output = "";
let origin = "";

async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function cli(script: string, args: string[]) {
  const result = await execute(process.execPath, ["--import", "tsx", join(root, "scripts", script), ...args], {
    cwd: root, timeout: 90_000, maxBuffer: 512_000,
  });
  assert.equal(result.stderr, "");
}

before(async () => {
  administrator = new pg.Client({ ...connection, user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD });
  administrator.on("error", () => undefined);
  await administrator.connect();
  const identity = (await administrator.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(identity.name, database);
  assert.equal(identity.identifier, clusterId, "refusing an unconfirmed PostgreSQL cluster");
  assert.equal(Math.trunc(Number(identity.version) / 10_000), 17);
  assert.equal((await administrator.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())")).rowCount, 0);
  mongo = new MongoClient(`mongodb://${process.env.MONGO_HOST ?? "127.0.0.1"}:${mongoPort}`, {
    auth: { username: process.env.MONGO_BOOTSTRAP_USER ?? "sports_bootstrap", password: process.env.MONGO_BOOTSTRAP_PASSWORD ?? "" },
    authSource: "admin", serverSelectionTimeoutMS: 5_000,
  });
  await mongo.connect();
  const admin = mongo.db("admin");
  assert.match((await admin.command({ buildInfo: 1 })).version, /^8\./);
  assert.equal((await admin.command({ hostInfo: 1 })).system.hostname, mongoHostId, "refusing an unconfirmed MongoDB server");
  assert.deepEqual((await admin.admin().listDatabases()).databases.map((item) => item.name).filter((name) => !["admin", "config", "local", mongoName].includes(name)), []);
  await cli("db.ts", ["provision"]);
  await cli("db.ts", ["migrate"]);
  await cli("mongo.ts", []);
  const tables = (await administrator.query("SELECT tablename FROM pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  await administrator.query(`TRUNCATE ${tables.map((row) => `sports.${row.tablename}`).join(",")} RESTART IDENTITY CASCADE`);
  await administrator.query('TRUNCATE auth.session,auth.account,auth.verification,auth."rateLimit",auth."user" CASCADE');
  await mongo.db(mongoName).collection("raw_archives").deleteMany({});
  await mongo.db(mongoName).collection("import_metadata").deleteMany({});
  writer = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD });
  writer.on("error", () => undefined);
  await seedDemo(writer, mongo.db(mongoName));
  const hash = await hashPassword(password);
  await administrator.query(`INSERT INTO auth."user"(id,name,email,role) VALUES ($1,'HTTP viewer','viewer@example.test','viewer'),($2,'HTTP admin','admin@example.test','admin')`, [viewerId, adminId]);
  await administrator.query(`INSERT INTO auth.account(id,"accountId","providerId","userId",password)
    VALUES ($1,$2,'credential',$2,$3),($4,$5,'credential',$5,$3)`, [randomUUID(), viewerId, hash, randomUUID(), adminId]);
  await stat(join(root, ".next/BUILD_ID"));
  await cp(join(root, ".next/static"), join(root, ".next/standalone/.next/static"), { recursive: true });
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", HOSTNAME: "127.0.0.1", PORT: String(port),
    AUTH_BASE_URL: origin, BETTER_AUTH_SECRET: authSecret,
    POSTGRES_HOST: connection.host, POSTGRES_PORT: String(connection.port), POSTGRES_DB: database,
    POSTGRES_READER_PASSWORD: process.env.POSTGRES_READER_PASSWORD,
    POSTGRES_WRITER_PASSWORD: process.env.POSTGRES_WRITER_PASSWORD,
    POSTGRES_AUTH_PASSWORD: process.env.POSTGRES_AUTH_PASSWORD,
  };
  assert(Object.keys(environment).every((key) => !/MIGRATOR|BOOTSTRAP|MONGO|APIFOOTBALL/.test(key)));
  server = spawn(process.execPath, [join(root, ".next/standalone/server.js")], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  server.stderr?.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null, "built HTTP server exited unexpectedly");
    try { if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* Wait only for our new process. */ }
    await pause(100);
  }
  assert(ready, "build the application before running HTTP integration");
});

beforeEach(async () => {
  await administrator.query('TRUNCATE auth.session,auth."rateLimit"');
  await administrator.query('UPDATE auth."user" SET role=CASE WHEN id=$1 THEN \'admin\' ELSE \'viewer\' END', [adminId]);
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise<void>((resolve) => server!.once("exit", () => resolve())), pause(5000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await Promise.allSettled([writer?.end(), administrator?.end(), mongo?.close()]);
  for (const value of [password, authSecret, process.env.POSTGRES_READER_PASSWORD, process.env.POSTGRES_WRITER_PASSWORD, process.env.POSTGRES_AUTH_PASSWORD].filter(Boolean)) {
    assert(!output.includes(value!), "server output cannot expose credentials");
  }
  assert(!/SERVER_ERROR|permission denied for|password authentication failed/i.test(output), "server diagnostics must remain generic");
});

async function api(path: string, options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers };
  if (method !== "GET") { headers.origin ??= origin; headers["content-type"] ??= "application/json"; }
  return fetch(`${origin}/api/${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), redirect: "manual" });
}
async function signIn(role: "viewer" | "admin" = "viewer") {
  const result = await api("auth/sign-in/email", { method: "POST", body: { email: `${role}@example.test`, password, rememberMe: false } });
  assert.equal(result.status, 200);
  assert(result.headers.getSetCookie().some((cookie) => /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie)));
  const body = await result.json();
  assert(!("token" in body));
  return result.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

test("built application exposes liveness and login while all product/admin reads require a session", async () => {
  const health = await api("health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).features.authentication, true);
  assert.equal((await fetch(`${origin}/login`)).status, 200);
  assert.equal((await fetch(`${origin}/account`, { redirect: "manual" })).headers.get("location"), "/login");
  for (const path of ["me", "overview", "competitions", "clubs", "players", "players/8001", "players/8001/forecast", "compare?playerId=8001&playerId=8002", "admin/status", "admin/jobs", "admin/audit"]) {
    const result = await api(path);
    assert.equal(result.status, 401, path);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
});

test("real login returns HttpOnly cookies without JSON tokens and viewers can read scoped evidence", async () => {
  const cookie = await signIn();
  const me = await (await api("me", { cookie })).json();
  assert.equal(me.data.role, "viewer");
  assert.equal(me.data.id, viewerId);
  const remainingHours = (new Date(me.data.expiresAt).getTime() - Date.now()) / 3_600_000;
  assert(remainingHours > 7.9 && remainingHours <= 8);
  const session = await (await api("auth/get-session", { cookie })).json();
  assert(!("token" in session.session) && !("ipAddress" in session.session) && !("userAgent" in session.session));
  const account = await fetch(`${origin}/account`, { headers: { cookie } });
  assert.equal(account.status, 200);
  assert((await account.text()).includes("HTTP viewer"));
  const listing = await (await api("players?leagueId=153&pageSize=2", { cookie })).json();
  assert.equal(listing.data.items.length, 2);
  assert.equal(listing.data.pagination.total, 4);
  const details = await (await api("players/8001", { cookie })).json();
  assert.equal(details.data.forecast.result.selected.length, 5);
  assert(details.data.observedAppearances.some((row: { minutes: number | null }) => row.minutes === 97));
  const comparison = await (await api("compare?playerId=8001&playerId=8002&allowCrossPosition=true", { cookie })).json();
  assert.equal(comparison.data.kind, "transient-comparison");
  assert.equal(comparison.data.players.length, 2);
  assert(comparison.data.players.every((player: { canonicalInputHash: string }) => /^[a-f0-9]{64}$/.test(player.canonicalInputHash)));
  assert.deepEqual(comparison.data.sharedMetrics, []);
  assert.equal((await api("compare?playerId=8001&playerId=8002", { cookie })).status, 400);
  assert.equal((await api("players/999999", { cookie })).status, 404);
  const injection = await (await api(`players?q=${encodeURIComponent("x' OR 1=1 --")}`, { cookie })).json();
  assert.equal(injection.data.pagination.total, 0);
});

test("viewers and forged client roles cannot invoke any administrator operation", async () => {
  const cookie = await signIn();
  const before = (await administrator.query("SELECT count(*)::integer AS count FROM sports.audit_log")).rows[0].count;
  for (const path of ["admin/imports", "admin/statistics", "admin/forecasts/refresh", `admin/jobs/${randomUUID()}/retry`]) {
    assert.equal((await api(path, { method: "POST", cookie, body: { requestId: randomUUID(), role: "admin" }, headers: { "x-role": "admin" } })).status, 403);
  }
  assert.equal((await api("admin/appearances", { method: "PATCH", cookie, body: { role: "admin" } })).status, 403);
  assert.equal((await api("admin/audit", { cookie, headers: { "x-user-role": "admin" } })).status, 403);
  assert.equal((await administrator.query("SELECT count(*)::integer AS count FROM sports.audit_log")).rows[0].count, before);
  assert.equal((await api("auth/sign-in/email", { method: "POST", body: { email: "viewer@example.test", password, role: "admin" } })).status, 400);
  assert.equal((await api("me", { cookie: cookie.replace("lsp.session_token=", "lsp.session_token=forged") })).status, 401);
});

test("canonical origin, host, strict bodies and route allowlists protect real HTTP mutations", async () => {
  const cookie = await signIn("admin");
  for (const path of ["auth/sign-up/email", "auth/reset-password", "auth/callback/provider", "auth/update-user"]) {
    assert.equal((await api(path, { method: "POST", cookie, body: {} })).status, 404);
  }
  assert.equal((await api("admin/imports", { method: "POST", cookie, body: { requestId: randomUUID() }, headers: { origin: "https://foreign.example" } })).status, 403);
  const missingOrigin = await fetch(`${origin}/api/admin/imports`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ requestId: randomUUID() }) });
  assert.equal(missingOrigin.status, 403);
  const untrustedHost = await new Promise<number | undefined>((resolve, reject) => {
    const incoming = httpRequest(`${origin}/api/me`, { headers: { cookie, host: "foreign.example", "x-forwarded-host": new URL(origin).host } }, (result) => {
      result.resume();
      result.once("end", () => resolve(result.statusCode));
    });
    incoming.once("error", reject);
    incoming.end();
  });
  assert.equal(untrustedHost, 403);
  assert.equal((await api("admin/imports", { method: "POST", cookie, body: { requestId: randomUUID(), ignored: true } })).status, 400);
  assert.equal((await api("players?page=1&page=2", { cookie })).status, 400);
  assert.equal((await api("players?sort=raw_sql", { cookie })).status, 400);
  assert.equal((await api("admin/imports", { method: "POST", cookie, body: { requestId: randomUUID(), text: "x".repeat(17_000) } })).status, 413);
});

test("database roles take effect immediately and revoked or expired sessions cannot be replayed", async () => {
  const cookie = await signIn("admin");
  await administrator.query('UPDATE auth."user" SET role=\'viewer\' WHERE id=$1', [adminId]);
  assert.equal((await api("admin/status", { cookie })).status, 403);
  assert.equal((await (await api("me", { cookie })).json()).data.role, "viewer");
  await administrator.query('DELETE FROM auth.session WHERE "userId"=$1', [adminId]);
  assert.equal((await api("me", { cookie })).status, 401);
  const expired = await signIn();
  await administrator.query('UPDATE auth.session SET "createdAt"=clock_timestamp()-interval \'2 hours\',"expiresAt"=clock_timestamp()-interval \'1 hour\' WHERE "userId"=$1', [viewerId]);
  assert.equal((await api("me", { cookie: expired })).status, 401);
});

test("successful logout revokes the database session and storage failure never reports success", async () => {
  const cookie = await signIn();
  await administrator.query('REVOKE DELETE ON auth.session FROM lsp_auth');
  try {
    const failed = await api("auth/sign-out", { method: "POST", cookie, body: {} });
    assert.equal(failed.status, 503);
    assert.equal((await administrator.query('SELECT count(*)::integer AS count FROM auth.session WHERE "userId"=$1', [viewerId])).rows[0].count, 1);
    assert.equal((await api("me", { cookie })).status, 200);
  } finally { await administrator.query('GRANT DELETE ON auth.session TO lsp_auth'); }
  const result = await api("auth/sign-out", { method: "POST", cookie, body: {} });
  assert.equal(result.status, 200);
  assert(result.headers.getSetCookie().some((value) => value.includes("Max-Age=0")));
  assert.equal((await api("me", { cookie })).status, 401);
});

test("login throttling survives fresh HTTP calls and spoofed forwarding identities", async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await api("auth/sign-in/email", { method: "POST", body: { email: "viewer@example.test", password: "incorrect-password" }, headers: { "x-forwarded-for": `198.51.100.${attempt + 1}` } })).status, 401);
  }
  const limited = await api("auth/sign-in/email", { method: "POST", body: { email: "viewer@example.test", password }, headers: { "x-forwarded-for": "203.0.113.99" } });
  assert.equal(limited.status, 429);
});

test("administrator commands are idempotent, actor-audited and preserve correction provenance", async () => {
  const cookie = await signIn("admin");
  const requestId = randomUUID();
  const first = await api("admin/imports", { method: "POST", cookie, body: { requestId } });
  const repeated = await api("admin/imports", { method: "POST", cookie, body: { requestId } });
  assert.equal(first.status, 202);
  assert.deepEqual(await repeated.json(), await first.json());
  assert.equal((await administrator.query("SELECT count(*)::integer AS count FROM sports.outbox WHERE event_type='source.sync'")).rows[0].count, 1);
  const current = (await administrator.query(`SELECT a.normalized_revision_id FROM sports.appearances a JOIN sports.players p ON p.id=a.player_id
    JOIN sports.fixtures f ON f.id=a.fixture_id WHERE p.provider_id='8001' AND f.provider_id='900005'`)).rows[0].normalized_revision_id;
  const correction = { requestId: randomUUID(), playerId: "8001", fixtureId: "900005", expectedRevisionId: current,
    reason: "Synthetic HTTP correction verification", changes: { rating: 8.25, saves: 0 } };
  const result = await api("admin/appearances", { method: "PATCH", cookie, body: correction });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.data.provider, "manual");
  assert.equal(body.data.providerMaySupersede, true);
  assert.deepEqual(await (await api("admin/appearances", { method: "PATCH", cookie, body: correction })).json(), body);
  assert.equal((await api("admin/appearances", { method: "PATCH", cookie, body: { ...correction, requestId: randomUUID() } })).status, 409);
  const audit = (await administrator.query("SELECT actor_type,actor_id,detail FROM sports.audit_log WHERE id=$1", [correction.requestId])).rows[0];
  assert.equal(audit.actor_type, "user");
  assert.equal(audit.actor_id, adminId);
  const visible = await api("admin/audit?pageSize=5", { cookie });
  assert.equal(visible.status, 200);
  assert.equal((await administrator.query("SELECT count(*)::integer AS count FROM sports.provider_requests")).rows[0].count, 0);
});
