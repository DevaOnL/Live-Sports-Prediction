import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { canonicalJson, inputHash } from "../forecast/engine";
import { ForecastStore } from "../forecast/store";
import { JobQueue } from "../ingestion/jobs";
import { REPLAY_COLUMNS, replayRows, type ReplaySnapshot, type ReplayTable, type Row } from "./snapshot";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ownershipLabel = "live-sports-historical-replay";
const database = "historical_replay_demo";

/** Never pass loaded dotenv credentials, PG service settings or Node hooks to children. */
export function isolatedReplayEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const permitted = ["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "SSH_AUTH_SOCK"];
  return { ...Object.fromEntries(permitted.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])), NODE_ENV: "test" };
}

export type ReplayReport = {
  protocol: "historical-arrival-replay-v1"; dataset: "observed-canonical"; mode: "present-cutoff-data-arrival";
  cutoffAt: string; sourceOrdinal: string; sourceDigest: string;
  player: { providerId: string; position: string }; withheldFixtureId: string; withheldKickoffAt: string;
  before: { revisionId: string; inputHash: string; selectedFixtureIds: string[]; historyStatus: "incomplete_history"; forecastStatus: "unavailable" };
  after: { revisionId: string; parentId: string; inputHash: string; selectedFixtureIds: string[]; historyStatus: "ready"; forecastStatus: "available"; forecastRating: number; ratingScale: "0-10";
    target: { fixtureId: string; kickoffAt: string } };
  verified: { sourceReadOnly: true; exactObservationRestored: true; provenanceAndRosterTimesPreserved: true;
    finalMatchesSourceSnapshot: true; queuedRefresh: true; immutableParent: true; idempotentRefresh: true;
    readerWriteDenied: true; noRefreshLoop: true; providerRequests: 0; ownedTemporaryContainerRemoved: true };
};

/** The runner accepts only its private, unmodified in-memory football snapshot. */
export function validateReplaySnapshot(snapshot: ReplaySnapshot): void {
  assert(Number.isFinite(Date.parse(snapshot.cutoffAt)));
  assert.match(snapshot.sourceOrdinal, /^\d{1,20}$/);
  assert.match(snapshot.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(snapshot.tables).sort(), Object.keys(REPLAY_COLUMNS).sort());
  for (const table of Object.keys(REPLAY_COLUMNS) as ReplayTable[]) {
    assert(Array.isArray(snapshot.tables[table]));
    for (const row of snapshot.tables[table]) {
      assert.deepEqual(Object.keys(row).sort(), [...REPLAY_COLUMNS[table]].sort());
      for (const value of Object.values(row)) assert(value === null || typeof value === "string" || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value)));
    }
  }
  const encoded = canonicalJson({ cutoffAt: snapshot.cutoffAt, sourceOrdinal: snapshot.sourceOrdinal, tables: snapshot.tables });
  assert(Buffer.byteLength(encoded) <= 256 * 1024 * 1024);
  assert.equal(createHash("sha256").update(encoded).digest("hex"), snapshot.digest);
  assert.equal(snapshot.plan.beforeSelected.length, 5);
  assert.equal(new Set(snapshot.plan.beforeSelected).size, 5);
  assert.deepEqual(snapshot.plan.afterSelected, [...snapshot.plan.beforeSelected.slice(1), snapshot.plan.sixthFixtureId]);
  assert.equal(snapshot.plan.expectedResult.cutoffAt, snapshot.cutoffAt);
  assert.equal(snapshot.plan.expectedResult.playerId, snapshot.plan.playerId);
  assert.equal(snapshot.plan.expectedResult.status, "available");
  assert(snapshot.tables.appearances.some((row) => canonicalJson(row) === canonicalJson(snapshot.withheldAppearance)));
}

async function insertRows(client: pg.Client | pg.Pool, table: ReplayTable, values: Row[], signal: AbortSignal): Promise<void> {
  const columns = REPLAY_COLUMNS[table].join(",");
  for (let offset = 0; offset < values.length; offset += 250) {
    signal.throwIfAborted();
    await client.query(`INSERT INTO sports.${table} (${columns}) ${table === "normalized_revisions" ? "OVERRIDING SYSTEM VALUE" : ""}
      SELECT ${columns} FROM jsonb_populate_recordset(NULL::sports.${table},$1::jsonb) ${table === "normalized_revisions" ? "ORDER BY ordinal" : ""}`,
    [JSON.stringify(values.slice(offset, offset + 250))]);
  }
}

