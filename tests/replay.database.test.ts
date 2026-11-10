import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { canonicalJson } from "../src/server/forecast/engine";
import { archiveId } from "../src/server/ingestion/archive";
import { coverageFor } from "../src/server/ingestion/coverage";
import { IngestionStore } from "../src/server/ingestion/store";
import type { Appearance, ArchivedResponse, Batch, Fixture, Player, ProviderAction } from "../src/server/ingestion/types";
import { runReplay } from "../src/server/replay/run";
import { readReplaySnapshot } from "../src/server/replay/snapshot";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId)) {
  throw new Error("Replay tests require NODE_ENV=test, a dedicated _test database and POSTGRES_TEST_CLUSTER_ID from a disposable PostgreSQL 17 cluster.");
}
const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const connection = { host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"), database,
  connectionTimeoutMillis: 5_000, statement_timeout: 60_000 };
const cutoffAt = "2026-11-10T12:00:00.000Z";
const coverage = coverageFor("153");
const clubs = Array.from({ length: 24 }, (_, index) => ({ id: index === 0 ? "3072" : String(5000 + index), name: `Synthetic replay club ${index + 1}` }));
const player: Player = { id: "8001", name: "Synthetic replay forward", position: "FWD" };
let administrator: pg.Client;
let writer: pg.Pool;
let reader: pg.Pool;

