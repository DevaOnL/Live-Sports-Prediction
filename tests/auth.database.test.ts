import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isAPIError } from "better-auth/api";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import pg from "pg";
import { createAuthentication } from "../src/server/auth/config";
import { resolvePrincipal } from "../src/server/auth/principal";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId)) {
  throw new Error("Authentication tests require NODE_ENV=test, a dedicated _test database and POSTGRES_TEST_CLUSTER_ID from a disposable PostgreSQL 17 cluster.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const baseURL = "http://127.0.0.1:3000";
const secret = randomBytes(32).toString("hex");
const connection = {
  host: process.env.POSTGRES_HOST ?? "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT ?? "5432"), database,
  connectionTimeoutMillis: 5_000, statement_timeout: 20_000,
};
type Authentication = ReturnType<typeof createAuthentication>;
let administrator: pg.Client;
let migrator: pg.Client;
let reader: pg.Client;
let authPool: pg.Pool;
let otherAuthPool: pg.Pool;
let authentication: Authentication;
let viewerId: string;
let password: string;

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
  "authentication tests require a disposable PostgreSQL cluster without other databases");
  for (const command of ["provision", "migrate"]) {
    const result = await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), command], {
      cwd: root, timeout: 60_000, maxBuffer: 512_000,
    });
    assert.equal(result.stderr, "");
  }
  const authConfiguration = {
    ...connection, user: "lsp_auth", password: process.env.POSTGRES_AUTH_PASSWORD,
    options: "-c search_path=pg_catalog,auth", max: 6,
  };
  authPool = new pg.Pool(authConfiguration);
  otherAuthPool = new pg.Pool(authConfiguration);
  authPool.on("error", () => undefined);
  otherAuthPool.on("error", () => undefined);
  migrator = new pg.Client({ ...connection, user: "lsp_migrator", password: process.env.POSTGRES_MIGRATOR_PASSWORD });
  reader = new pg.Client({ ...connection, user: "lsp_reader", password: process.env.POSTGRES_READER_PASSWORD });
  await Promise.all([migrator.connect(), reader.connect()]);
});

after(async () => {
  await Promise.allSettled([authPool?.end(), otherAuthPool?.end(), migrator?.end(), reader?.end(), administrator?.end()]);
});

beforeEach(async () => {
  await administrator.query('TRUNCATE auth.session, auth.account, auth.verification, auth."rateLimit", auth."user" CASCADE');
  authentication = createAuthentication(authPool, { baseURL, secret });
  password = `${randomUUID()}-synthetic`;
  const hash = await hashPassword(password);
  viewerId = randomUUID();
  const adminId = randomUUID();
  await migrator.query(`INSERT INTO auth."user" (id,name,email,role)
    VALUES ($1,'Synthetic viewer','viewer@example.test','viewer'),
      ($2,'Synthetic administrator','admin@example.test','admin')`, [viewerId, adminId]);
  await migrator.query(`INSERT INTO auth.account (id,"accountId","providerId","userId",password)
    VALUES ($1,$2,'credential',$2,$3),($4,$5,'credential',$5,$3)`, [randomUUID(), viewerId, hash, randomUUID(), adminId]);
});

