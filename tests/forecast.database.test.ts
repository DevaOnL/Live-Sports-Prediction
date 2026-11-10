import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { archiveId } from "../src/server/ingestion/archive";
import { coverageFor } from "../src/server/ingestion/coverage";
import { IngestionStore } from "../src/server/ingestion/store";
import { JobQueue } from "../src/server/ingestion/jobs";
import type { Appearance, ArchivedResponse, Batch, Fixture, Player } from "../src/server/ingestion/types";
import { inputHash, selectObservedWindow } from "../src/server/forecast/engine";
import { prepareHistoricalInputs, prepareInputs, prepareObservedInputs } from "../src/server/forecast/inputs";
import { ForecastStore } from "../src/server/forecast/store";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId)) {
  throw new Error("Forecast tests require NODE_ENV=test, a dedicated _test database and POSTGRES_TEST_CLUSTER_ID from a disposable PostgreSQL 17 cluster.");
}
const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const connection = {
  host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"), database,
  connectionTimeoutMillis: 5_000, statement_timeout: 60_000,
};
const coverage = coverageFor("153");
const clubs = Array.from({ length: 24 }, (_, index) => ({ id: index === 0 ? "3072" : String(5000 + index), name: `Forecast club ${index + 1}` }));
const players: Player[] = (["GK", "DEF", "MID", "FWD"] as const).map((position, index) => ({ id: String(8001 + index), name: `Forecast ${position}`, position }));
const cutoff = "2026-08-10T12:00:00.000Z";
let admin: pg.Client;
let pool: pg.Pool;
let ingestion: IngestionStore;
let forecasts: ForecastStore;
let schedule: Fixture[];
let observation = 0;

before(async () => {
  admin = new pg.Client({ ...connection, user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD });
  await admin.connect();
  const server = (await admin.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(server.name, database);
  assert.equal(server.identifier, clusterId, "refusing an unconfirmed PostgreSQL cluster");
  assert.equal(Math.trunc(Number(server.version) / 10_000), 17);
  assert.equal((await admin.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())")).rowCount, 0);
  for (const command of ["provision", "migrate"]) await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), command], {
    cwd: root, timeout: 60_000, maxBuffer: 512_000,
  });
  pool = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD, max: 6 });
  ingestion = new IngestionStore(pool);
  forecasts = new ForecastStore(pool);
});
after(async () => { await Promise.allSettled([pool?.end(), admin?.end()]); });