// This test-only adapter fixes one returned source-clock field. Every other
// statement, role and read-only transaction runs on the guarded real server.
function syntheticClock(pool: pg.Pool): pg.Pool {
  return new Proxy(pool, { get(target, key) {
    if (key === "connect") return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, property) {
        if (property === "query") return async (sql: string, ...args: unknown[]) => {
          const result = await Reflect.apply(connection.query, connection, [sql, ...args]);
          if (sql.startsWith("SELECT transaction_timestamp() AS cutoff_at,")) result.rows[0].cutoff_at = new Date(cutoffAt);
          return result;
        };
        const value = Reflect.get(connection, property);
        return typeof value === "function" ? value.bind(connection) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

before(async () => {
  administrator = new pg.Client({ ...connection, user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD });
  administrator.on("error", () => undefined);
  await administrator.connect();
  const identity = (await administrator.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(identity.name, database);
  assert.equal(identity.identifier, clusterId, "Refusing an unconfirmed PostgreSQL cluster");
  assert.equal(Math.trunc(Number(identity.version) / 10_000), 17);
  assert.equal((await administrator.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())")).rowCount, 0);
  for (const command of ["provision", "migrate"]) await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), command], {
    cwd: root, timeout: 90_000, maxBuffer: 512_000,
  });
  writer = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD, max: 3 });
  reader = new pg.Pool({ ...connection, user: "lsp_reader", password: process.env.POSTGRES_READER_PASSWORD, max: 1 });
  writer.on("error", () => undefined);
  reader.on("error", () => undefined);
});
after(async () => { await Promise.allSettled([reader?.end(), writer?.end(), administrator?.end()]); });

async function observe(batch: Batch, action: ProviderAction, minute: number): Promise<void> {
  const text = JSON.stringify(batch);
  const source = { action, resourceKey: `synthetic-replay:${action}`, params: { league_id: "153" }, text,
    contentSha256: createHash("sha256").update(text).digest("hex"), retrievedAt: `2026-11-09T12:0${minute}:00.000Z` };
  const archive: ArchivedResponse = { ...source, id: archiveId(source) };
  await new IngestionStore(writer).import(archive, batch);
}

beforeEach(async () => {
  const tables = (await administrator.query("SELECT tablename FROM pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  await administrator.query(`TRUNCATE ${tables.map((row) => `sports.${row.tablename}`).join(",")} RESTART IDENTITY CASCADE`);
  const fixtures: Fixture[] = [];
  for (let home = 0; home < clubs.length; home++) for (let away = 0; away < clubs.length; away++) {
    if (home === away) continue;
    const finished = home === 0 && away <= 6;
    const appearance: Appearance = { player, clubId: clubs[0].id, participation: "played", minutes: away === 1 ? 60 : 97,
      rating: 6 + away / 3, goals: away % 2, assists: 0, shotsOnTarget: away % 3, keyPasses: 1,
      tackles: 1, interceptions: 0, saves: 0, goalsConceded: 0 };
    fixtures.push({ id: String(900000 + home * 100 + away), leagueId: "153", season: "2026/27", home: clubs[home], away: clubs[away],
      kickoffAt: finished ? `2026-09-0${away}T15:00:00.000Z` : home === 0 && away === 7 ? "2026-11-12T15:00:00.000Z" : "2027-01-20T15:00:00.000Z",
      status: finished ? "final" : "scheduled", statisticsStatus: finished ? "complete" : "missing", homeScore: finished ? 2 : null,
      awayScore: finished ? 1 : null, detailed: finished, appearances: finished ? [appearance] : [] });
  }
  const common = { coverage, clubs, players: [player], standings: [], issues: [] };
  await observe({ ...common, fixtures }, "get_events", 0);
  await observe({ ...common, fixtures: [], roster: { complete: true, entries: [{ playerId: player.id, clubId: clubs[0].id }] } }, "get_teams", 1);
});

async function sourceFingerprint(): Promise<string> {
  const tables = (await administrator.query("SELECT tablename FROM pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  const hash = createHash("sha256");
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    const result = await administrator.query(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text,',' ORDER BY to_jsonb(t)::text),'')) AS digest FROM sports.${tablename} t`);
    hash.update(tablename).update(result.rows[0].digest);
  }
  return hash.digest("hex");
}

async function replayContainers(): Promise<string[]> {
  return (await execute("docker", ["ps", "-aq", "--filter", "label=live-sports-historical-replay"], { timeout: 30_000 })).stdout.trim().split("\n").filter(Boolean).sort();
}

test("canonical arrival replay preserves the source, replaces the oldest five member and refreshes through the queue", async () => {
  const original = await sourceFingerprint();
  const containers = await replayContainers();
  const snapshot = await readReplaySnapshot(syntheticClock(reader));
  assert.equal(snapshot.cutoffAt, cutoffAt);
  assert.equal(snapshot.withheldAppearance.minutes, 97);
  assert.deepEqual(snapshot.plan.beforeSelected, ["900001", "900002", "900003", "900004", "900005"]);
  assert.equal(snapshot.tables.roster_snapshots[0].observed_at, "2026-11-09T12:01:00+00:00");
  const report = await runReplay(snapshot);
  assert.deepEqual(report.before.selectedFixtureIds, snapshot.plan.beforeSelected);
  assert.deepEqual(report.after.selectedFixtureIds, ["900002", "900003", "900004", "900005", "900006"]);
  assert.equal(report.before.historyStatus, "incomplete_history");
  assert.equal(report.before.forecastStatus, "unavailable");
  assert.equal(report.after.forecastStatus, "available");
  assert.notEqual(report.before.revisionId, report.after.revisionId);
  assert.equal(report.after.parentId, report.before.revisionId);
  assert.notEqual(report.before.inputHash, report.after.inputHash);
  assert.equal(report.after.inputHash, snapshot.plan.expectedHash);
  assert.equal(report.after.forecastRating, snapshot.plan.expectedResult.forecastRating.value);
  assert(Object.entries(report.verified).every(([key, value]) => key === "providerRequests" ? value === 0 : value === true));
  assert.equal(await sourceFingerprint(), original);
  assert.deepEqual(await replayContainers(), containers);
});

test("a clone constraint failure removes its exact owned temporary container and leaves all source rows untouched", async () => {
  const original = await sourceFingerprint();
  const containers = await replayContainers();
  const snapshot = await readReplaySnapshot(syntheticClock(reader));
  snapshot.tables.fixtures[0].away_club_id = snapshot.tables.fixtures[0].home_club_id;
  snapshot.digest = createHash("sha256").update(canonicalJson({ cutoffAt: snapshot.cutoffAt, sourceOrdinal: snapshot.sourceOrdinal, tables: snapshot.tables })).digest("hex");
  await assert.rejects(runReplay(snapshot));
  assert.equal(await sourceFingerprint(), original);
  assert.deepEqual(await replayContainers(), containers);
});