async function response(auth: Authentication, method: string, path: string, body?: unknown, extraHeaders: HeadersInit = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("origin", baseURL);
  if (body !== undefined) headers.set("content-type", "application/json");
  try {
    return await auth.handler(new Request(`${baseURL}/api/auth${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }));
  } catch (error) {
    if (isAPIError(error)) return Response.json(error.body ?? {}, { status: error.statusCode, headers: error.headers });
    throw error;
  }
}

async function signIn(email = "viewer@example.test", suppliedPassword = password, auth = authentication, extra: Record<string, unknown> = {}) {
  return response(auth, "POST", "/sign-in/email", { email, password: suppliedPassword, ...extra });
}

function cookies(result: Response) {
  return result.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

function principal(cookie: string, auth = authentication, extra: HeadersInit = {}) {
  const headers = new Headers(extra);
  headers.set("cookie", cookie);
  return resolvePrincipal(auth, authPool, headers);
}

function userCommand(arguments_: string[], input = "") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(root, "scripts/users.ts"), ...arguments_], {
      cwd: root,
      env: {
        PATH: process.env.PATH, NODE_ENV: "test",
        POSTGRES_HOST: connection.host, POSTGRES_PORT: String(connection.port), POSTGRES_DB: database,
        POSTGRES_MIGRATOR_PASSWORD: process.env.POSTGRES_MIGRATOR_PASSWORD,
      },
      stdio: ["pipe", "pipe", "pipe"], timeout: 20_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

test("database sessions authenticate seeded viewers and admins without trusting caller roles", async () => {
  assert.equal(await resolvePrincipal(authentication, authPool, new Headers({ "x-user-role": "admin" })), null);
  const login = await signIn("viewer@example.test", password, authentication, { role: "admin", user: { role: "admin" } });
  assert.equal(login.status, 200);
  const cookie = cookies(login);
  const viewer = await principal(cookie, authentication, { "x-user-role": "admin", "x-user-id": randomUUID() });
  assert.equal(viewer?.id, viewerId);
  assert.equal(viewer?.role, "viewer");
  assert(viewer?.expiresAt instanceof Date);
  const hours = (viewer.expiresAt.getTime() - Date.now()) / 3_600_000;
  assert(hours > 7.9 && hours <= 8);
  const adminLogin = await signIn("admin@example.test");
  assert.equal(adminLogin.status, 200);
  assert.equal((await principal(cookies(adminLogin)))?.role, "admin");
  assert(login.headers.getSetCookie().some((value) => value.includes("HttpOnly") && value.includes("SameSite=Lax")));
  assert(login.headers.getSetCookie().every((value) => !value.startsWith("lsp.session_data=")));
  assert.equal((await authPool.query("SELECT count(*) FROM auth.session")).rows[0].count, "2");
});

test("failed sign-ins do not disclose whether an account exists or create sessions", async () => {
  const wrongPassword = await signIn("viewer@example.test", `${randomUUID()}-wrong`);
  const unknownUser = await signIn("missing@example.test", `${randomUUID()}-wrong`);
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.deepEqual(await wrongPassword.json(), await unknownUser.json());
  assert.equal((await authPool.query("SELECT count(*) FROM auth.session")).rows[0].count, "0");
  const injection = await signIn("viewer' OR '1'='1@example.test");
  assert([400, 401].includes(injection.status));
  assert.equal((await authPool.query('SELECT count(*) FROM auth."user"')).rows[0].count, "2");
});

test("nonpersistent browser cookies never extend the eight-hour database session", async () => {
  const login = await signIn("viewer@example.test", password, authentication, { rememberMe: false });
  assert.equal(login.status, 200);
  const viewer = await principal(cookies(login));
  assert(viewer);
  const hours = (viewer.expiresAt.getTime() - Date.now()) / 3_600_000;
  assert(hours > 7.9 && hours <= 8);
  const cookie = login.headers.getSetCookie().find((value) => value.startsWith("lsp.session_token="));
  assert(cookie && !/Max-Age=|Expires=/i.test(cookie));
});

test("omitting the secondary cookie cannot renew a nonpersistent session", async () => {
  const login = await signIn("viewer@example.test", password, authentication, { rememberMe: false, persistent: true });
  assert.equal(login.status, 200);
  const tokenCookie = cookies(login).split("; ").find((value) => value.startsWith("lsp.session_token="));
  assert(tokenCookie);
  const initial = await principal(tokenCookie);
  assert(initial);
  await migrator.query(`UPDATE auth.session SET "createdAt"=clock_timestamp()-interval '7 hours',
    "updatedAt"=clock_timestamp()-interval '1 hour',"expiresAt"=clock_timestamp()+interval '1 hour' WHERE id=$1`, [initial.sessionId]);
  const before = (await migrator.query('SELECT persistent,"expiresAt" FROM auth.session WHERE id=$1', [initial.sessionId])).rows[0];
  assert.equal(before.persistent, false, "client additional fields cannot select session mode");
  for (let attempt = 0; attempt < 2; attempt++) {
    const refreshed = await response(authentication, "GET", "/get-session", undefined, { cookie: tokenCookie });
    assert.equal(refreshed.status, 200);
    const body = await refreshed.json();
    assert.equal(Object.hasOwn(body.session, "persistent"), false);
    assert.equal(new Date(body.session.expiresAt).getTime(), before.expiresAt.getTime());
    assert.equal((await migrator.query('SELECT "expiresAt" FROM auth.session WHERE id=$1', [initial.sessionId])).rows[0].expiresAt.getTime(), before.expiresAt.getTime());
  }
  assert(await principal(tokenCookie));
});

test("persistent sessions still renew and renewed sessions remain revocable", async () => {
  const login = await signIn("viewer@example.test", password, authentication, { rememberMe: true });
  assert.equal(login.status, 200);
  const cookie = cookies(login);
  const initial = await principal(cookie);
  assert(initial);
  await migrator.query(`UPDATE auth.session SET "createdAt"=clock_timestamp()-interval '7 hours',
    "updatedAt"=clock_timestamp()-interval '1 hour',"expiresAt"=clock_timestamp()+interval '1 hour' WHERE id=$1`, [initial.sessionId]);
  const renewed = await response(authentication, "GET", "/get-session", undefined, { cookie });
  assert.equal(renewed.status, 200);
  const body = await renewed.json();
  assert.equal(Object.hasOwn(body.session, "persistent"), false);
  const stored = (await migrator.query('SELECT persistent,"expiresAt" FROM auth.session WHERE id=$1', [initial.sessionId])).rows[0];
  assert.equal(stored.persistent, true);
  const remainingHours = (stored.expiresAt.getTime() - Date.now()) / 3_600_000;
  assert(remainingHours > 7.9 && remainingHours <= 8);
  const renewedCookie = cookies(renewed);
  assert(await principal(renewedCookie));
  const logout = await response(authentication, "POST", "/sign-out", {}, { cookie: renewedCookie });
  assert.equal(logout.status, 200);
  assert.equal(await principal(renewedCookie), null);
});

test("sessions with the migration default retain their valid expiry without renewal", async () => {
  const login = await signIn();
  assert.equal(login.status, 200);
  const cookie = cookies(login);
  const initial = await principal(cookie);
  assert(initial);
  // Model an older rolling session at upgrade. Defaulting its new field must
  // preserve the current valid expiry instead of applying creation plus 8h.
  await migrator.query(`UPDATE auth.session SET persistent=DEFAULT,"createdAt"=clock_timestamp()-interval '2 days',
    "updatedAt"=clock_timestamp()-interval '1 hour',"expiresAt"=clock_timestamp()+interval '2 hours' WHERE id=$1`, [initial.sessionId]);
  const before = (await migrator.query('SELECT persistent,"expiresAt" FROM auth.session WHERE id=$1', [initial.sessionId])).rows[0];
  assert.equal(before.persistent, false);
  const checked = await response(authentication, "GET", "/get-session", undefined, { cookie });
  assert.equal(checked.status, 200);
  assert.equal(new Date((await checked.json()).session.expiresAt).getTime(), before.expiresAt.getTime());
  assert(await principal(cookie));
});

test("role changes are read from SQL on every request and authorization lookups do not refresh expiry", async () => {
  const login = await signIn();
  const cookie = cookies(login);
  const initial = await principal(cookie);
  assert(initial);
  await migrator.query('UPDATE auth."user" SET role=\'admin\' WHERE id=$1', [viewerId]);
  assert.equal((await principal(cookie))?.role, "admin");
  await migrator.query('UPDATE auth."user" SET role=\'viewer\' WHERE id=$1', [viewerId]);
  assert.equal((await principal(cookie))?.role, "viewer");
  await migrator.query(`UPDATE auth.session SET "updatedAt"=now()-interval '1 hour',
    "expiresAt"=now()+interval '1 hour' WHERE id=$1`, [initial.sessionId]);
  const expiry = (await migrator.query('SELECT "expiresAt" FROM auth.session WHERE id=$1', [initial.sessionId])).rows[0].expiresAt;
  assert(await principal(cookie));
  assert.equal((await migrator.query('SELECT "expiresAt" FROM auth.session WHERE id=$1', [initial.sessionId])).rows[0].expiresAt.getTime(), expiry.getTime());
});

test("expired, forged, logged-out and revoked sessions fail authoritative lookup", async () => {
  const login = await signIn();
  const cookie = cookies(login);
  const valid = await principal(cookie);
  assert(valid);
  assert.equal(await principal(`${cookie}tampered`), null);
  await migrator.query(`UPDATE auth.session SET "createdAt"=now()-interval '2 hours',
    "expiresAt"=now()-interval '1 hour' WHERE id=$1`, [valid.sessionId]);
  assert.equal(await principal(cookie), null);
  const secondLogin = await signIn();
  const secondCookie = cookies(secondLogin);
  const siblingLogin = await signIn();
  const siblingCookie = cookies(siblingLogin);
  const logout = await response(authentication, "POST", "/sign-out", {}, { cookie: secondCookie });
  assert.equal(logout.status, 200);
  assert.equal(await principal(secondCookie), null);
  const sibling = await principal(siblingCookie);
  assert(sibling);
  await migrator.query("DELETE FROM auth.session WHERE id=$1", [sibling.sessionId]);
  assert.equal(await principal(siblingCookie), null);
});

test("public account lifecycle routes and runtime privilege escalation are disabled", async () => {
  for (const path of ["/sign-up/email", "/sign-in/social", "/request-password-reset", "/reset-password", "/change-email", "/delete-user", "/update-user"]) {
    assert.equal((await response(authentication, "POST", path, {})).status, 404, path);
  }
  await assert.rejects(authPool.query('UPDATE auth."user" SET role=\'admin\' WHERE id=$1', [viewerId]), { code: "42501" });
  await assert.rejects(authPool.query('INSERT INTO auth."user" (id,name,email,role) VALUES ($1,\'Forged\',\'forged@example.test\',\'admin\')', [randomUUID()]), { code: "42501" });
  await assert.rejects(authPool.query('DELETE FROM auth."user" WHERE id=$1', [viewerId]), { code: "42501" });
  await assert.rejects(authPool.query("SELECT * FROM sports.players LIMIT 1"), { code: "42501" });
  await assert.rejects(authPool.query("SET ROLE lsp_migrator"), { code: "42501" });
  await assert.rejects(reader.query("INSERT INTO sports.players(provider_id,name) VALUES ('forbidden','Forbidden')"), { code: "42501" });
  await assert.rejects(reader.query('SELECT * FROM auth."rateLimit"'), { code: "42501" });
  await assert.rejects(reader.query('UPDATE auth."rateLimit" SET count=0'), { code: "42501" });
});

test("the SQL limiter atomically shares its budget across instances and ignores forged forwarding headers", async () => {
  const second = createAuthentication(otherAuthPool, { baseURL, secret });
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) => response(
    index % 2 === 0 ? authentication : second, "POST", "/sign-in/email",
    { email: "viewer@example.test", password: `${randomUUID()}-wrong` },
    { "x-forwarded-for": `192.0.2.${index + 1}`, "x-real-ip": `198.51.100.${index + 1}` },
  )));
  assert.equal(attempts.filter((result) => result.status === 401).length, 5);
  assert.equal(attempts.filter((result) => result.status === 429).length, 7);
  const row = (await authPool.query('SELECT count,key FROM auth."rateLimit"')).rows;
  assert.equal(row.length, 1);
  assert.equal(row[0].count, 5);
  const restarted = createAuthentication(otherAuthPool, { baseURL, secret });
  const blocked = await signIn("viewer@example.test", password, restarted);
  assert.equal(blocked.status, 429);
  assert(Number(blocked.headers.get("X-Retry-After")) > 0);
  await migrator.query('UPDATE auth."rateLimit" SET "lastRequest"=$1', [Date.now() - 61_000]);
  assert.equal((await signIn("viewer@example.test", password, restarted)).status, 200);
  assert.equal((await authPool.query('SELECT count FROM auth."rateLimit"')).rows[0].count, 1);
});

test("the CLI creates compatible password accounts using only migrator access and never echoes the password", async () => {
  const seedPassword = `${randomUUID()}-seed`;
  const created = await userCommand(["create", "--email", " Seeded@Example.Test ", "--name", "Seeded O'Connor", "--role", "admin", "--password-stdin"], `${seedPassword}\n`);
  assert.equal(created.code, 0);
  assert.equal(created.stdout, "User created.\n");
  assert.equal(created.stderr, "");
  assert(!created.stdout.includes(seedPassword));
  const record = (await migrator.query(`SELECT u.id,u.name,u.role,u."emailVerified",a."accountId",a."providerId",a.password
    FROM auth."user" u JOIN auth.account a ON a."userId"=u.id WHERE u.email=$1`, ["seeded@example.test"])).rows[0];
  assert.equal(record.name, "Seeded O'Connor");
  assert.equal(record.role, "admin");
  assert.equal(record.emailVerified, false);
  assert.equal(record.accountId, record.id);
  assert.equal(record.providerId, "credential");
  assert(record.password !== seedPassword);
  assert(await verifyPassword({ hash: record.password, password: seedPassword }));
  const login = await signIn("seeded@example.test", seedPassword);
  assert.equal(login.status, 200);
  assert.equal((await principal(cookies(login)))?.role, "admin");
  const duplicate = await userCommand(["create", "--email", "seeded@example.test", "--name", "Duplicate", "--role", "viewer", "--password-stdin"], `${seedPassword}\n`);
  assert.equal(duplicate.code, 1);
  assert(!duplicate.stderr.includes(seedPassword));
  assert.equal((await migrator.query('SELECT role FROM auth."user" WHERE id=$1', [record.id])).rows[0].role, "admin");
});

test("CLI password changes, role changes and revocation invalidate existing database sessions", async () => {
  const before = cookies(await signIn());
  const replacement = `${randomUUID()}-replacement`;
  const reset = await userCommand(["set-password", "--email", "viewer@example.test", "--password-stdin"], `${replacement}\n`);
  assert.equal(reset.code, 0);
  assert.equal(reset.stderr, "");
  assert(!reset.stdout.includes(replacement));
  assert.equal(await principal(before), null);
  assert.equal((await signIn()).status, 401);
  const renewed = await signIn("viewer@example.test", replacement);
  assert.equal(renewed.status, 200);
  const changed = await userCommand(["role", "--email", "viewer@example.test", "--role", "admin"]);
  assert.equal(changed.code, 0);
  assert.equal(await principal(cookies(renewed)), null);
  const promoted = await signIn("viewer@example.test", replacement);
  assert.equal(promoted.status, 200);
  assert.equal((await principal(cookies(promoted)))?.role, "admin");
  const revoked = await userCommand(["revoke", "--email", "viewer@example.test"]);
  assert.equal(revoked.code, 0);
  assert.equal(await principal(cookies(promoted)), null);
});

test("the CLI rejects password arguments, malformed input and unknown users without mutations or echoed secrets", async () => {
  const secretArgument = `${randomUUID()}-not-for-argv`;
  const forbidden = await userCommand(["set-password", "--email", "viewer@example.test", "--password", secretArgument]);
  assert.equal(forbidden.code, 1);
  assert(!forbidden.stderr.includes(secretArgument));
  const malformed = await userCommand(["set-password", "--email", "viewer@example.test", "--password-stdin"], "first-line-password\nsecond-line-password\n");
  assert.equal(malformed.code, 1);
  assert(!malformed.stderr.includes("first-line-password"));
  const unknown = await userCommand(["role", "--email", "missing@example.test", "--role", "admin"]);
  assert.equal(unknown.code, 1);
  assert.equal((await signIn()).status, 200);
  assert.equal((await migrator.query('SELECT count(*) FROM auth."user"')).rows[0].count, "2");
});