function appearance(player: Player, overrides: Partial<Appearance> = {}): Appearance {
  return { player, clubId: clubs[0].id, participation: "played", minutes: 97, rating: 7.5,
    goals: 1, assists: 0, shotsOnTarget: 2, keyPasses: 1, tackles: 2, interceptions: 1,
    saves: 4, goalsConceded: 1, ...overrides };
}
function fixture(home: number, away: number): Fixture {
  return schedule.find((item) => item.home.id === clubs[home].id && item.away.id === clubs[away].id)!;
}
async function importFixtures(fixtures: Fixture[], retrievedAt?: string) {
  const batch: Batch = { coverage, clubs, players, fixtures, standings: [], issues: [] };
  const text = JSON.stringify(batch);
  const source = {
    action: "get_events" as const, resourceKey: `test:153:events:${observation++}`, params: { league_id: "153", timezone: "UTC" },
    text, contentSha256: createHash("sha256").update(text).digest("hex"),
    retrievedAt: retrievedAt ?? new Date(Date.parse(cutoff) - 3_600_000 + observation * 1000).toISOString(),
  };
  const archive: ArchivedResponse = { ...source, id: archiveId(source) };
  await ingestion.import(archive, batch);
}
async function roster(at: string, memberships: { player: Player; club: number }[] = players.map((player) => ({ player, club: 0 })), complete = true,
  options: { id?: string; leagueId?: string } = {}) {
  const token = randomUUID();
  const source = (await pool.query(`INSERT INTO sports.source_revisions(action,resource_key,archive_ref,content_sha256,retrieved_at)
    VALUES ('get_teams',$1,$2,$3,$4) RETURNING id`, [token, token, "a".repeat(64), at])).rows[0].id;
  const normalized = (await pool.query(`INSERT INTO sports.normalized_revisions(source_revision_id,entity_type,entity_key,content_sha256)
    VALUES ($1,'roster',$2,$3) RETURNING id`, [source, token, "b".repeat(64)])).rows[0].id;
  const season = (await pool.query(`SELECT cs.id FROM sports.competition_seasons cs JOIN sports.competitions c ON c.id=cs.competition_id
    WHERE cs.label='2026/27' AND c.provider_id=$1`, [options.leagueId ?? "153"])).rows[0].id;
  const snapshot = (await pool.query(`INSERT INTO sports.roster_snapshots(id,season_id,source_revision_id,observed_at,complete,normalized_revision_id)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [options.id ?? randomUUID(), season, source, at, complete, normalized])).rows[0].id;
  for (const membership of memberships) await pool.query(`INSERT INTO sports.roster_entries(snapshot_id,season_id,player_id,club_id)
    SELECT $1,$2,p.id,c.id FROM sports.players p,sports.clubs c WHERE p.provider_id=$3 AND c.provider_id=$4`,
    [snapshot, season, membership.player.id, clubs[membership.club].id]);
  return snapshot as string;
}

async function prepared(playerId = players[0].id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lsp:ingestion',0))");
    return (await prepareInputs(client, cutoff, [playerId])).get(playerId)!;
  } finally { await client.query("ROLLBACK"); client.release(); }
}

async function additionalLeague() {
  const competition = (await pool.query(`INSERT INTO sports.competitions(provider_id,name,country_name,timezone,coefficient,enabled)
    VALUES ('164','Ligue 2','France','Europe/Paris',1.5,true) RETURNING id`)).rows[0].id;
  return (await pool.query(`INSERT INTO sports.competition_seasons(competition_id,label,starts_on,ends_on,expected_clubs,enabled)
    VALUES ($1,'2026/27','2026-07-01','2027-06-30',18,true) RETURNING id`, [competition])).rows[0].id as string;
}

beforeEach(async () => {
  const tables = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  await admin.query(`TRUNCATE ${tables.map((row) => `sports.${row.tablename}`).join(",")} RESTART IDENTITY CASCADE`);
  observation = 0;
  schedule = [];
  for (let home = 0; home < clubs.length; home++) for (let away = 0; away < clubs.length; away++) {
    if (home === away) continue;
    const played = home === 0 && away <= 5;
    schedule.push({ id: String(900000 + home * 100 + away), leagueId: coverage.id, season: coverage.season,
      home: clubs[home], away: clubs[away], kickoffAt: played ? `2026-08-0${away}T15:00:00.000Z`
        : home === 0 && away === 6 ? "2026-08-20T15:00:00.000Z" : "2027-01-20T15:00:00.000Z",
      status: played ? "final" : "scheduled", statisticsStatus: played ? "complete" : "missing",
      homeScore: played ? 2 : null, awayScore: played ? 1 : null, detailed: played,
      appearances: played ? players.map((player) => appearance(player)) : [] });
  }
  await importFixtures(schedule);
  await roster("2026-07-01T00:00:00.000Z");
});

test("all four positions persist complete inputs, shared provenance and reproducible five-match outputs", async () => {
  const summary = await forecasts.refreshAll(cutoff);
  assert.deepEqual(summary, { players: 4, created: 4, unchanged: 0, available: 4, partial: 0, unavailable: 0 });
  const saved = await Promise.all(players.map((player) => forecasts.show(player.id)));
  assert.equal(new Set(saved.map((item) => item?.sourceOrdinal)).size, 1);
  assert.equal(new Set(saved.map((item) => item?.cutoffAt)).size, 1);
  for (const item of saved) {
    assert(item);
    assert.equal(item.result.historyStatus, "ready");
    assert.equal(item.result.selected.length, 5);
    assert.equal(item.result.forecastRating.status, "available");
    assert(item.result.forecastRating.value! >= 0 && item.result.forecastRating.value! <= 10);
    assert.equal(item.input.currentClub?.clubId, clubs[0].id);
    assert(item.provenance.rosterObservations);
  }
  assert.deepEqual(Object.keys(saved[0]!.result.projected90), ["saves", "goalsConceded"]);
  assert.deepEqual(Object.keys(saved[1]!.result.projected90), ["tackles", "interceptions"]);
  assert.deepEqual(Object.keys(saved[2]!.result.projected90).sort(), ["assists", "keyPasses", "tackles"].sort());
  assert.deepEqual(Object.keys(saved[3]!.result.projected90), ["goals", "assists", "shotsOnTarget"]);
  assert.equal((await admin.query("SELECT count(*) FROM sports.outbox WHERE event_type='canonical.changed' AND aggregate_type='forecast'")).rows[0].count, "0");
  assert.equal((await forecasts.refreshAll("2026-08-10T13:00:00.000Z")).unchanged, 4, "clock passage alone does not append revisions");
});

test("observation-only preparation preserves canonical windows, uncertainty and roster evidence", async () => {
  async function equivalent(expectedReady: boolean[]) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const full = await prepareInputs(client, cutoff);
      const observed = await prepareObservedInputs(client, cutoff);
      assert.equal(observed.size, full.size);
      for (const [index, player] of players.entries()) {
        const canonical = full.get(player.id)!;
        const scouting = observed.get(player.id)!;
        assert.deepEqual(scouting.input, { ...canonical.input,
          appearances: canonical.input.appearances.map((appearance) => ({ ...appearance, context: null })), targets: [] },
        "only forecast context and targets may be omitted; all statistics, gaps and roster evidence must match");
        const window = selectObservedWindow(canonical.input);
        assert.equal(window.ready, expectedReady[index]);
        assert.deepEqual(selectObservedWindow(scouting.input), { ...window,
          selected: window.selected.map((appearance) => ({ ...appearance, context: null })) });
        assert.equal(scouting.sourceOrdinal, canonical.sourceOrdinal);
        assert.deepEqual(scouting.provenance, {});
      }
      return observed;
    } finally { await client.query("ROLLBACK"); client.release(); }
  }
  await equivalent([true, true, true, true]);
  const sixth = { ...fixture(0, 6), kickoffAt: "2026-08-08T15:00:00.000Z", status: "final" as const,
    homeScore: 0, awayScore: 0, detailed: true, statisticsStatus: "complete" as const,
    appearances: players.map((player, index) => appearance(player, index === 0 ? { minutes: 59 }
      : index === 1 ? { participation: "dnp", minutes: 0, rating: null, goals: 0, assists: 0,
        shotsOnTarget: 0, keyPasses: 0, tackles: 0, interceptions: 0, saves: 0, goalsConceded: 0 }
        : index === 2 ? { participation: "unknown", minutes: null } : { rating: 0, goals: 0 })) };
  await importFixtures([sixth]);
  const observed = await equivalent([true, true, false, true]);
  assert.equal(selectObservedWindow(observed.get(players[0].id)!.input).selected.some((appearance) => appearance.fixtureId === sixth.id), false);
  assert.equal(selectObservedWindow(observed.get(players[3].id)!.input).selected.at(-1)?.fixtureId, sixth.id);
  await roster("2026-08-09T00:00:00.000Z", undefined, false);
  const unresolved = await equivalent([true, true, false, true]);
  assert([...unresolved.values()].every(({ input }) => input.currentClub === null
    && input.rosterReasons.some((reason) => reason.code === "incomplete_roster_observation")));
});

test("a comparison refresh aligns latest evaluations when only one player's semantic inputs change", async () => {
  await forecasts.refreshAll(cutoff);
  const original = (await forecasts.show(players[0].id))!;
  const changedOriginal = (await forecasts.show(players[3].id))!;
  const updated = { ...fixture(0, 5), appearances: players.map((player) => appearance(player,
    player.id === players[3].id ? { goals: 3 } : {})) };
  await importFixtures([updated]);
  const latestRoster = await roster("2026-08-09T00:00:00.000Z");
  const laterCutoff = "2026-08-10T13:00:00.000Z";
  const summary = await forecasts.refreshMany([players[0].id, players[3].id], laterCutoff);
  assert.equal(summary.created, 1);
  assert.equal(summary.unchanged, 1);
  const unchanged = (await forecasts.show(players[0].id))!;
  const changed = (await forecasts.show(players[3].id))!;
  assert.equal(unchanged.id, original.id);
  assert.deepEqual(unchanged.input, original.input, "an evaluation never rewrites revision inputs");
  assert.deepEqual(unchanged.result, original.result);
  assert.deepEqual(unchanged.provenance, original.provenance);
  assert.equal(unchanged.cutoffAt, original.cutoffAt);
  assert.equal(unchanged.sourceOrdinal, original.sourceOrdinal);
  assert.notEqual(changed.id, changedOriginal.id);
  assert.equal(changed.parentId, changedOriginal.id);
  assert.equal(unchanged.evaluation.cutoffAt, laterCutoff);
  assert.equal(changed.evaluation.cutoffAt, laterCutoff);
  assert.equal(unchanged.evaluation.sourceOrdinal, changed.evaluation.sourceOrdinal);
  assert(BigInt(unchanged.evaluation.sourceOrdinal) > BigInt(original.sourceOrdinal));
  assert(Date.parse(unchanged.evaluation.checkedAt) >= Date.parse(original.evaluation.checkedAt));
  assert((unchanged.evaluation.provenance.rosterObservations as { snapshotId: string }[])
    .some((observation) => observation.snapshotId === latestRoster));
  assert.equal((await forecasts.status()).revisions, 5);
  const pointer = (await pool.query("SELECT updated_at FROM sports.forecast_heads WHERE revision_id=$1", [unchanged.id])).rows[0].updated_at;
  await pool.query("UPDATE sports.forecast_heads SET checked_at=TIMESTAMPTZ '2020-01-01' WHERE revision_id=$1", [unchanged.id]);
  await forecasts.refreshMany([players[0].id, players[3].id], "2026-08-10T14:00:00.000Z");
  const checkedAgain = (await forecasts.show(players[0].id))!;
  assert.equal(checkedAgain.id, unchanged.id);
  assert.equal(checkedAgain.evaluation.cutoffAt, "2026-08-10T14:00:00.000Z");
  assert(Date.parse(checkedAgain.evaluation.checkedAt) > Date.parse("2020-01-01T00:00:00.000Z"));
  assert.equal((await pool.query("SELECT updated_at FROM sports.forecast_heads WHERE revision_id=$1", [unchanged.id])).rows[0].updated_at.toISOString(), pointer.toISOString());
  assert.equal((await forecasts.status()).revisions, 5);
});

test("the freshness migration backfills existing pointers without changing revision evidence", async () => {
  await forecasts.refreshAll(cutoff);
  const revisions = (await admin.query("SELECT * FROM sports.forecast_revisions ORDER BY ordinal")).rows;
  await admin.query("BEGIN");
  try {
    await admin.query(`ALTER TABLE sports.forecast_heads DROP COLUMN evaluation_cutoff_at,
      DROP COLUMN evaluation_source_ordinal,DROP COLUMN evaluation_provenance_json,DROP COLUMN checked_at`);
    await admin.query(await readFile(join(root, "db/migrations/007_forecast_freshness.sql"), "utf8"));
    const heads = (await admin.query(`SELECT h.*,r.cutoff_at,r.source_ordinal,r.provenance_json,r.created_at
      FROM sports.forecast_heads h JOIN sports.forecast_revisions r ON r.id=h.revision_id`)).rows;
    assert.equal(heads.length, 4);
    for (const head of heads) {
      assert.equal(head.evaluation_cutoff_at.toISOString(), head.cutoff_at.toISOString());
      assert.equal(head.evaluation_source_ordinal, head.source_ordinal);
      assert.deepEqual(head.evaluation_provenance_json, head.provenance_json);
      assert.equal(head.checked_at.toISOString(), head.created_at.toISOString());
    }
    assert.deepEqual((await admin.query("SELECT * FROM sports.forecast_revisions ORDER BY ordinal")).rows, revisions);
  } finally { await admin.query("ROLLBACK"); }
});

for (const minutes of [97, 59, 0]) test(`a new ${minutes}-minute final refreshes context and target with the exact eligibility window`, async () => {
  await forecasts.refreshAll(cutoff);
  const previous = await forecasts.show(players[0].id);
  const sixth = { ...fixture(0, 6), kickoffAt: "2026-08-08T15:00:00.000Z", status: "final" as const,
    statisticsStatus: "complete" as const, homeScore: 0, awayScore: 4, detailed: true,
    appearances: players.map((player) => appearance(player, { minutes, participation: minutes === 0 ? "dnp" : "played",
      rating: minutes === 0 ? 0 : 2, goals: 0, shotsOnTarget: 0, keyPasses: 0, tackles: 0, interceptions: 0, saves: 0, goalsConceded: 0 })) };
  await importFixtures([sixth]);
  assert.equal((await forecasts.refreshAll(cutoff)).created, 4);
  const saved = (await forecasts.show(players[0].id))!;
  assert.equal(saved.parentId, previous!.id);
  assert.equal(saved.result.historyStatus, "ready");
  assert.equal(saved.result.selected.some((item) => item.fixtureId === sixth.id), minutes >= 60);
  assert.equal(saved.result.selected.some((item) => item.fixtureId === fixture(0, 1).id), minutes < 60);
  assert.notEqual(saved.result.target?.fixtureId, sixth.id);
  assert.equal((await forecasts.refreshAll(cutoff)).unchanged, 4);
});

test("missing metrics block only their outputs, and A to B to A appends a new revision", async () => {
  await forecasts.refresh(players[3].id, cutoff);
  const first = (await forecasts.show(players[3].id))!;
  const changed = { ...fixture(0, 5), appearances: players.map((player) => appearance(player, player.id === players[3].id ? { goals: null } : {})) };
  await importFixtures([changed]);
  await forecasts.refresh(players[3].id, cutoff);
  const second = (await forecasts.show(players[3].id))!;
  assert.equal(second.result.historyStatus, "ready");
  assert.equal(second.result.forecastRating.status, "available");
  assert.equal(second.result.projected90.goals?.status, "unavailable");
  assert.equal(second.result.projected90.assists?.status, "available");
  await importFixtures([fixture(0, 5)]);
  await forecasts.refresh(players[3].id, cutoff);
  const third = (await forecasts.show(players[3].id))!;
  assert.equal(third.inputHash, first.inputHash);
  assert.equal(third.parentId, second.id);
  assert.notEqual(third.id, first.id);
  assert.equal((await forecasts.status()).revisions, 3);
});

test("a missing player row is a history gap even with a complete fixture-statistics flag", async () => {
  const sixth = { ...fixture(0, 6), kickoffAt: "2026-08-08T15:00:00.000Z", status: "final" as const,
    homeScore: 1, awayScore: 0, detailed: true, statisticsStatus: "complete" as const,
    appearances: players.slice(1).map((player) => appearance(player)) };
  await importFixtures([sixth]);
  await forecasts.refreshAll(cutoff);
  assert.equal((await forecasts.show(players[0].id))?.result.historyStatus, "incomplete_history");
  assert.equal((await forecasts.show(players[1].id))?.result.historyStatus, "ready");
  const unknown = { ...sixth, appearances: players.map((player) => appearance(player, player.id === players[0].id
    ? { clubId: clubs[1].id, participation: "unknown", minutes: null } : {})) };
  // A direct unknown membership correction must remain visible even after the
  // current roster places that player on an unrelated club.
  await importFixtures([unknown]);
  await roster("2026-08-09T00:00:00.000Z", players.map((player) => ({ player, club: player.id === players[0].id ? 1 : 0 })));
  await forecasts.refresh(players[0].id, cutoff);
  assert.equal((await forecasts.show(players[0].id))?.result.historyStatus, "incomplete_history");
});

test("confirmed transfer checkpoints close old-club risk without backdating roster evidence", async () => {
  const transfer = { ...fixture(1, 7), kickoffAt: "2026-08-06T15:00:00.000Z", status: "final" as const,
    homeScore: 2, awayScore: 0, detailed: true, statisticsStatus: "complete" as const,
    appearances: [appearance(players[0], { clubId: clubs[1].id })] };
  await importFixtures([transfer]);
  await roster("2026-08-07T00:00:00.000Z", players.map((player) => ({ player, club: player.id === players[0].id ? 1 : 0 })));
  const oldClub = { ...fixture(0, 6), kickoffAt: "2026-08-08T15:00:00.000Z", status: "final" as const,
    homeScore: 0, awayScore: 0, detailed: true, statisticsStatus: "complete" as const, appearances: [] };
  await importFixtures([oldClub]);
  await forecasts.refresh(players[0].id, cutoff);
  const saved = (await forecasts.show(players[0].id))!;
  assert.equal(saved.result.historyStatus, "ready");
  assert.equal(saved.input.currentClub?.clubId, clubs[1].id);
  assert.equal(saved.input.gaps.some((gap) => gap.fixtureId === oldClub.id), false);
  assert(saved.result.selected.some((item) => item.fixtureId === transfer.id));
  const newClub = { ...fixture(1, 8), kickoffAt: "2026-08-09T15:00:00.000Z", status: "final" as const,
    homeScore: 1, awayScore: 0, detailed: true, statisticsStatus: "complete" as const, appearances: [] };
  await importFixtures([newClub]);
  await forecasts.refresh(players[0].id, cutoff);
  assert.equal((await forecasts.show(players[0].id))?.result.historyStatus, "incomplete_history");
});

for (const state of ["absent", "partial", "ambiguous"] as const) test(`latest ${state} roster evidence cannot fall back to an older current club`, async () => {
  await forecasts.refresh(players[0].id, cutoff);
  const memberships = state === "absent" ? players.slice(1).map((player) => ({ player, club: 0 }))
    : [...players.map((player) => ({ player, club: 0 })), ...(state === "ambiguous" ? [{ player: players[0], club: 1 }] : [])];
  await roster("2026-08-09T00:00:00.000Z", memberships, state !== "partial");
  await forecasts.refresh(players[0].id, cutoff);
  const saved = (await forecasts.show(players[0].id))!;
  assert.equal(saved.input.currentClub, null);
  assert.equal(saved.result.target, null);
  assert.equal(saved.result.forecastRating.status, "unavailable");
  assert.equal(saved.result.historyStatus, "ready");
});

for (const conflict of ["club", "absence", "incomplete"] as const) test(`equal-time ${conflict} roster conflicts remain unavailable across clone UUID order`, async () => {
  const at = "2026-08-09T00:00:00.000Z";
  await roster(at, undefined, true, { id: "00000000-0000-4000-8000-000000000001" });
  const conflicting = conflict === "absence" ? players.slice(1).map((player) => ({ player, club: 0 }))
    : players.map((player) => ({ player, club: player.id === players[0].id && conflict === "club" ? 1 : 0 }));
  await roster(at, conflicting, conflict !== "incomplete", { id: "80000000-0000-4000-8000-000000000001" });
  await forecasts.refresh(players[0].id, cutoff);
  const first = (await forecasts.show(players[0].id))!;
  assert.equal(first.input.currentClub, null);
  assert(first.input.rosterReasons.some((reason) => reason.code === (conflict === "incomplete" ? "incomplete_roster_observation" : "ambiguous_current_club")));
  await roster(at, undefined, true, { id: "ffffffff-ffff-4fff-8fff-fffffffffff1" });
  assert.equal((await forecasts.refresh(players[0].id, cutoff)).unchanged, 1, "a high UUID cannot override a conflicting simultaneous observation");
  await roster(at, conflicting, conflict !== "incomplete", { id: "ffffffff-ffff-4fff-8fff-fffffffffff2" });
  assert.equal((await forecasts.refresh(players[0].id, cutoff)).unchanged, 1);
  assert.equal((await forecasts.show(players[0].id))!.inputHash, first.inputHash);
});

test("identical complete roster clones are harmless and every historical observation remains traceable", async () => {
  const older = await roster("2026-08-06T00:00:00.000Z", undefined, true, { id: "00000000-0000-4000-8000-000000000002" });
  const latest = await roster("2026-08-09T00:00:00.000Z", undefined, true, { id: "00000000-0000-4000-8000-000000000003" });
  await forecasts.refresh(players[0].id, cutoff);
  const saved = (await forecasts.show(players[0].id))!;
  assert.equal(saved.result.status, "available");
  const lineage = saved.provenance.rosterObservations as { snapshotId: string }[];
  assert(lineage.some((observation) => observation.snapshotId === older));
  assert(lineage.some((observation) => observation.snapshotId === latest));
  const clone = await roster("2026-08-09T00:00:00.000Z", undefined, true, { id: "ffffffff-ffff-4fff-8fff-fffffffffff3" });
  assert.equal((await forecasts.refresh(players[0].id, cutoff)).unchanged, 1);
  assert.equal((await forecasts.show(players[0].id))!.inputHash, saved.inputHash);
  const currentLineage = (await prepared()).provenance.rosterObservations as { snapshotId: string }[];
  assert(currentLineage.some((observation) => observation.snapshotId === clone));
  assert(currentLineage.some((observation) => observation.snapshotId === older));
});

test("complete roster exclusion invalidates old-club scope before an unrelated fixture gap", async () => {
  const absent = await roster("2026-08-06T00:00:00.000Z", players.slice(1).map((player) => ({ player, club: 0 })));
  await importFixtures([{ ...fixture(1, 2), kickoffAt: "2026-08-08T15:00:00.000Z", status: "final", homeScore: 1, awayScore: 0,
    detailed: true, statisticsStatus: "complete", appearances: [] }]);
  await roster("2026-08-09T00:00:00.000Z");
  await forecasts.refresh(players[0].id, cutoff);
  const saved = (await forecasts.show(players[0].id))!;
  assert.equal(saved.input.currentClub?.clubId, clubs[0].id);
  assert.equal(saved.result.historyStatus, "incomplete_history");
  assert(saved.input.gaps.some((gap) => gap.fixtureId === fixture(1, 2).id));
  assert((saved.provenance.rosterObservations as { snapshotId: string }[]).some((observation) => observation.snapshotId === absent));
});

test("a roster absence simultaneous with a confirmed appearance leaves subsequent club scope uncertain", async () => {
  await roster(fixture(0, 5).kickoffAt!, players.slice(1).map((player) => ({ player, club: 0 })));
  await importFixtures([{ ...fixture(1, 2), kickoffAt: "2026-08-08T15:00:00.000Z", status: "final", homeScore: 1, awayScore: 0,
    detailed: true, statisticsStatus: "complete", appearances: [] }]);
  await roster("2026-08-09T00:00:00.000Z");
  await forecasts.refresh(players[0].id, cutoff);
  const saved = (await forecasts.show(players[0].id))!;
  assert.equal(saved.result.selected.length, 5, "the confirmed appearance remains explicit eligibility evidence");
  assert.equal(saved.result.historyStatus, "incomplete_history");
  assert(saved.input.gaps.some((gap) => gap.fixtureId === fixture(1, 2).id));
});

test("an unrelated league's complete absence preserves an established club checkpoint", async () => {
  await forecasts.refresh(players[0].id, cutoff);
  const first = (await forecasts.show(players[0].id))!;
  await additionalLeague();
  await roster("2026-08-06T00:00:00.000Z", [], true, { leagueId: "164" });
  await forecasts.refresh(players[0].id, cutoff);
  const saved = (await forecasts.show(players[0].id))!;
  assert.equal(saved.inputHash, first.inputHash);
  assert.equal(saved.result.historyStatus, "ready");
  assert.equal(saved.input.currentClub?.clubId, clubs[0].id);
});

for (const state of ["missing", "partial"] as const) test(`an unrelated league's ${state} roster preserves a uniquely confirmed club and history scope`, async () => {
  await forecasts.refresh(players[0].id, cutoff);
  const first = (await forecasts.show(players[0].id))!;
  const season = await additionalLeague();
  await pool.query(`INSERT INTO sports.season_clubs(season_id,club_id)
    SELECT $1,id FROM sports.clubs WHERE provider_id=ANY($2::text[])`, [season, [clubs[1].id, clubs[2].id]]);
  if (state === "partial") await roster("2026-08-06T00:00:00.000Z", [], false, { leagueId: "164" });
  await pool.query(`INSERT INTO sports.fixtures(provider_id,season_id,home_club_id,away_club_id,kickoff_at,status,statistics_status,home_score,away_score)
    SELECT '1999999',$1,h.id,a.id,'2026-08-08T15:00:00Z','final','complete',1,0
    FROM sports.clubs h,sports.clubs a WHERE h.provider_id=$2 AND a.provider_id=$3`, [season, clubs[1].id, clubs[2].id]);
  await forecasts.refresh(players[0].id, cutoff);
  const saved = (await forecasts.show(players[0].id))!;
  assert.equal(saved.inputHash, first.inputHash);
  assert.equal(saved.input.currentClub?.clubId, clubs[0].id);
  assert.deepEqual(saved.input.rosterReasons, []);
  assert.equal(saved.result.historyStatus, "ready");
  assert.equal(saved.result.forecastRating.status, "available");
  assert.equal(saved.input.gaps.some((gap) => gap.fixtureId === "1999999"), false);
});

test("an explicit partial cross-league claim blocks the current club and clears historical scope", async () => {
  const season = await additionalLeague();
  await pool.query(`INSERT INTO sports.season_clubs(season_id,club_id)
    SELECT $1,id FROM sports.clubs WHERE provider_id=$2`, [season, clubs[1].id]);
  await roster("2026-08-06T00:00:00.000Z", [{ player: players[0], club: 1 }], false, { leagueId: "164" });
  await importFixtures([{ ...fixture(2, 3), kickoffAt: "2026-08-08T15:00:00.000Z", status: "final", homeScore: 1, awayScore: 0,
    detailed: true, statisticsStatus: "complete", appearances: [] }]);
  await forecasts.refresh(players[0].id, cutoff);
  const saved = (await forecasts.show(players[0].id))!;
  assert.equal(saved.input.currentClub, null);
  assert.deepEqual(saved.input.rosterReasons, [{ code: "incomplete_roster_observation" }, { code: "ambiguous_current_club" }]);
  assert.equal(saved.result.forecastRating.status, "unavailable");
  assert.equal(saved.result.historyStatus, "incomplete_history");
  assert.ok(saved.input.gaps.some((gap) => gap.fixtureId === fixture(2, 3).id));
});

test("an incomplete empty roster in the player's established league still blocks club and history scope", async () => {
  await roster("2026-08-06T00:00:00.000Z", [], false);
  await importFixtures([{ ...fixture(2, 3), kickoffAt: "2026-08-08T15:00:00.000Z", status: "final", homeScore: 1, awayScore: 0,
    detailed: true, statisticsStatus: "complete", appearances: [] }]);
  await forecasts.refresh(players[0].id, cutoff);
  const saved = (await forecasts.show(players[0].id))!;
  assert.equal(saved.input.currentClub, null);
  assert.deepEqual(saved.input.rosterReasons, [{ code: "incomplete_roster_observation" }]);
  assert.equal(saved.result.historyStatus, "incomplete_history");
  assert.ok(saved.input.gaps.some((gap) => gap.fixtureId === fixture(2, 3).id));
});

test("after-cutoff appearances and roster inclusions cannot establish historical player relevance", async () => {
  const historical = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return (await prepareHistoricalInputs(client, "2026-08-09T23:00:00.000Z", "2026-08-10", [players[0].id])).get(players[0].id)!;
    } finally { await client.query("ROLLBACK"); client.release(); }
  };
  const first = await historical();
  const season = await additionalLeague();
  await pool.query(`INSERT INTO sports.season_clubs(season_id,club_id)
    SELECT $1,id FROM sports.clubs WHERE provider_id=ANY($2::text[])`, [season, [clubs[1].id, clubs[2].id]]);
  const future = (await pool.query(`INSERT INTO sports.fixtures(provider_id,season_id,home_club_id,away_club_id,kickoff_at,status)
    SELECT '1999999',$1,h.id,a.id,'2026-08-11T15:00:00Z','scheduled'
    FROM sports.clubs h,sports.clubs a WHERE h.provider_id=$2 AND a.provider_id=$3 RETURNING id`, [season, clubs[1].id, clubs[2].id])).rows[0].id;
  await pool.query(`INSERT INTO sports.appearances(fixture_id,player_id,season_id,participation)
    SELECT $1,id,$2,'unknown' FROM sports.players WHERE provider_id=$3`, [future, season, players[0].id]);
  await roster("2026-08-11T00:00:00.000Z", [{ player: players[0], club: 1 }], false, { leagueId: "164" });
  const after = await historical();
  assert.equal(after.input.currentClub?.clubId, clubs[0].id);
  assert.deepEqual(after.input.rosterReasons, []);
  assert.equal(after.input.appearances.some((appearance) => appearance.fixtureId === "1999999"), false);
  assert.equal(inputHash(after.input), inputHash(first.input));
  assert.equal((await prepared()).input.currentClub?.clubId, clubs[0].id);
});

