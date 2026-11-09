import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { createWebHarness } from "./support/web";

const web = createWebHarness();
const { api, signIn, password, viewerId, adminId } = web;
before(web.start);
beforeEach(web.resetAuth);
after(web.stop);

test("built application exposes liveness and login while all product/admin reads require a session", async () => {
  const health = await api("health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).features.authentication, true);
  assert.equal((await fetch(`${web.origin}/login`)).status, 200);
  assert.equal((await fetch(`${web.origin}/account`, { redirect: "manual" })).headers.get("location"), "/login");
  for (const path of ["me", "overview", "competitions", "clubs", "players", "players/8001", "players/8001/forecast", "compare?playerId=8001&playerId=8002", "admin/status", "admin/jobs", "admin/imports", "admin/audit"]) {
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
  const account = await fetch(`${web.origin}/account`, { headers: { cookie } });
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
  const before = (await web.administrator.query("SELECT count(*)::integer AS count FROM sports.audit_log")).rows[0].count;
  for (const path of ["admin/imports", "admin/statistics", "admin/forecasts/refresh", `admin/jobs/${randomUUID()}/retry`]) {
    assert.equal((await api(path, { method: "POST", cookie, body: { requestId: randomUUID(), role: "admin" }, headers: { "x-role": "admin" } })).status, 403);
  }
  assert.equal((await api("admin/appearances", { method: "PATCH", cookie, body: { role: "admin" } })).status, 403);
  assert.equal((await api("admin/audit", { cookie, headers: { "x-user-role": "admin" } })).status, 403);
  assert.equal((await api("admin/imports", { cookie, headers: { "x-user-role": "admin" } })).status, 403);
  assert.equal((await web.administrator.query("SELECT count(*)::integer AS count FROM sports.audit_log")).rows[0].count, before);
  assert.equal((await api("auth/sign-in/email", { method: "POST", body: { email: "viewer@example.test", password, role: "admin" } })).status, 400);
  assert.equal((await api("me", { cookie: cookie.replace("lsp.session_token=", "lsp.session_token=forged") })).status, 401);
});

test("canonical origin, host, strict bodies and route allowlists protect real HTTP mutations", async () => {
  const cookie = await signIn("admin");
  for (const path of ["auth/sign-up/email", "auth/reset-password", "auth/callback/provider", "auth/update-user"]) {
    assert.equal((await api(path, { method: "POST", cookie, body: {} })).status, 404);
  }
  assert.equal((await api("admin/imports", { method: "POST", cookie, body: { requestId: randomUUID() }, headers: { origin: "https://foreign.example" } })).status, 403);
  const missingOrigin = await fetch(`${web.origin}/api/admin/imports`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ requestId: randomUUID() }) });
  assert.equal(missingOrigin.status, 403);
  const untrustedHost = await new Promise<number | undefined>((resolve, reject) => {
    const incoming = httpRequest(`${web.origin}/api/me`, { headers: { cookie, host: "foreign.example", "x-forwarded-host": new URL(web.origin).host } }, (result) => {
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
  await web.administrator.query('UPDATE auth."user" SET role=\'viewer\' WHERE id=$1', [adminId]);
  assert.equal((await api("admin/status", { cookie })).status, 403);
  assert.equal((await (await api("me", { cookie })).json()).data.role, "viewer");
  await web.administrator.query('DELETE FROM auth.session WHERE "userId"=$1', [adminId]);
  assert.equal((await api("me", { cookie })).status, 401);
  const expired = await signIn();
  await web.administrator.query('UPDATE auth.session SET "createdAt"=clock_timestamp()-interval \'2 hours\',"expiresAt"=clock_timestamp()-interval \'1 hour\' WHERE "userId"=$1', [viewerId]);
  assert.equal((await api("me", { cookie: expired })).status, 401);
});

test("successful logout revokes the database session and storage failure never reports success", async () => {
  const cookie = await signIn();
  await web.administrator.query('REVOKE DELETE ON auth.session FROM lsp_auth');
  try {
    const failed = await api("auth/sign-out", { method: "POST", cookie, body: {} });
    assert.equal(failed.status, 503);
    assert.equal((await web.administrator.query('SELECT count(*)::integer AS count FROM auth.session WHERE "userId"=$1', [viewerId])).rows[0].count, 1);
    assert.equal((await api("me", { cookie })).status, 200);
  } finally { await web.administrator.query('GRANT DELETE ON auth.session TO lsp_auth'); }
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
  assert.equal((await web.administrator.query("SELECT count(*)::integer AS count FROM sports.outbox WHERE event_type='source.sync'")).rows[0].count, 1);
  const player = (await (await api("players/8001", { cookie })).json()).data;
  const appearance = player.observedAppearances.find((row: { fixtureId: string }) => row.fixtureId === "900005");
  assert.equal(appearance.membershipKnown, true);
  assert.match(appearance.revisionId, /^[0-9a-f-]{36}$/i);
  const current = appearance.revisionId;
  const correction = { requestId: randomUUID(), playerId: "8001", fixtureId: "900005", expectedRevisionId: current,
    reason: "Synthetic HTTP correction verification", changes: { rating: 8.25, saves: 0 } };
  const result = await api("admin/appearances", { method: "PATCH", cookie, body: correction });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.data.provider, "manual");
  assert.equal(body.data.providerMaySupersede, true);
  assert.deepEqual(await (await api("admin/appearances", { method: "PATCH", cookie, body: correction })).json(), body);
  assert.equal((await api("admin/appearances", { method: "PATCH", cookie, body: { ...correction, requestId: randomUUID() } })).status, 409);
  const reloaded = (await (await api("players/8001", { cookie })).json()).data.observedAppearances
    .find((row: { fixtureId: string }) => row.fixtureId === "900005");
  assert.equal(reloaded.revisionId, body.data.revisionId);
  assert.notEqual(reloaded.revisionId, current);
  const fresh = await api("admin/appearances", { method: "PATCH", cookie, body: {
    ...correction, requestId: randomUUID(), expectedRevisionId: reloaded.revisionId, changes: { rating: 8.5 },
  } });
  assert.equal(fresh.status, 200);
  assert.equal((await fresh.json()).data.previousRevisionId, reloaded.revisionId);
  const audit = (await web.administrator.query("SELECT actor_type,actor_id,detail FROM sports.audit_log WHERE id=$1", [correction.requestId])).rows[0];
  assert.equal(audit.actor_type, "user");
  assert.equal(audit.actor_id, adminId);
  const visible = await api("admin/audit?pageSize=5", { cookie });
  assert.equal(visible.status, 200);
  assert.equal((await web.administrator.query("SELECT count(*)::integer AS count FROM sports.provider_requests")).rows[0].count, 0);
});

test("administrator import reads bound pagination and expose only safe validation summaries", async () => {
  const cookie = await signIn("admin");
  for (const query of ["page=0", "pageSize=101", "page=1&page=2", "archiveId=anything"]) {
    assert.equal((await api(`admin/imports?${query}`, { cookie })).status, 400);
  }
  const stored = (await web.administrator.query("SELECT archive_id,source_revision_id,issues_json FROM sports.ingestion_batches ORDER BY committed_at DESC,archive_id DESC LIMIT 1")).rows[0];
  const sentinel = "synthetic-private-detail-do-not-return";
  const issues = [
    { code: "missing_metric", resource: "fixture:900005", message: sentinel },
    ...Array.from({ length: 52 }, () => ({ code: sentinel, resource: `https://provider.invalid/?key=${sentinel}`, message: sentinel })),
  ];
  await web.administrator.query("UPDATE sports.ingestion_batches SET issues_json=$1::jsonb WHERE archive_id=$2", [JSON.stringify(issues), stored.archive_id]);
  try {
    const response = await api("admin/imports?pageSize=1", { cookie });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert(!text.includes(sentinel) && !text.includes(stored.archive_id));
    const result = JSON.parse(text).data;
    assert.equal(result.page, 1);
    assert.equal(result.pageSize, 1);
    assert(result.total >= 4);
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.deepEqual(Object.keys(item).sort(), ["action", "committedAt", "counts", "id", "issueTotal", "issues", "issuesTruncated", "retrievedAt"].sort());
    assert.equal(item.id, stored.source_revision_id);
    assert.equal(item.issueTotal, 53);
    assert.equal(item.issuesTruncated, true);
    assert.equal(item.issues.length, 50);
    assert.deepEqual(item.issues[0], { code: "missing_metric", resource: "fixture:900005" });
    assert.deepEqual(item.issues[1], { code: "validation_issue", resource: "unavailable" });
    assert(item.issues.every((issue: Record<string, unknown>) => Object.keys(issue).sort().join(",") === "code,resource"));
  } finally {
    await web.administrator.query("UPDATE sports.ingestion_batches SET issues_json=$1::jsonb WHERE archive_id=$2", [JSON.stringify(stored.issues_json), stored.archive_id]);
  }
});