async function assertCopy(client: pg.PoolClient, snapshot: ReplaySnapshot, withheld: boolean): Promise<void> {
  for (const table of Object.keys(REPLAY_COLUMNS) as ReplayTable[]) {
    const expected = table === "appearances" && withheld
      ? snapshot.tables.appearances.filter((row) => row.id !== snapshot.withheldAppearance.id) : snapshot.tables[table];
    assert.equal(canonicalJson(await replayRows(client, table)), canonicalJson(expected), `Copied ${table} differs from the captured evidence`);
  }
}

/** A fixed-cutoff arrival demonstration. All writes target one newly owned cluster. */
export async function runReplay(snapshot: ReplaySnapshot, signal?: AbortSignal): Promise<ReplayReport> {
  validateReplaySnapshot(snapshot);
  const token = randomBytes(12).toString("hex");
  const name = `lsp-replay-pg-${token}`;
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  signal?.addEventListener("abort", interrupted, { once: true });
  if (signal?.aborted) abort.abort();
  const isolated = isolatedReplayEnvironment(process.env);
  const passwords = Object.fromEntries(["BOOTSTRAP", "READER", "WRITER", "AUTH", "MIGRATOR"].map((role) => [role, randomBytes(24).toString("hex")]));
  Object.assign(isolated, { NODE_ENV: "test", POSTGRES_HOST: "127.0.0.1", POSTGRES_DB: database, POSTGRES_USER: "sports_bootstrap", INGESTION_ENABLED: "false" });
  for (const [role, password] of Object.entries(passwords)) isolated[`POSTGRES_${role}_PASSWORD`] = password;
  let id: string | undefined;
  let creationAttempted = false;
  let administrator: pg.Client | undefined;
  let writer: pg.Pool | undefined;
  let reader: pg.Pool | undefined;
  let report: Omit<ReplayReport, "verified"> | undefined;
  const docker = async (args: string[], environment = isolated, cleanup = false) => (await execute("docker", args, {
    cwd: root, env: environment, timeout: 120_000, maxBuffer: 1_048_576, signal: cleanup ? undefined : abort.signal,
  })).stdout.trim();
  const owned = async (cleanup = false) => {
    const details = JSON.parse(await docker(["inspect", id ?? name], isolated, cleanup)) as {
      Id: string; Config: { Labels: Record<string, string> }; HostConfig: { Tmpfs: Record<string, string>; Binds: unknown[] | null };
    }[];
    assert.equal(details.length, 1);
    assert.equal(details[0].Config.Labels[ownershipLabel], token, "Refusing an unowned container");
    if (id) assert.equal(details[0].Id, id);
    assert(details[0].HostConfig.Tmpfs["/var/lib/postgresql/data"] !== undefined);
    assert.equal(details[0].HostConfig.Binds?.length ?? 0, 0);
    return details[0].Id;
  };
  try {
    abort.signal.throwIfAborted();
    assert.equal(await docker(["info", "--format", "{{.OSType}}"]), "linux");
    creationAttempted = true;
    id = await docker(["run", "--rm", "-d", "--name", name, "--hostname", name, "--label", `${ownershipLabel}=${token}`,
      "--tmpfs", "/var/lib/postgresql/data", "--env", "POSTGRES_DB", "--env", "POSTGRES_USER", "--env", "POSTGRES_PASSWORD",
      "--env", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256", "--publish", "127.0.0.1::5432", "postgres:17-alpine"],
    { ...isolated, POSTGRES_PASSWORD: passwords.BOOTSTRAP });
    assert.match(id, /^[0-9a-f]{64}$/);
    await owned();
    const published = await docker(["port", id, "5432/tcp"]);
    assert.match(published, /^127\.0\.0\.1:\d+$/);
    isolated.POSTGRES_PORT = published.split(":")[1];
    const connection = { host: "127.0.0.1", port: Number(isolated.POSTGRES_PORT), database, options: "-c TimeZone=UTC",
      connectionTimeoutMillis: 3_000, query_timeout: 60_000, statement_timeout: 60_000 };
    for (let attempt = 0; attempt < 90 && !administrator; attempt++) {
      abort.signal.throwIfAborted();
      const client = new pg.Client({ ...connection, user: "sports_bootstrap", password: passwords.BOOTSTRAP });
      client.on("error", interrupted);
      try { await client.connect(); administrator = client; }
      catch { await client.end().catch(() => undefined); await pause(500, undefined, { signal: abort.signal }); }
    }
    assert(administrator, "Isolated PostgreSQL did not become ready");
    const identity = (await administrator.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
      current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
    const expected = await docker(["exec", id, "psql", "-U", "sports_bootstrap", "-d", database, "-Atqc", "SELECT system_identifier::text FROM pg_control_system()"]);
    assert.equal(identity.name, database);
    assert.equal(identity.identifier, expected);
    assert.equal(Math.trunc(Number(identity.version) / 10_000), 17);
    assert.equal((await administrator.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())")).rowCount, 0);
    assert.equal((await administrator.query("SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")).rowCount, 0);
    for (const command of ["provision", "migrate"]) await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), command], {
      cwd: root, env: isolated, timeout: 120_000, maxBuffer: 1_048_576, signal: abort.signal,
    });
    abort.signal.throwIfAborted();
    await administrator.query("BEGIN");
    try {
      for (const table of Object.keys(REPLAY_COLUMNS) as ReplayTable[]) await insertRows(administrator, table,
        table === "appearances" ? snapshot.tables.appearances.filter((row) => row.id !== snapshot.withheldAppearance.id) : snapshot.tables[table], abort.signal);
      await administrator.query("COMMIT");
    } catch (error) { await administrator.query("ROLLBACK").catch(() => undefined); throw error; }
    writer = new pg.Pool({ ...connection, user: "lsp_writer", password: passwords.WRITER, max: 3 });
    reader = new pg.Pool({ ...connection, user: "lsp_reader", password: passwords.READER, max: 1 });
    writer.on("error", interrupted);
    reader.on("error", interrupted);
    const verification = await reader.connect();
    try { await assertCopy(verification, snapshot, true); } finally { verification.release(); }
    const forecasts = new ForecastStore(writer);
    abort.signal.throwIfAborted();
    assert.equal((await forecasts.refresh(snapshot.plan.playerId, snapshot.cutoffAt)).created, 1);
    const before = await forecasts.show(snapshot.plan.playerId);
    assert(before);
    assert.equal(before.result.historyStatus, "incomplete_history");
    assert.equal(before.result.status, "unavailable");
    assert.equal(before.result.forecastRating.status, "unavailable");
    assert(before.result.reasons.some((reason) => reason.code === "missing_appearance_evidence" && reason.fixtureId === snapshot.plan.sixthFixtureId));
    assert.deepEqual(before.result.selected.map((row) => row.fixtureId), snapshot.plan.beforeSelected);
    abort.signal.throwIfAborted();
    // Restore the exact historical observation and provenance, without creating a
    // fake provider archive or pretending it was fetched at this replay time.
    const arrival = await writer.connect();
    try {
      await arrival.query("BEGIN");
      const columns = REPLAY_COLUMNS.appearances.join(",");
      await arrival.query(`INSERT INTO sports.appearances (${columns}) SELECT ${columns}
        FROM jsonb_populate_record(NULL::sports.appearances,$1::jsonb)`, [JSON.stringify(snapshot.withheldAppearance)]);
      await arrival.query(`INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
        VALUES ('canonical.changed','appearance',$1,$2,$3)`, [snapshot.withheldAppearance.id, `replay.observation:${token}`,
      JSON.stringify({ replay: true, fixtureId: snapshot.plan.sixthFixtureId, playerId: snapshot.plan.playerId,
        revisionId: snapshot.withheldAppearance.normalized_revision_id })]);
      await arrival.query("COMMIT");
    } catch (error) { await arrival.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { arrival.release(); }
    const queue = new JobQueue(writer, `historical-replay:${token}`, true);
    abort.signal.throwIfAborted();
    assert.equal(await queue.dispatch(), 1);
    assert.equal(await queue.runForecastOnce(async () => {
      assert.equal((await forecasts.refresh(snapshot.plan.playerId, snapshot.cutoffAt)).created, 1);
    }), true);
    assert.deepEqual(await queue.status(), [{ kind: "forecast.refresh", status: "succeeded", count: "1" }]);
    const after = await forecasts.show(snapshot.plan.playerId);
    assert(after);
    assert.equal(after.parentId, before.id);
    assert.notEqual(after.id, before.id);
    assert.notEqual(after.inputHash, before.inputHash);
    assert.equal(after.sourceOrdinal, snapshot.sourceOrdinal);
    assert.equal(after.inputHash, snapshot.plan.expectedHash);
    assert.equal(inputHash(after.input, after.result), snapshot.plan.expectedHash);
    assert.deepEqual(after.result, snapshot.plan.expectedResult);
    assert.deepEqual(after.result.selected.map((row) => row.fixtureId), snapshot.plan.afterSelected);
    assert(!after.result.selected.some((row) => row.fixtureId === snapshot.plan.beforeSelected[0]));
    assert.equal(after.result.forecastRating.status, "available");
    assert.equal((await forecasts.refresh(snapshot.plan.playerId, snapshot.cutoffAt)).unchanged, 1);
    assert.equal((await forecasts.show(snapshot.plan.playerId))?.id, after.id);
    const unchanged = (await reader.query("SELECT input_hash,result_json,parent_id FROM sports.forecast_revisions WHERE id=$1", [before.id])).rows[0];
    assert.equal(unchanged.input_hash, before.inputHash);
    assert.deepEqual(unchanged.result_json, before.result);
    assert.equal(unchanged.parent_id, null);
    await assert.rejects(writer.query("UPDATE sports.forecast_revisions SET input_hash=input_hash WHERE id=$1", [before.id]), { code: "42501" });
    await assert.rejects(reader.query("DELETE FROM sports.appearances WHERE id=$1", [snapshot.withheldAppearance.id]), { code: "42501" });
    assert.equal(await queue.dispatch(), 0);
    assert.equal(await queue.runForecastOnce(async () => assert.fail("Forecast output must not create another refresh")), false);
    const finalCopy = await reader.connect();
    try { await assertCopy(finalCopy, snapshot, false); } finally { finalCopy.release(); }
    const counts = (await writer.query(`SELECT (SELECT count(*)::int FROM sports.forecast_revisions) AS revisions,
      (SELECT count(*)::int FROM sports.outbox WHERE event_type='forecast.updated') AS notifications,
      (SELECT count(*)::int FROM sports.audit_log WHERE action='forecast.refresh') AS audits,
      (SELECT count(*)::int FROM sports.provider_requests) AS provider_requests`)).rows[0];
    assert.deepEqual(counts, { revisions: 2, notifications: 2, audits: 2, provider_requests: 0 });
    abort.signal.throwIfAborted();
    const restoredFixture = snapshot.tables.fixtures.find((row) => row.provider_id === snapshot.plan.sixthFixtureId);
    assert(restoredFixture && typeof restoredFixture.kickoff_at === "string");
    assert(after.result.target);
    report = { protocol: "historical-arrival-replay-v1", dataset: "observed-canonical", mode: "present-cutoff-data-arrival",
      cutoffAt: snapshot.cutoffAt, sourceOrdinal: snapshot.sourceOrdinal, sourceDigest: snapshot.digest,
      player: { providerId: snapshot.plan.playerId, position: snapshot.plan.position }, withheldFixtureId: snapshot.plan.sixthFixtureId,
      withheldKickoffAt: new Date(restoredFixture.kickoff_at).toISOString(),
      before: { revisionId: before.id, inputHash: before.inputHash, selectedFixtureIds: snapshot.plan.beforeSelected, historyStatus: "incomplete_history", forecastStatus: "unavailable" },
      after: { revisionId: after.id, parentId: after.parentId!, inputHash: after.inputHash, selectedFixtureIds: snapshot.plan.afterSelected, historyStatus: "ready", forecastStatus: "available",
        forecastRating: after.result.forecastRating.value!, ratingScale: "0-10",
        target: { fixtureId: after.result.target.fixtureId, kickoffAt: after.result.target.kickoffAt } } };
  } finally {
    await Promise.allSettled([reader?.end(), writer?.end(), administrator?.end()]);
    let cleanupFailed = false;
    if (creationAttempted) {
      try { const exactId = await owned(true); await docker(["rm", "--force", exactId], isolated, true); }
      catch {
        const remaining = await docker(["ps", "-aq", "--filter", `name=^/${name}$`, "--filter", `label=${ownershipLabel}=${token}`], isolated, true).catch(() => "unknown");
        if (remaining) cleanupFailed = true;
      }
    }
    signal?.removeEventListener("abort", interrupted);
    if (cleanupFailed) throw new Error("Owned replay container cleanup failed");
  }
  assert(report);
  return { ...report, verified: { sourceReadOnly: true, exactObservationRestored: true, provenanceAndRosterTimesPreserved: true,
    finalMatchesSourceSnapshot: true, queuedRefresh: true, immutableParent: true, idempotentRefresh: true,
    readerWriteDenied: true, noRefreshLoop: true, providerRequests: 0, ownedTemporaryContainerRemoved: true } };
}