test("simultaneous cross-league club claims preserve a historical gap regardless of clone UUIDs", async () => {
  const season = await additionalLeague();
  await pool.query("INSERT INTO sports.season_clubs(season_id,club_id) SELECT $1,id FROM sports.clubs WHERE provider_id=$2", [season, clubs[1].id]);
  const at = "2026-08-06T00:00:00.000Z";
  await roster(at, undefined, true, { id: "00000000-0000-4000-8000-000000000004" });
  await roster(at, [{ player: players[0], club: 1 }], true, { leagueId: "164", id: "80000000-0000-4000-8000-000000000004" });
  await importFixtures([{ ...fixture(2, 3), kickoffAt: "2026-08-08T15:00:00.000Z", status: "final", homeScore: 1, awayScore: 0,
    detailed: true, statisticsStatus: "complete", appearances: [] }]);
  await roster("2026-08-09T00:00:00.000Z");
  await roster("2026-08-09T00:00:00.000Z", [], true, { leagueId: "164" });
  await forecasts.refresh(players[0].id, cutoff);
  const first = (await forecasts.show(players[0].id))!;
  assert.equal(first.input.currentClub?.clubId, clubs[0].id);
  assert.equal(first.result.historyStatus, "incomplete_history");
  assert(first.input.gaps.some((gap) => gap.fixtureId === fixture(2, 3).id));
  await roster(at, undefined, true, { id: "ffffffff-ffff-4fff-8fff-fffffffffff4" });
  assert.equal((await forecasts.refresh(players[0].id, cutoff)).unchanged, 1);
  assert.equal((await forecasts.show(players[0].id))!.inputHash, first.inputHash);
});

