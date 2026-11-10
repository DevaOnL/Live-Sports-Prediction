import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { archiveId } from "../src/server/ingestion/archive";
import { EnrichmentStore, type EnrichmentBatch, type EnrichmentMetrics } from "../src/server/ingestion/enrichment-store";
import { CURRENT_SOURCE } from "../src/server/ingestion/sources";
import { IngestionStore, RateLimitError } from "../src/server/ingestion/store";
import type { ArchivedResponse, Batch, Fixture } from "../src/server/ingestion/types";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId)) {
  throw new Error("Enrichment tests require NODE_ENV=test, a dedicated _test database and POSTGRES_TEST_CLUSTER_ID from disposable PostgreSQL 17.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const connection = { host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"),
  database, connectionTimeoutMillis: 5000, statement_timeout: 30000 };
const uuid = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
const coverage = CURRENT_SOURCE.coverage[0];
const clubs = Array.from({ length: 20 }, (_, index) => ({ id: `Club:${uuid(index + 1)}`, slug: `test-club-${index + 1}`, name: `Test club ${index + 1}` }));
const player = { id: `Player:${uuid(1)}`, slug: "test-player", name: "Test player", position: "MID" as const };
let admin: pg.Client;
let pool: pg.Pool;
let reader: pg.Pool;
let ingestion: IngestionStore;
let enrichment: EnrichmentStore;
let observation = 0;

before(async () => {
  admin = new pg.Client({ ...connection, user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD });
  await admin.connect();
  const server = (await admin.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(server.name, database);
  assert.equal(server.identifier, clusterId, "refusing an unconfirmed PostgreSQL cluster");
  assert.equal(Math.trunc(Number(server.version) / 10000), 17);
  assert.equal((await admin.query(`SELECT datname FROM pg_database
    WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())`)).rowCount, 0);
  for (const command of ["provision", "migrate"]) await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), command], {
    cwd: root, timeout: 60000, maxBuffer: 512000,
  });
  pool = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD, max: 12 });
  reader = new pg.Pool({ ...connection, user: "lsp_reader", password: process.env.POSTGRES_READER_PASSWORD });
  ingestion = new IngestionStore(pool, CURRENT_SOURCE);
  enrichment = new EnrichmentStore(pool);
});
after(async () => { await Promise.allSettled([pool?.end(), reader?.end(), admin?.end()]); });
beforeEach(async () => {
  const tables = (await admin.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  await admin.query(`TRUNCATE ${tables.map((row) => `sports.${row.tablename}`).join(",")} RESTART IDENTITY CASCADE`);
  await primary();
});

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return { id: `Game:${uuid(1)}`, leagueId: coverage.id, season: coverage.season, home: clubs[0], away: clubs[1],
    kickoffAt: "2026-11-01T15:00:00.000Z", status: "final", statisticsStatus: "partial", homeScore: 1, awayScore: 0,
    detailed: true, appearances: [{ player, clubId: clubs[0].id, participation: "played", minutes: 90, rating: null,
      goals: 1, assists: 0, shotsOnTarget: 2, keyPasses: null, tackles: null, interceptions: 0, saves: null, goalsConceded: 0 }], ...overrides };
}
async function primary(override: Partial<Fixture> = {}) {
  const value = fixture(override);
  const batch: Batch = { coverage, clubs, players: [...new Map(value.appearances.map((a) => [a.player.id, a.player])).values()],
    fixtures: [value], standings: [], issues: [] };
  const text = JSON.stringify(batch);
  const response = { action: "get_statistics" as const, resourceKey: `sorare:test:${observation++}`,
    params: { provider: "sorare", league_id: coverage.id, match_id: value.id }, text,
    retrievedAt: new Date(Date.parse("2026-11-02T00:00:00Z") + observation * 1000).toISOString(),
    contentSha256: createHash("sha256").update(text).digest("hex") };
  await ingestion.import({ ...response, id: archiveId(response) }, batch);
}
function archive(time = "2026-11-10T12:00:00.000Z", version = "first"): ArchivedResponse {
  const text = JSON.stringify({ synthetic: true, version });
  const response = { action: "get_statistics" as const, resourceKey: "highlightly:box-score:123",
    params: { provider: "highlightly", league_id: coverage.id, match_id: "123" }, text, retrievedAt: time,
    contentSha256: createHash("sha256").update(text).digest("hex") };
  return { ...response, id: archiveId(response) };
}
async function batch(metrics: EnrichmentMetrics = { rating: 7.5, keyPasses: 2, tackles: 4, interceptions: 1 }): Promise<EnrichmentBatch> {
  const row = (await pool.query(`SELECT a.id,a.normalized_revision_id,f.id AS fixture_id,f.normalized_revision_id AS fixture_revision_id
    FROM sports.appearances a JOIN sports.fixtures f ON f.id=a.fixture_id LIMIT 1`)).rows[0];
  return { fixtureId: row.fixture_id, fixtureRevisionId: row.fixture_revision_id, externalFixtureId: "123", observations: [{
    appearanceId: row.id, primaryRevisionId: row.normalized_revision_id, externalPlayerId: "456", evidence: { synthetic: true }, metrics,
  }] };
}
async function effective() { return (await reader.query("SELECT * FROM sports.effective_appearances LIMIT 1")).rows[0]; }

