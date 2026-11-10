import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { evaluateForecast, inputHash } from "../src/server/forecast/engine";
import type { SavedForecast } from "../src/server/forecast/store";
import { coverageFor } from "../src/server/ingestion/coverage";
import { normalizeResponse } from "../src/server/ingestion/normalize";
import { reconstructStandings } from "../src/server/ingestion/standings";
import type { ProviderResponse } from "../src/server/ingestion/types";
import { createWebHarness } from "./support/web";
import type { ProviderCommand, ProviderMessage, WorkerFixtures } from "./support/worker-provider";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = createWebHarness();
const clockOrigin = Date.now();
const clockReference = Date.UTC(2026, 10, 10, 12);
type RunningWorker = { child: ChildProcess; messages: ProviderMessage[]; output: string; origin: string };
type Job = { id: string; status: string; attempts: number; locked_until: Date | null; locked_by: string | null };
let worker: RunningWorker | undefined;

async function until<T>(description: string, read: () => Promise<T | null | false>, milliseconds = 20_000): Promise<T> {
  const deadline = Date.now() + milliseconds;
  do {
    const value = await read();
    if (value !== null && value !== false) return value;
    if (worker) assert(worker.child.exitCode === null && worker.child.signalCode === null, "actual worker exited unexpectedly");
    await pause(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function command(message: ProviderCommand) {
  assert(worker && worker.child.connected);
  const current = worker;
  await new Promise<void>((resolve, reject) => current.child.send(message, (error) => error ? reject(error) : resolve()));
  await until("fixture control acknowledgement", async () => current.messages.some((item) => item.type === "ack" && item.token === message.token));
}

async function startWorker(fixtures: WorkerFixtures) {
  const port = await unusedPort();
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, NODE_ENV: "test", WORKER_PORT: String(port), INGESTION_ENABLED: "true",
    POSTGRES_HOST: process.env.POSTGRES_HOST ?? "127.0.0.1", POSTGRES_PORT: process.env.POSTGRES_PORT ?? "5432",
    POSTGRES_DB: process.env.POSTGRES_DB, POSTGRES_WRITER_PASSWORD: process.env.POSTGRES_WRITER_PASSWORD,
    MONGO_HOST: process.env.MONGO_HOST ?? "127.0.0.1", MONGO_PORT: process.env.MONGO_TEST_PORT,
    MONGO_DB: process.env.MONGO_TEST_DATABASE, MONGO_WORKER_USER: process.env.MONGO_WORKER_USER ?? "lsp_ingestion",
    MONGO_WORKER_PASSWORD: process.env.MONGO_WORKER_PASSWORD, APIFOOTBALL_API_KEY: "synthetic-worker-process-only",
    WORKER_FIXTURE_CLOCK_MS: String(clockReference + Date.now() - clockOrigin), LSP_TEST_SOURCE: "legacy",
  };
  assert(!Object.keys(environment).some((key) => /BOOTSTRAP|MIGRATOR|READER|AUTH|SECRET|DATABASE_URL/.test(key)));
  const child = spawn(process.execPath, ["--import", "tsx", "--import", join(root, "tests/support/worker-provider.ts"), join(root, "src/worker/index.ts")], {
    cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  worker = { child, messages: [], output: "", origin: `http://127.0.0.1:${port}` };
  const current = worker;
  child.on("message", (message: ProviderMessage) => { current.messages.push(message); });
  const collect = (chunk: string) => { current.output += chunk; assert(current.output.length < 262_144, "worker output stays bounded"); };
  child.stdout?.setEncoding("utf8").on("data", collect);
  child.stderr?.setEncoding("utf8").on("data", collect);
  await until("test-only provider preload", async () => current.messages.some((message) => message.type === "ready"));
  await command({ type: "configure", token: randomUUID(), fixtures });
  await until("actual worker health listener", async () => {
    try { return (await fetch(`${current.origin}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  });
}

async function stopWorker(signal: "SIGTERM" | "SIGKILL", requireClean = true) {
  if (!worker) return;
  const current = worker;
  if (current.child.exitCode === null && current.child.signalCode === null) {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        current.child.kill("SIGKILL");
        reject(new Error("Actual worker did not stop within its bounded integration deadline"));
      }, 10_000);
      current.child.once("exit", () => { clearTimeout(deadline); resolve(); });
      current.child.kill(signal);
    });
  }
  worker = undefined;
  if (requireClean) {
    if (signal === "SIGTERM") { assert.equal(current.child.exitCode, 0); assert.equal(current.child.signalCode, null); }
    else assert.equal(current.child.signalCode, "SIGKILL");
    assert(!current.messages.some((message) => message.type === "unexpected"), "the fixture preload never delegates or accepts an unexpected source request");
  }
  const secrets = ["synthetic-worker-process-only", ...Object.entries(process.env).filter(([key]) => /PASSWORD|SECRET/.test(key)).map(([, value]) => value)].filter((value): value is string => Boolean(value));
  assert(secrets.every((value) => !current.output.includes(value)), "actual worker logs cannot contain credentials");
}

function sourceStandings(leagueId: string, teams: unknown[], events: Record<string, unknown>[]) {
  const response: ProviderResponse = { action: "get_events", params: { league_id: leagueId, timezone: "UTC" },
    resourceKey: "synthetic-worker-reference", retrievedAt: "2026-11-10T00:00:00Z", text: JSON.stringify(events), contentSha256: "0".repeat(64) };
  const batch = normalizeResponse(response, coverageFor(leagueId));
  const table = reconstructStandings(coverageFor(leagueId), batch.clubs, batch.fixtures, "2026-11-11");
  return table.rows.map((row) => ({ league_id: leagueId, league_year: "2026/27", stage_name: "Regular Season", team_id: row.clubId,
    team_name: (teams as { team_key: string; team_name: string }[]).find((club) => club.team_key === row.clubId)!.team_name,
    overall_league_payed: String(row.played), overall_league_W: String(row.wins), overall_league_D: String(row.draws),
    overall_league_L: String(row.losses), overall_league_GF: String(row.goalsFor), overall_league_GA: String(row.goalsAgainst), overall_league_PTS: String(row.points) }));
}

async function fixtures(): Promise<WorkerFixtures> {
  // These are the harness's synthetic archives, read only after its exact server
  // identity guards and empty-database seeding have succeeded.
  const db = web.mongo.db(process.env.MONGO_TEST_DATABASE);
  const raw = await db.collection("raw_archives").find({ action: { $in: ["get_teams", "get_events"] } }).toArray();
  const teams = JSON.parse(raw.find((record) => record.action === "get_teams")!.text) as unknown[];
  const events = JSON.parse(raw.find((record) => record.action === "get_events")!.text) as Record<string, unknown>[];
  // The reusable demo freezes August 10; this worker test freezes November 10.
  // Preserve its five finalized inputs and move its stale scheduled August
  // target forward within the same approved season.
  for (const event of events) if (event.match_status === "Not Started" && String(event.match_date) <= "2026-11-10") event.match_date = "2026-11-17";
  const otherTeams = Array.from({ length: 18 }, (_, index) => ({ team_key: String(6000 + index), team_name: `Synthetic worker club ${index}`, players: [] }));
  const otherEvents = otherTeams.flatMap((home, homeIndex) => otherTeams.filter((away) => home !== away).map((away) => ({
    match_id: String(990000 + homeIndex * 100 + Number(away.team_key) - 6000), league_id: "164", league_year: "2026/27", stage_name: "Regular Season",
    match_hometeam_id: home.team_key, match_hometeam_name: home.team_name, match_awayteam_id: away.team_key, match_awayteam_name: away.team_name,
    match_date: "2027-01-20", match_time: "15:00", match_status: "Not Started", match_hometeam_score: "", match_awayteam_score: "",
  })));
  const statistics = Object.fromEntries(events.filter((event) => event.player_stats).map((event) => {
    const sides = event.player_stats as Record<string, Record<string, unknown>[]>;
    return [String(event.match_id), { player_statistics: ["home", "away"].flatMap((side) => sides[side].map((row) => ({ ...row, team_name: side, match_id: event.match_id }))) }];
  }));
  return { teams: { "153": teams, "164": otherTeams }, events: { "153": events, "164": otherEvents }, statistics,
    standings: { "153": sourceStandings("153", teams, events), "164": sourceStandings("164", otherTeams, otherEvents) } };
}

async function job(id: string): Promise<Job> {
  const row = (await web.writer.query<Job>("SELECT id,status,attempts,locked_until,locked_by FROM sports.jobs WHERE outbox_id=$1", [id])).rows[0];
  return row;
}

async function enqueue(kind: "fixture.statistics" | "source.sync", payload: object = {}) {
  const row = (await web.writer.query<{ id: string }>(`INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
    SELECT $1,'competition',id,$2,$3 FROM sports.competitions WHERE provider='apifootball' AND provider_id='153' RETURNING id`,
  [kind, `synthetic-worker:${randomUUID()}`, JSON.stringify(payload)])).rows[0];
  assert(row);
  return row.id;
}

async function head(): Promise<SavedForecast> {
  const result = await web.api("players/8001/forecast", { cookie: viewerCookie });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert(body.data.forecast);
  return body.data.forecast;
}
let viewerCookie = "";

async function effectiveCounts() {
  return (await web.writer.query(`SELECT (SELECT count(*)::integer FROM sports.normalized_revisions) AS normalized,
    (SELECT count(*)::integer FROM sports.forecast_revisions) AS forecasts,
    (SELECT count(*)::integer FROM sports.audit_log WHERE action='forecast.refresh') AS audits,
    (SELECT count(*)::integer FROM sports.outbox WHERE event_type='forecast.updated') AS notifications`)).rows[0];
}

async function quiet() {
  await until("initial source synchronization and durable queue completion", async () => {
    const health = await fetch(`${worker!.origin}/health`).then((response) => response.json());
    const active = await web.writer.query("SELECT 1 FROM sports.jobs WHERE status IN ('ready','running') LIMIT 1");
    const pending = await web.writer.query(`SELECT 1 FROM sports.outbox WHERE published_at IS NULL
      AND event_type IN ('fixture.statistics','standings.rebuild','source.sync','canonical.changed','roster.changed','standings.changed') LIMIT 1`);
    return health.sourceState === "synced" && !active.rowCount && !pending.rowCount;
  }, 40_000);
}

test("actual worker imports, refreshes locally during source stalls, renews leases and recovers safely after restart", { timeout: 240_000 }, async (context) => {
  context.after(async () => { try { await stopWorker("SIGTERM", false); } finally { await web.stop(); } });
  await web.start();
  viewerCookie = await web.signIn();
  const synthetic = await fixtures();
  const db = web.mongo.db(process.env.MONGO_TEST_DATABASE);
  const originalRaw = await db.collection("raw_archives").find({}).sort({ _id: 1 }).toArray();
  const originalRevisions = (await web.writer.query("SELECT id,to_jsonb(r) AS record FROM sports.forecast_revisions r ORDER BY ordinal")).rows;
  await startWorker(synthetic);
  await quiet();
  const initial = await head();
  assert.equal(initial.result.selected.length, 5);
  assert.deepEqual(initial.result.selected.map((item) => item.fixtureId), ["900001", "900002", "900003", "900004", "900005"]);
  assert.equal(initial.result.adjustedFormIndex.status, "available", "historical form remains available at the fixed worker clock");
  assert(initial.input.cutoffAt.startsWith("2026-11-10"), "the worker uses the fixed fixture date while lease timers remain real");
  const initialCounts = await effectiveCounts();

  const importRating = async (rating: string, previous: SavedForecast) => {
    await command({ type: "rating", token: randomUUID(), fixtureId: "900005", playerId: "8001", rating });
    const outbox = await enqueue("fixture.statistics", { leagueId: "153", fixtureId: "900005" });
    await until("provider observation job completion", async () => (await job(outbox))?.status === "succeeded");
    const current = await until("SQL changes reaching the authenticated forecast API", async () => {
      const current = await head();
      return current.id !== previous.id && current.result.selected.find((item) => item.fixtureId === "900005")?.rating === Number(rating) ? current : false;
    });
    assert.equal(current.parentId, previous.id);
    assert.deepEqual(current.result, evaluateForecast(current.input));
    assert.equal(current.inputHash, inputHash(current.input, current.result));
    const committed = (await web.writer.query(`SELECT b.archive_id FROM sports.ingestion_batches b JOIN sports.source_revisions s ON s.id=b.source_revision_id
      WHERE s.action='get_statistics' AND s.resource_key LIKE '%900005%' ORDER BY s.retrieved_at DESC LIMIT 1`)).rows[0];
    const marker = await db.collection("import_metadata").findOne({ _id: committed.archive_id });
    assert.equal(marker?.state, "imported");
    const raw = await db.collection("raw_archives").findOne({ _id: committed.archive_id });
    assert(raw && createHash("sha256").update(raw.text).digest("hex") === raw.contentSha256);
    return current;
  };
  const changed = await importRating("8.5", initial);
  assert.notEqual(changed.inputHash, initial.inputHash);
  const restored = await importRating("7.5", changed);
  assert.equal(restored.inputHash, initial.inputHash);
  assert.notEqual(restored.id, initial.id, "A to B to A appends a third immutable revision");
  await quiet();
  const afterCorrections = await effectiveCounts();
  assert.equal(afterCorrections.forecasts, initialCounts.forecasts + 2);
  assert.equal(afterCorrections.audits, initialCounts.audits + 2);
  assert.equal(afterCorrections.notifications, initialCounts.notifications + 2);
  const correctedRaw = await db.collection("raw_archives").find({}).toArray();
  const correctedRevisions = (await web.writer.query("SELECT id,to_jsonb(r) AS record FROM sports.forecast_revisions r ORDER BY ordinal")).rows;

  await command({ type: "hold", token: randomUUID(), action: "get_teams" });
  const sourceSync = await enqueue("source.sync");
  await until("source request stall", async () => worker!.messages.some((message) => message.type === "request" && message.action === "get_teams" && message.held));
  const beforeLocal = await head();
  await web.writer.query("CALL sports.request_forecast_refresh($1)", [randomUUID()]);
  const duringSource = await until("local forecasts advancing independently of blocked source transport", async () => {
    const current = await head();
    return Date.parse(current.evaluation.checkedAt) > Date.parse(beforeLocal.evaluation.checkedAt) ? current : false;
  }, 15_000);
  assert.equal(duringSource.id, restored.id);
  assert.equal((await job(sourceSync)).status, "running", "local refresh completes while provider job remains blocked");
  await command({ type: "release", token: randomUUID() });
  await until("released source sync completion", async () => (await job(sourceSync)).status === "succeeded");
  await quiet();

  // Block real persistence, keeping the real job timer and database lease active.
  await web.administrator.query("SELECT pg_advisory_lock(hashtextextended('lsp:ingestion',0))");
  let leaseJob: Job;
  try {
    const requestId = randomUUID();
    await web.writer.query("CALL sports.request_forecast_refresh($1)", [requestId]);
    leaseJob = await until("forecast claimed before blocked persistence", async () => {
      const row = (await web.writer.query<Job>("SELECT id,status,attempts,locked_until,locked_by FROM sports.jobs WHERE kind='forecast.refresh' AND status='running' ORDER BY created_at DESC LIMIT 1")).rows[0];
      return row ?? false;
    });
    assert(leaseJob.locked_until);
    const initialLease = leaseJob.locked_until.getTime();
    await until("real thirty-second lease renewal during persistence stall", async () => {
      const row = (await web.writer.query<Job>("SELECT id,status,attempts,locked_until,locked_by FROM sports.jobs WHERE id=$1", [leaseJob.id])).rows[0];
      assert.equal(row.status, "running");
      assert.equal(row.locked_by, leaseJob.locked_by);
      return row.locked_until !== null && row.locked_until.getTime() >= initialLease + 20_000;
    }, 40_000);
  } finally { await web.administrator.query("SELECT pg_advisory_unlock(hashtextextended('lsp:ingestion',0))"); }
  await until("renewed lease completion", async () => {
    const row = (await web.writer.query<Job>("SELECT id,status,attempts,locked_until,locked_by FROM sports.jobs WHERE id=$1", [leaseJob!.id])).rows[0];
    return row.status === "succeeded" && row.attempts === 1;
  });
  await quiet();
  assert.deepEqual(await effectiveCounts(), afterCorrections, "unchanged local evaluations do not append effective revisions");

  await command({ type: "hold", token: randomUUID(), action: "get_statistics" });
  const interrupted = await enqueue("fixture.statistics", { leagueId: "153", fixtureId: "900005" });
  await until("claimed provider job before process termination", async () => {
    const row = await job(interrupted);
    return row?.status === "running" && worker!.messages.some((message) => message.type === "request" && message.action === "get_statistics" && message.held);
  });
  await stopWorker("SIGKILL");
  const abandoned = await job(interrupted);
  assert.equal(abandoned.status, "running");
  assert.equal(abandoned.attempts, 1);
  // Only this known job in the identity-guarded disposable cluster is expired.
  await web.writer.query("UPDATE sports.jobs SET locked_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND status='running'", [abandoned.id]);
  const committed = (await web.writer.query("SELECT archive_id FROM sports.ingestion_batches ORDER BY committed_at DESC LIMIT 1")).rows[0];
  await db.collection("import_metadata").updateOne({ _id: committed.archive_id }, { $set: { state: "pending" }, $unset: { result: "" } });
  await startWorker(synthetic);
  await until("expired lease re-claim and process restart recovery", async () => {
    const row = await job(interrupted);
    return row.status === "succeeded" && row.attempts === 2;
  }, 35_000);
  await quiet();
  const marker = await db.collection("import_metadata").findOne({ _id: committed.archive_id });
  assert.equal(marker?.state, "imported");
  assert.equal(marker?.result.duplicate, true, "SQL commit marker repairs lost Mongo metadata without reimporting");
  const recovered = await head();
  assert.equal(recovered.id, restored.id);
  assert.equal(recovered.inputHash, restored.inputHash);
  assert.deepEqual(await effectiveCounts(), afterCorrections, "replay and restarted work do not duplicate effective data or notifications");
  assert.equal((await web.writer.query("SELECT count(*)::integer AS count FROM sports.jobs WHERE status='failed'")).rows[0].count, 0);
  for (const original of [...originalRaw, ...correctedRaw]) assert.deepEqual(await db.collection("raw_archives").findOne({ _id: original._id }), original, "authoritative archived bytes and provenance remain unchanged");
  for (const original of [...originalRevisions, ...correctedRevisions]) {
    const current = (await web.writer.query("SELECT to_jsonb(r) AS record FROM sports.forecast_revisions r WHERE id=$1", [original.id])).rows[0];
    assert.deepEqual(current.record, original.record, "prior immutable forecast explanations remain unchanged");
  }
  assert((await web.writer.query("SELECT count(*)::integer AS count FROM sports.provider_requests")).rows[0].count > 0, "intercepted attempts still exercise the real shared budget");
  const requests = worker!.messages.filter((message) => message.type === "request");
  assert(requests.length > 0, "restarted worker used the intercepted synthetic provider");
  await stopWorker("SIGTERM");
});