test("a newly final sixth appearance refreshes through durable outbox dispatch without duplicate forecast revisions", async () => {
  const queue = new JobQueue(pool, "forecast-window-integration", true);
  const handle = async (job: { kind: string }) => {
    assert.equal(job.kind, "forecast.refresh");
    await forecasts.refreshAll(cutoff);
  };
  assert(await queue.dispatch(500) > 0);
  assert.equal(await queue.runForecastOnce(handle), true);
  const first = (await forecasts.show(players[0].id))!;
  assert.equal(first.result.selected.length, 5);
  const sixth = { ...fixture(0, 6), kickoffAt: "2026-08-08T15:00:00.000Z", status: "final" as const,
    statisticsStatus: "complete" as const, homeScore: 0, awayScore: 5, detailed: true,
    appearances: players.map((player) => appearance(player, { rating: 1, goals: 0 })) };
  await importFixtures([sixth]);
  assert(await queue.dispatch(500) > 0);
  assert.equal(await queue.runForecastOnce(handle), true);
  const refreshed = (await forecasts.show(players[0].id))!;
  assert.equal(refreshed.parentId, first.id);
  assert(refreshed.result.selected.some((appearance) => appearance.fixtureId === sixth.id));
  assert.equal(refreshed.result.selected.some((appearance) => appearance.fixtureId === fixture(0, 1).id), false);
  const count = (await forecasts.status()).revisions;
  await queue.dispatch(500);
  assert.equal(await queue.runForecastOnce(handle), false);
  assert.equal((await forecasts.refreshAll(cutoff)).unchanged, 4);
  assert.equal((await forecasts.status()).revisions, count);
  assert.equal((await pool.query("SELECT count(*) FROM sports.jobs WHERE kind='forecast.refresh' AND status='succeeded'")).rows[0].count, "2");
});