test("supplemented fields and field provenance agree without changing primary facts or explicit zeros", async () => {
  const expected = await batch();
  const result = await enrichment.import(archive(), expected);
  assert.equal(result.activated, 1);
  const base = (await pool.query("SELECT * FROM sports.appearances LIMIT 1")).rows[0];
  assert.equal(base.rating, null); assert.equal(base.key_passes, null); assert.equal(base.tackles, null);
  const row = await effective();
  assert.equal(row.rating, "7.50"); assert.equal(row.key_passes, 2); assert.equal(row.tackles, 4);
  assert.equal(row.interceptions, 0, "an observed primary zero wins over a different supplementary value");
  assert.equal(row.normalized_revision_id, base.normalized_revision_id);
  const reported = (await reader.query("SELECT rating,key_passes,tackles,interceptions FROM sports.player_qualifying_history('sorare',$1,$2)",
    [player.id, "2026-11-11T00:00:00Z"])).rows;
  assert.deepEqual(reported, [{ rating: "7.50", key_passes: 2, tackles: 4, interceptions: 0 }]);
  assert.deepEqual(Object.keys(row.enrichment_provenance).sort(), ["keyPasses", "rating", "tackles"]);
  assert(Object.values(row.enrichment_provenance).every((item) => {
    const value = item as Record<string, unknown>;
    return value.provider === "highlightly" && value.sourceRevisionId === result.sourceRevisionId
      && Date.parse(String(value.observedAt)) === Date.parse(archive().retrievedAt) && uuid(1).length === String(value.revisionId).length;
  }));
  const outbox = (await pool.query("SELECT payload FROM sports.outbox WHERE deduplication_key=$1", [`enrichment:${archive().id}`])).rows;
  assert.deepEqual(outbox.map((event) => event.payload), [{ provider: "sorare", fixtureId: `Game:${uuid(1)}` }]);
  const again = await enrichment.import(archive(), expected);
  assert.equal(again.duplicate, true); assert.equal(again.activated, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sports.appearance_enrichments")).rows[0].count, 1);
});

test("appearance corrections invalidate old supplements until a new capture matches the new primary revision", async () => {
  await enrichment.import(archive(), await batch());
  const changed = fixture(); changed.appearances[0].goals = 2;
  await primary(changed);
  assert.equal((await effective()).rating, null);
  assert.deepEqual((await effective()).enrichment_provenance, {});
  await enrichment.import(archive("2026-11-10T12:01:00Z", "corrected"), await batch());
  assert.equal((await effective()).rating, "7.50");
});

test("fixture corrections also invalidate supplements whose appearance values did not change", async () => {
  await enrichment.import(archive(), await batch());
  const original = (await effective()).normalized_revision_id;
  await primary({ homeScore: 2 });
  const row = await effective();
  assert.equal(row.normalized_revision_id, original);
  assert.equal(row.rating, null); assert.deepEqual(row.enrichment_provenance, {});
});

test("older observations cannot regress heads, missing remappings withdraw them, and equal-time conflicts remain unavailable", async () => {
  const captured = await batch();
  await enrichment.import(archive(), captured);
  await enrichment.import(archive("2026-11-10T11:00:00Z", "older"), { ...captured, observations: captured.observations.map((row) => ({
    ...row, metrics: { ...row.metrics, rating: 5 },
  })) });
  assert.equal((await effective()).rating, "7.50");
  await enrichment.import(archive("2026-11-10T12:00:00Z", "same-time-different"), { ...captured, observations: captured.observations.map((row) => ({
    ...row, metrics: { ...row.metrics, rating: 6 },
  })) });
  assert.equal((await effective()).rating, null);
  await enrichment.import(archive("2026-11-10T12:01:00Z", "newer"), captured);
  assert.equal((await effective()).rating, "7.50");
  await enrichment.import(archive("2026-11-10T12:02:00Z", "mapping-absent"), { ...captured, observations: [] });
  assert.equal((await effective()).rating, null);
  assert.equal((await effective()).key_passes, null);
  assert.deepEqual((await effective()).enrichment_provenance, {});
});

test("wrong scope, mismatched anchors and malformed counts fail without committing source receipts", async () => {
  const captured = await batch();
  const originalSources = (await pool.query("SELECT count(*)::int AS count FROM sports.source_revisions")).rows[0].count;
  await assert.rejects(enrichment.import({ ...archive(), text: "wrong hash" }, captured), /hash mismatch/);
  const wrongLeague = archive(); wrongLeague.params.league_id = CURRENT_SOURCE.coverage[1].id;
  await assert.rejects(enrichment.import(wrongLeague, captured), /fixture/);
  const future = archive(new Date(Date.now() + 60000).toISOString(), "future");
  await assert.rejects(enrichment.import(future, captured), /database clock/);
  await assert.rejects(enrichment.import(archive(), { ...captured, fixtureRevisionId: uuid(999) }), /fixture/);
  await assert.rejects(enrichment.import(archive(), { ...captured, observations: [{ ...captured.observations[0], primaryRevisionId: uuid(999) }] }), /appearance/);
  await assert.rejects(enrichment.import(archive(), { ...captured, observations: [{ ...captured.observations[0], metrics: {
    ...captured.observations[0].metrics, keyPasses: false as unknown as number,
  } }] }), /count/);
  await assert.rejects(enrichment.import(archive(), { ...captured, observations: [{ ...captured.observations[0], metrics: {
    ...captured.observations[0].metrics, rating: 7.555,
  } }] }), /rating/);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sports.source_revisions")).rows[0].count, originalSources);
});

test("runtime can append observations and move heads, while readers cannot access identity evidence or mutate facts", async () => {
  await enrichment.import(archive(), await batch());
  await assert.rejects(pool.query("UPDATE sports.appearance_enrichments SET rating=1"), { code: "42501" });
  await assert.rejects(pool.query("DELETE FROM sports.appearance_enrichments"), { code: "42501" });
  await assert.rejects(reader.query("SELECT evidence_json FROM sports.appearance_enrichments"), { code: "42501" });
  await assert.rejects(reader.query("UPDATE sports.effective_appearances SET rating=1"));
  assert.equal((await effective()).rating, "7.50");
});

test("daily shared reservations honor prior setup usage, pacing and the safety allowance", async () => {
  await enrichment.observeQuota(90);
  await enrichment.observeQuota(100);
  assert.equal((await pool.query("SELECT remaining FROM sports.enrichment_request_quota")).rows[0].remaining, 90);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => enrichment.reserveRequest("get_statistics", `highlightly:test:${index}`)));
  const accepted = results.filter((row) => row.status === "fulfilled").length;
  assert(accepted >= 1);
  assert(results.filter((row) => row.status === "rejected").every((row) => row.reason instanceof RateLimitError));
  const spacing = (await pool.query(`SELECT extract(epoch FROM attempted_at-lag(attempted_at) OVER(ORDER BY attempted_at))*1000 AS ms
    FROM sports.provider_requests WHERE resource_key LIKE 'highlightly:%'`)).rows;
  assert.equal(spacing.length, accepted);
  assert(spacing.every((row) => row.ms === null || Number(row.ms) >= 1000));
  assert.equal((await pool.query("SELECT remaining FROM sports.enrichment_request_quota")).rows[0].remaining, 90 - accepted);
  await enrichment.observeQuota(5);
  await admin.query("UPDATE sports.provider_requests SET attempted_at=clock_timestamp()-interval '2 seconds'");
  await assert.rejects(enrichment.reserveRequest("get_statistics", "highlightly:test:exhausted"), (error: unknown) => {
    if (!(error instanceof RateLimitError)) return false;
    const reset = error.retryAt;
    return reset.getUTCHours() === 0 && reset.getUTCMinutes() === 0 && reset.getTime() > Date.now();
  });
  await assert.rejects(enrichment.reserveRequest("get_statistics", "sorare:wrong"), /namespace/);
});

