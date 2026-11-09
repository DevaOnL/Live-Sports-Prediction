import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { JobQueue } from "../src/server/ingestion/jobs";
import { ProviderError } from "../src/server/ingestion/provider";
import { RateLimitError } from "../src/server/ingestion/store";

type Claim = { id: string; kind: string; payload: unknown; attempts: number; max_attempts: number };
const job = (overrides: Partial<Claim> = {}): Claim => ({
  id: "b540604f-98ce-4167-b08e-a63b7b4147fa", kind: "fixture.statistics",
  payload: { leagueId: "153", fixtureId: "9001" }, attempts: 1, max_attempts: 5, ...overrides,
});

function fixture(row: Claim | null = job()) {
  const queries: { sql: string; values: unknown[] }[] = [];
  let releaseCount = 0;
  let failInsert = false;
  let completionRows = 1;
  const execute = async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes("RETURNING j.id")) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    if (sql.includes("SELECT id,event_type")) return { rows: [
      { id: "event-1", event_type: "fixture.statistics", deduplication_key: "stats:1", payload: { leagueId: "153", fixtureId: "9001" } },
      { id: "event-2", event_type: "standings.rebuild", deduplication_key: "table:1", payload: { leagueId: "164" } },
    ], rowCount: 2 };
    if (sql.includes("INSERT INTO sports.jobs") && failInsert) throw new Error("insert failed");
    if (sql.includes("WHERE id=$1 AND status='running'")) return { rows: [], rowCount: completionRows };
    return { rows: [], rowCount: 1 };
  };
  const pool = {
    query: execute,
    connect: async () => ({ query: execute, release: () => { releaseCount++; } }),
  } as unknown as Pool;
  return {
    queue: new JobQueue(pool, "test-worker"), queries,
    released: () => releaseCount,
    failInsert: () => { failInsert = true; },
    loseLease: () => { completionRows = 0; },
    completion: () => queries.findLast((entry) => entry.sql.includes("WHERE id=$1 AND status='running'")),
  };
}