test("current context includes observed same-day finals while target cancellation selects the next confirmed fixture", async () => {
  await forecasts.refresh(players[0].id, cutoff);
  const first = (await forecasts.show(players[0].id))!;
  const sameDay = { ...fixture(1, 2), kickoffAt: "2026-08-10T09:00:00.000Z", status: "final" as const,
    homeScore: 9, awayScore: 0, detailed: true, statisticsStatus: "complete" as const, appearances: [] };
  await importFixtures([{ ...sameDay, status: "live", homeScore: null, awayScore: null }]);
  await forecasts.refresh(players[0].id, cutoff);
  const live = (await forecasts.show(players[0].id))!;
  assert.equal(live.result.forecastRating.status, "available", "a known live match has no final result yet");
  await importFixtures([sameDay]);
  await forecasts.refresh(players[0].id, cutoff);
  const second = (await forecasts.show(players[0].id))!;
  assert.notEqual(second.inputHash, first.inputHash);
  const firstContext = first.input.targets.find((target) => target.fixtureId === first.result.target!.fixtureId)?.context;
  const secondContext = second.input.targets.find((target) => target.fixtureId === second.result.target!.fixtureId)?.context;
  assert.equal(secondContext?.opponent?.rank, firstContext!.opponent!.rank + 1, "same-day observed final changes the reconstructed table");
  assert.notEqual(second.input.targets.find((target) => target.fixtureId === second.result.target!.fixtureId)?.context?.key,
    first.input.targets.find((target) => target.fixtureId === first.result.target!.fixtureId)?.context?.key);
  await importFixtures([{ ...fixture(0, 6), status: "cancelled" }]);
  await forecasts.refresh(players[0].id, cutoff);
  const third = (await forecasts.show(players[0].id))!;
  assert.notEqual(third.result.target?.fixtureId, fixture(0, 6).id);
  assert.equal(third.result.historyStatus, "ready");
});