test("schedule receipts preserve source evidence and are idempotent without changing canonical fixtures", async () => {
  const response = archive();
  response.action = "get_events"; response.resourceKey = "highlightly:schedule:premier-league-gb-eng";
  response.params = { provider: "highlightly", league_id: coverage.id, format: "highlightly-schedule-v1" };
  response.id = archiveId(response);
  const first = await enrichment.recordSchedule(response);
  assert.equal(first.duplicate, false); assert.equal(first.fixtures, 0); assert.equal(first.appearances, 0);
  assert.equal((await enrichment.recordSchedule(response)).duplicate, true);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sports.fixtures")).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sports.appearance_enrichments")).rows[0].count, 0);
});

test("a newer accepted contradictory schedule withholds old supplements without changing source observations", async () => {
  const captured = await batch();
  await enrichment.import(archive(), captured);
  const schedule = archive("2026-11-10T12:01:00Z", "changed-source-header");
  schedule.action = "get_events"; schedule.resourceKey = "highlightly:schedule:premier-league-gb-eng";
  schedule.params = { provider: "highlightly", league_id: coverage.id, format: "highlightly-schedule-v1" };
  schedule.id = archiveId(schedule);
  await assert.rejects(enrichment.invalidateFixture(schedule, captured.fixtureId, "123"), /receipt/);
  await enrichment.recordSchedule(schedule);
  assert.equal(await enrichment.invalidateFixture(schedule, captured.fixtureId, "123"), 1);
  assert.equal((await effective()).rating, null);
  assert.deepEqual((await effective()).enrichment_provenance, {});
  assert.equal((await pool.query("SELECT rating FROM sports.appearance_enrichments")).rows[0].rating, "7.50");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sports.audit_log WHERE action='enrichment.invalidate'")).rows[0].count, 1);
  assert.equal(await enrichment.invalidateFixture(schedule, captured.fixtureId, "123"), 0);
  await enrichment.import(archive("2026-11-10T12:00:30Z", "pending-before-header-correction"), captured);
  assert.equal((await effective()).rating, null, "recovery of an earlier capture cannot undo a later known source-header contradiction");
  await enrichment.import(archive("2026-11-10T12:02:00Z", "reconfirmed-source-header"), captured);
  assert.equal((await effective()).rating, "7.50");
  assert.equal(await enrichment.invalidateFixture(schedule, captured.fixtureId, "123"), 0, "an old schedule cannot invalidate a newer statistical observation");
  const wrongLeague = { ...schedule, params: { ...schedule.params, league_id: CURRENT_SOURCE.coverage[1].id } };
  await assert.rejects(enrichment.invalidateFixture(wrongLeague, captured.fixtureId, "123"), /scope/);
});