test("dispatch limits its consumer types and commits publication with job creation", async () => {
  const mock = fixture();
  assert.equal(await mock.queue.dispatch(25), 2);
  const select = mock.queries.find((entry) => entry.sql.includes("SELECT id,event_type"))!;
  assert.match(select.sql, /event_type IN \('fixture.statistics','standings.rebuild','source.sync'\)/);
  assert.match(select.sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(select.values, [25]);
  assert.equal(mock.queries.filter((entry) => entry.sql.includes("INSERT INTO sports.jobs")).length, 2);
  assert.equal(mock.queries.filter((entry) => entry.sql.includes("UPDATE sports.outbox")).length, 2);
  assert.equal(mock.queries.at(-1)?.sql, "COMMIT");
  assert.equal(mock.released(), 1);
  await assert.rejects(mock.queue.dispatch(0), /Invalid dispatch limit/);
  await assert.rejects(mock.queue.dispatch(501), /Invalid dispatch limit/);
});

test("failed dispatch rolls back before acknowledging an outbox record", async () => {
  const mock = fixture();
  mock.failInsert();
  await assert.rejects(mock.queue.dispatch(), /insert failed/);
  assert.equal(mock.queries.at(-1)?.sql, "ROLLBACK");
  assert.equal(mock.queries.some((entry) => entry.sql.includes("UPDATE sports.outbox")), false);
  assert.equal(mock.released(), 1);
});

test("empty queues do not call the handler", async () => {
  const mock = fixture(null);
  assert.equal(await mock.queue.runOnce(async () => assert.fail("no job expected")), false);
  assert.equal(mock.completion(), undefined);
});

test("valid jobs reach the handler with only allowlisted fields and complete under their lease", async () => {
  const mock = fixture();
  let called = false;
  assert.equal(await mock.queue.runOnce(async (item) => {
    called = true;
    assert.deepEqual(item, { id: job().id, kind: "fixture.statistics", payload: { leagueId: "153", fixtureId: "9001" } });
  }), true);
  assert.equal(called, true);
  const claim = mock.queries.find((entry) => entry.sql.includes("RETURNING j.id"))!;
  assert.match(claim.sql, /FOR UPDATE SKIP LOCKED/);
  const completion = mock.completion()!;
  assert.match(completion.sql, /status='succeeded'/);
  assert.match(completion.sql, /locked_until>clock_timestamp\(\)/);
  assert.equal(completion.values[1], claim.values[0]);
});

test("standings jobs accept only the covered league identifier", async () => {
  const mock = fixture(job({ kind: "standings.rebuild", payload: { leagueId: "164" } }));
  await mock.queue.runOnce(async (item) => {
    assert.equal(item.kind, "standings.rebuild");
    assert.deepEqual(item.payload, { leagueId: "164" });
  });
  assert.match(mock.completion()!.sql, /status='succeeded'/);
});

test("source synchronization jobs accept only an empty payload", async () => {
  const mock = fixture(job({ kind: "source.sync", payload: {} }));
  await mock.queue.runOnce(async (item) => {
    assert.deepEqual(item, { id: job().id, kind: "source.sync", payload: {} });
  });
  assert.match(mock.completion()!.sql, /status='succeeded'/);
  const claim = mock.queries.find((entry) => entry.sql.includes("RETURNING j.id"))!;
  assert.match(claim.sql, /'source.sync'/);
});

test("malformed, expanded and secret-bearing job payloads are terminal without executing", async () => {
  const invalid = [
    job({ payload: null }), job({ payload: [] }), job({ payload: { leagueId: "152", fixtureId: "9001" } }),
    job({ payload: { leagueId: "153", fixtureId: "0" } }),
    job({ payload: { leagueId: "153", fixtureId: "9007199254740992" } }),
    job({ payload: { leagueId: "153", fixtureId: "9001", apiKey: "private-value" } }),
    job({ kind: "standings.rebuild", payload: { leagueId: "153", fixtureId: "9001" } }),
    job({ kind: "unknown.consumer", payload: { leagueId: "153" } }),
    job({ kind: "source.sync", payload: { leagueId: "153" } }),
    job({ kind: "source.sync", payload: { apiKey: "private-value" } }),
  ];
  for (const row of invalid) {
    const mock = fixture(row);
    await mock.queue.runOnce(async () => assert.fail("invalid work must not run"));
    assert.deepEqual(mock.completion()!.values.slice(2), ["failed", 0, 0, "invalid_job"]);
  }
});

test("shared budget deferrals restore the attempt even on the final claim", async () => {
  const mock = fixture(job({ attempts: 5 }));
  const before = Date.now();
  await mock.queue.runOnce(async () => { throw new RateLimitError(new Date(Date.now() + 45_000)); });
  const values = mock.completion()!.values;
  assert.deepEqual([values[2], values[3], values[5]], ["ready", 1, "request_budget_exhausted"]);
  assert.ok(Number(values[4]) >= 44_000 - (Date.now() - before));
  assert.ok(Number(values[4]) <= 45_000);
});

test("provider retry dates are bounded and permanent rejection stops immediately", async () => {
  const delayed = fixture();
  await delayed.queue.runOnce(async () => { throw new ProviderError("http_rate_limit", true, new Date(Date.now() + 7_200_000)); });
  assert.deepEqual(delayed.completion()!.values.slice(2), ["ready", 0, 3_600_000, "http_rate_limit"]);
  const rejected = fixture();
  await rejected.queue.runOnce(async () => { throw new ProviderError("http_rejected", false); });
  assert.equal(rejected.completion()!.values[2], "failed");
  assert.equal(rejected.completion()!.values[5], "http_rejected");
});

test("generic failures retry with bounded backoff and never persist error messages", async () => {
  const first = fixture();
  await first.queue.runOnce(async () => { throw new Error("https://example.invalid/?APIkey=private-value"); });
  assert.deepEqual(first.completion()!.values.slice(2), ["ready", 0, 5000, "processing_failed"]);
  assert.equal(JSON.stringify(first.queries).includes("private-value"), false);
  const final = fixture(job({ attempts: 5 }));
  await final.queue.runOnce(async () => { throw new Error("hidden"); });
  assert.deepEqual(final.completion()!.values.slice(2), ["failed", 0, 80_000, "processing_failed"]);
});

test("a lost claim cannot acknowledge success or change another worker's state", async () => {
  const mock = fixture();
  mock.loseLease();
  await assert.rejects(mock.queue.runOnce(async () => undefined), /Job lease was lost/);
  assert.match(mock.completion()!.sql, /locked_by=\$2 AND locked_until>clock_timestamp\(\)/);
});

test("failed-job retry accepts UUIDs only and retains the consumer allowlist", async () => {
  const mock = fixture();
  await assert.rejects(mock.queue.retryFailed("not-a-job"), /Invalid job identifier/);
  assert.equal(mock.queries.length, 0);
  assert.equal(await mock.queue.retryFailed(job().id), true);
  const query = mock.queries.at(-1)!;
  assert.match(query.sql, /attempts=0/);
  assert.match(query.sql, /status='failed' AND kind IN \('fixture.statistics','standings.rebuild','source.sync'\)/);
});

test("statistics refresh excludes unsupported seasons, active work, and repeats in the same time bucket", async () => {
  const mock = fixture();
  assert.equal(await mock.queue.scheduleStatistics(), 1);
  const schedule = mock.queries.find((entry) => entry.sql.includes("WITH candidates AS"))!;
  assert.match(schedule.sql, /c.provider_id IN \('153','164'\) AND c.enabled AND s.enabled AND s.label='2026\/27'/);
  assert.match(schedule.sql, /f.status='live'/);
  assert.match(schedule.sql, /f.status='final'/);
  assert.match(schedule.sql, /statistics_status<>'complete'/);
  assert.match(schedule.sql, /interval '7 days'/);
  assert.match(schedule.sql, /o.published_at IS NULL/);
  assert.match(schedule.sql, /j.status IN \('ready','running'\) OR j.completed_at>=f.bucket_start/);
  assert.match(schedule.sql, /ON CONFLICT \(deduplication_key\) DO NOTHING/);
  assert.equal(mock.queries.at(-1)?.sql, "COMMIT");
});

test("failed job listing exposes bounded operational metadata", async () => {
  const mock = fixture();
  await mock.queue.failures();
  const query = mock.queries.at(-1)!;
  assert.match(query.sql, /SELECT id,kind,attempts,last_error,completed_at/);
  assert.match(query.sql, /status='failed'/);
  assert.match(query.sql, /LIMIT 100/);
  assert.equal(query.sql.includes("payload"), false);
});