test("loader restricts enabled approved coverage and a comparison batch shares one source watermark", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lsp:ingestion',0))");
    const inputs = await prepareInputs(client, cutoff, players.map((player) => player.id));
    assert.equal(inputs.size, 4);
    assert.equal(new Set([...inputs.values()].map((item) => item.sourceOrdinal)).size, 1);
    assert([...inputs.values()].every((item) => item.input.cutoffAt === cutoff));
    await client.query("UPDATE sports.competitions SET enabled=false");
    const disabled = await prepareInputs(client, cutoff, [players[0].id]);
    assert.equal(disabled.get(players[0].id)?.input.appearances.length, 0);
    assert.equal(disabled.get(players[0].id)?.input.targets.length, 0);
    await client.query("UPDATE sports.competitions SET enabled=true");
    await client.query("UPDATE sports.competition_seasons SET starts_on=DATE '2026-08-01'");
    assert.equal((await prepareInputs(client, cutoff, [players[0].id])).get(players[0].id)?.input.appearances.length, 0);
    await client.query("UPDATE sports.competition_seasons SET starts_on=DATE '2026-07-01',expected_clubs=23");
    assert.equal((await prepareInputs(client, cutoff, [players[0].id])).get(players[0].id)?.input.appearances.length, 0);
    await client.query("UPDATE sports.competition_seasons SET expected_clubs=24");
    await client.query("UPDATE sports.competitions SET timezone='Europe/Paris'");
    assert.equal((await prepareInputs(client, cutoff, [players[0].id])).get(players[0].id)?.input.appearances.length, 0);
  } finally { await client.query("ROLLBACK"); client.release(); }
});

