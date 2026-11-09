import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hashPassword } from "better-auth/crypto";
import { MongoClient } from "mongodb";
import pg from "pg";
import { seedDemo } from "../../db/demo/seed";

export type RequestOptions = { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> };

/** A built web process attached only to the caller's identity-guarded disposable databases. */
export function createWebHarness() {
  const database = process.env.POSTGRES_DB ?? "";
  const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
  const mongoName = process.env.MONGO_TEST_DATABASE ?? "";
  const mongoHostId = process.env.MONGO_TEST_HOST_ID ?? "";
  const mongoPort = Number(process.env.MONGO_TEST_PORT);
  if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId) ||
      !/^[a-z][a-z0-9_]{0,57}_test$/.test(mongoName) || process.env.MONGO_DB !== mongoName ||
      !mongoHostId || !Number.isInteger(mongoPort) || mongoPort < 1 || mongoPort > 65535) {
    throw new Error("Web integration requires guarded disposable PostgreSQL 17/MongoDB 8 _test databases and exact server identity markers.");
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
  let validated = false;

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
    assert(validated, "database identities must be validated before provisioning");
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      key === "PATH" || /^(POSTGRES_|MONGO_)/.test(key))) };
    const result = await execute(process.execPath, ["--import", "tsx", join(root, "scripts", script), ...args], {
      cwd: root, env: environment, timeout: 90_000, maxBuffer: 512_000,
    });
    assert.equal(result.stderr, "");
  }

  async function start() {
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
    validated = true;
    await cli("db.ts", ["provision"]);
    await cli("db.ts", ["migrate"]);
    await cli("mongo.ts", []);
    const tables = (await administrator.query("SELECT tablename FROM pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
    assert(tables.length > 0 && tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
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
    if (await stat(join(root, "public")).then(() => true, () => false)) {
      await cp(join(root, "public"), join(root, ".next/standalone/public"), { recursive: true });
    }
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
    assert(ready, "build the application before running web integration");
  }

  async function resetAuth() {
    assert(validated);
    await administrator.query('TRUNCATE auth.session,auth."rateLimit"');
    await administrator.query('UPDATE auth."user" SET role=CASE WHEN id=$1 THEN \'admin\' ELSE \'viewer\' END', [adminId]);
  }

  async function stop() {
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
  }

  async function api(path: string, options: RequestOptions = {}) {
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

  return { start, resetAuth, stop, api, signIn, password, viewerId, adminId,
    get origin() { return origin; }, get administrator() { return administrator; }, get writer() { return writer; }, get mongo() { return mongo; },
  };
}