test("a fresh remapped fixture identifier withdraws older mappings absent from its complete capture", async () => {
  const captured = await batch();
  await enrichment.import(archive(), captured);
  const rekeyed = archive("2026-11-10T12:01:00Z", "provider-fixture-rekeyed");
  rekeyed.params.match_id = "124"; rekeyed.resourceKey = "highlightly:box-score:124"; rekeyed.id = archiveId(rekeyed);
  await enrichment.import(rekeyed, { ...captured, externalFixtureId: "124", observations: [] });
  assert.equal((await effective()).rating, null);
  assert.equal((await effective()).key_passes, null);
});

test("cached remapping appends newly resolved identities with the original source and observation time exactly once", async () => {
  const response = archive();
  const captured = await batch();
  await assert.rejects(enrichment.reprocess(response, captured), /original accepted source receipt/);
  const imported = await enrichment.import(response, { ...captured, observations: [] });
  const originalSources = (await pool.query("SELECT * FROM sports.source_revisions ORDER BY id")).rows;
  const originalReceipts = (await pool.query("SELECT * FROM sports.ingestion_batches ORDER BY archive_id")).rows;
  const originalPrimary = (await pool.query("SELECT * FROM sports.appearances ORDER BY id")).rows;
  const result = await enrichment.reprocess(response, captured);
  assert.equal(result.duplicate, false); assert.equal(result.appearances, 1); assert.equal(result.activated, 1);
  assert.equal(result.sourceRevisionId, imported.sourceRevisionId);
  const stored = (await pool.query("SELECT * FROM sports.appearance_enrichments")).rows[0];
  assert.equal(stored.source_revision_id, imported.sourceRevisionId);
  assert.equal(stored.retrieved_at.toISOString(), response.retrievedAt);
  assert.equal(Date.parse((await effective()).enrichment_provenance.rating.observedAt), Date.parse(response.retrievedAt));
  const receipt = (await pool.query(`SELECT * FROM sports.normalized_revisions
    WHERE entity_type='appearance_enrichment_mapping'`)).rows[0];
  assert.equal(receipt.entity_key, `${response.id}:name-entities-v2`);
  assert.equal(receipt.source_revision_id, imported.sourceRevisionId);
  const audit = (await pool.query("SELECT * FROM sports.audit_log WHERE action='enrichment.reprocess'")).rows[0];
  assert.equal(audit.normalized_revision_id, receipt.id);
  assert.equal(audit.detail.observedAt, response.retrievedAt);
  assert.equal(audit.detail.appearances, 1);
  const repeated = await Promise.all([enrichment.reprocess(response, captured), enrichment.reprocess(response, captured)]);
  assert(repeated.every((row) => row.duplicate && row.appearances === 0 && row.activated === 0));
  assert.deepEqual((await pool.query("SELECT * FROM sports.source_revisions ORDER BY id")).rows, originalSources);
  assert.deepEqual((await pool.query("SELECT * FROM sports.ingestion_batches ORDER BY archive_id")).rows, originalReceipts);
  assert.deepEqual((await pool.query("SELECT * FROM sports.appearances ORDER BY id")).rows, originalPrimary);
  assert.deepEqual((await pool.query("SELECT * FROM sports.appearance_enrichments")).rows, [stored]);
  assert.deepEqual((await pool.query("SELECT * FROM sports.normalized_revisions WHERE entity_type='appearance_enrichment_mapping'")).rows, [receipt]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sports.audit_log WHERE action='enrichment.reprocess'")).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sports.outbox WHERE deduplication_key=$1",
    [`enrichment-reprocess:${response.id}:name-entities-v2`])).rows[0].count, 1);
  assert.equal((await enrichment.import(response, captured)).appearances, 0, "ordinary import keeps its original immutable receipt");
});