test("forecast revisions are append-only for runtime roles and parents cannot cross player identity or form cycles", async () => {
  await forecasts.refreshAll(cutoff);
  const first = (await forecasts.show(players[0].id))!;
  const other = (await forecasts.show(players[1].id))!;
  await assert.rejects(pool.query("UPDATE sports.forecast_revisions SET input_hash=input_hash"), { code: "42501" });
  await assert.rejects(pool.query("DELETE FROM sports.forecast_revisions"), { code: "42501" });
  await assert.rejects(pool.query("UPDATE sports.forecast_heads SET player_id=player_id"), { code: "42501" });
  await assert.rejects(admin.query("UPDATE sports.forecast_revisions SET parent_id=$1 WHERE id=$2", [first.id, other.id]), { code: "23503" });
  await assert.rejects(admin.query("UPDATE sports.forecast_revisions SET parent_id=id WHERE id=$1", [first.id]), { code: "23514" });
  const reader = new pg.Client({ ...connection, user: "lsp_reader", password: process.env.POSTGRES_READER_PASSWORD });
  await reader.connect();
  try {
    assert.equal((await reader.query("SELECT count(*) FROM sports.forecast_revisions")).rows[0].count, "4");
    await assert.rejects(reader.query("DELETE FROM sports.forecast_heads"), { code: "42501" });
    await assert.rejects(reader.query("UPDATE sports.forecast_heads SET checked_at=clock_timestamp()"), { code: "42501" });
    assert((await reader.query("SELECT evaluation_cutoff_at,evaluation_source_ordinal,evaluation_provenance_json,checked_at FROM sports.forecast_heads")).rows
      .every((head) => head.evaluation_cutoff_at && head.evaluation_source_ordinal && head.evaluation_provenance_json && head.checked_at));
  } finally { await reader.end(); }
});