test("cached remapping preserves accepted values and never withdraws or reassigns an existing identity", async () => {
  const value = fixture();
  value.appearances.push({ ...value.appearances[0], player: { ...player, id: `Player:${uuid(2)}`, slug: "second-player", name: "Second player" } });
  await primary(value);
  const captured = await batch();
  const rows = (await pool.query(`SELECT a.id,a.normalized_revision_id FROM sports.appearances a
    JOIN sports.players p ON p.id=a.player_id ORDER BY p.provider_id`)).rows;
  captured.observations = rows.map((row, index) => ({ ...captured.observations[0], appearanceId: row.id,
    primaryRevisionId: row.normalized_revision_id, externalPlayerId: String(456 + index) }));
  const response = archive();
  const initial = await enrichment.import(response, { ...captured, observations: [captured.observations[0]] });
  const old = (await pool.query("SELECT * FROM sports.appearance_enrichments WHERE source_revision_id=$1", [initial.sourceRevisionId])).rows[0];
  await assert.rejects(enrichment.reprocess(response, { ...captured, observations: [{
    ...captured.observations[1], externalPlayerId: captured.observations[0].externalPlayerId,
  }] }), /contradicts an accepted player identity/);
  const changed = { ...captured.observations[0], metrics: { ...captured.observations[0].metrics, rating: 1 } };
  const result = await enrichment.reprocess(response, { ...captured, observations: [changed, captured.observations[1]] });
  assert.equal(result.appearances, 1); assert.equal(result.activated, 1);
  assert.deepEqual((await pool.query("SELECT * FROM sports.appearance_enrichments WHERE id=$1", [old.id])).rows, [old]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sports.appearance_enrichments WHERE source_revision_id=$1", [initial.sourceRevisionId])).rows[0].count, 2);
  assert.equal((await reader.query("SELECT rating FROM sports.effective_appearances WHERE id=$1", [old.appearance_id])).rows[0].rating, "7.50");
  assert.equal((await pool.query("SELECT appearance_count FROM sports.ingestion_batches WHERE archive_id=$1", [response.id])).rows[0].appearance_count, 1);
});

test("cached remapping rejects stale primary anchors and cannot regress a newer effective observation", async () => {
  const captured = await batch();
  const response = archive();
  await enrichment.import(response, { ...captured, observations: [] });
  await assert.rejects(enrichment.reprocess(response, { ...captured, fixtureRevisionId: uuid(999) }), /fixture/);
  await assert.rejects(enrichment.reprocess(response, { ...captured, observations: [{
    ...captured.observations[0], primaryRevisionId: uuid(999),
  }] }), /appearance/);
  const newer = archive("2026-11-10T12:01:00Z", "newer-resolved-name");
  await enrichment.import(newer, { ...captured, observations: [{ ...captured.observations[0],
    metrics: { ...captured.observations[0].metrics, rating: 8 },
  }] });
  const head = (await pool.query("SELECT * FROM sports.appearance_enrichment_heads")).rows[0];
  const result = await enrichment.reprocess(response, captured);
  assert.equal(result.appearances, 1); assert.equal(result.activated, 0);
  assert.equal((await effective()).rating, "8.00");
  assert.deepEqual((await pool.query("SELECT * FROM sports.appearance_enrichment_heads")).rows, [head]);
  await primary({ homeScore: 2 });
  await assert.rejects(enrichment.reprocess(response, captured), /fixture/);
});

test("cached remapping cannot clear a later header contradiction", async () => {
  const captured = await batch();
  const old = archive();
  await enrichment.import(old, { ...captured, observations: [] });
  await enrichment.import(archive("2026-11-10T12:00:30Z", "resolved-earlier-than-header"), captured);
  const schedule = archive("2026-11-10T12:01:00Z", "header-correction");
  schedule.action = "get_events"; schedule.resourceKey = "highlightly:schedule:premier-league-gb-eng";
  schedule.params = { provider: "highlightly", league_id: coverage.id, format: "highlightly-schedule-v1" };
  schedule.id = archiveId(schedule);
  await enrichment.recordSchedule(schedule);
  await enrichment.invalidateFixture(schedule, captured.fixtureId, "123");
  const result = await enrichment.reprocess(old, captured);
  assert.equal(result.activated, 0);
  assert.equal((await effective()).rating, null);
  assert.equal((await pool.query("SELECT conflicted FROM sports.appearance_enrichment_heads")).rows[0].conflicted, true);
});

test("newly mapped cached values at an equal observation time preserve genuine conflicts", async () => {
  const captured = await batch();
  const response = archive();
  await enrichment.import(response, { ...captured, observations: [] });
  await enrichment.import(archive(response.retrievedAt, "resolved-at-same-time"), captured);
  const conflict = await enrichment.reprocess(response, { ...captured, observations: [{ ...captured.observations[0],
    metrics: { ...captured.observations[0].metrics, rating: 3 },
  }] });
  assert.equal(conflict.appearances, 1);
  assert.equal((await pool.query("SELECT conflicted FROM sports.appearance_enrichment_heads")).rows[0].conflicted, true);
  assert.equal((await effective()).rating, null);
});

test("an explicit zero reserve can use the last five requests without exceeding the shared hard daily allowance", async () => {
  for (const reserve of [-1, 6, 0.5, Number.NaN]) assert.throws(() => new EnrichmentStore(pool, reserve), /reserve/);
  const bounded = new EnrichmentStore(pool, 0);
  await enrichment.observeQuota(5);
  await assert.rejects(enrichment.reserveRequest("get_statistics", "highlightly:test:default-reserve"), RateLimitError);
  for (let index = 0; index < 5; index++) {
    await admin.query("UPDATE sports.provider_requests SET attempted_at=clock_timestamp()-interval '2 seconds'");
    await bounded.reserveRequest("get_statistics", `highlightly:test:bounded:${index}`);
    if (index < 4) await assert.rejects(bounded.reserveRequest("get_statistics", `highlightly:test:too-fast:${index}`), RateLimitError);
  }
  assert.equal((await pool.query("SELECT remaining FROM sports.enrichment_request_quota")).rows[0].remaining, 0);
  await admin.query("UPDATE sports.provider_requests SET attempted_at=clock_timestamp()-interval '2 seconds'");
  await bounded.observeQuota(100);
  await assert.rejects(bounded.reserveRequest("get_statistics", "highlightly:test:no-remaining"), RateLimitError);
  await admin.query("UPDATE sports.enrichment_request_quota SET remaining=100");
  await admin.query(`INSERT INTO sports.provider_requests(action,resource_key,attempted_at)
    SELECT 'get_statistics','highlightly:test:already-used:'||item,clock_timestamp()-interval '2 seconds' FROM generate_series(1,95) item`);
  await assert.rejects(bounded.reserveRequest("get_statistics", "highlightly:test:hard-cap"), RateLimitError);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sports.provider_requests WHERE resource_key LIKE 'highlightly:%'")).rows[0].count, 100);
});
