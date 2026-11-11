import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { ReadError, ReadService, type PlayerFilters } from "../src/server/api/read";
import { ForecastStore } from "../src/server/forecast/store";
import { evaluateForecast, inputHash } from "../src/server/forecast/engine";
import { archiveId } from "../src/server/ingestion/archive";
import { coverageFor } from "../src/server/ingestion/coverage";
import { IngestionStore } from "../src/server/ingestion/store";
import type { ArchivedResponse, Batch, Fixture, Player } from "../src/server/ingestion/types";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId)) {
  throw new Error("Read API tests require NODE_ENV=test, a dedicated _test database and POSTGRES_TEST_CLUSTER_ID from a disposable PostgreSQL 17 cluster.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const connection = {
  host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"), database,
  connectionTimeoutMillis: 5_000, statement_timeout: 30_000,
};
const coverage = coverageFor("153");
const clubs = Array.from({ length: 24 }, (_, index) => ({ id: index === 0 ? "3072" : String(5000 + index), name: `Read club ${index + 1}` }));
const players: Player[] = (["GK", "DEF", "MID", "FWD", "FWD"] as const).map((position, index) => ({
  id: String(8001 + index), name: `Read player ${index + 1}`, position,
}));
let administrator: pg.Client;
let writer: pg.Pool;
let reader: pg.Pool;
let service: ReadService;
let seasonId: string;
let schedule: Fixture[];

before(async () => {
  administrator = new pg.Client({ ...connection, user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD });
  await administrator.connect();
  const identity = (await administrator.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(identity.name, database);
  assert.equal(identity.identifier, clusterId, "refusing an unconfirmed PostgreSQL cluster");
  assert.equal(Math.trunc(Number(identity.version) / 10_000), 17);
  assert.equal((await administrator.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())")).rowCount, 0);
  for (const command of ["provision", "migrate"]) await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), command], { cwd: root, timeout: 60_000, maxBuffer: 512_000 });
  writer = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD, max: 6 });
  reader = new pg.Pool({ ...connection, user: "lsp_reader", password: process.env.POSTGRES_READER_PASSWORD, max: 3 });
  service = new ReadService(reader);
});
after(async () => { await Promise.allSettled([writer?.end(), reader?.end(), administrator?.end()]); });

async function roster(at: string, entries: { playerId: string; clubId: string }[], complete = true, rosterSeasonId = seasonId) {
  const token = randomUUID();
  const sourceId = (await writer.query(`INSERT INTO sports.source_revisions(action,resource_key,archive_ref,content_sha256,retrieved_at)
    VALUES ('get_teams',$1,$2,$3,$4) RETURNING id`, [token, `hidden-archive-${token}`, "a".repeat(64), at])).rows[0].id;
  const revisionId = (await writer.query(`INSERT INTO sports.normalized_revisions(source_revision_id,entity_type,entity_key,content_sha256)
    VALUES ($1,'roster',$2,$3) RETURNING id`, [sourceId, token, "b".repeat(64)])).rows[0].id;
  const snapshotId = (await writer.query(`INSERT INTO sports.roster_snapshots(season_id,source_revision_id,observed_at,complete,normalized_revision_id)
    VALUES ($1,$2,$3,$4,$5) RETURNING id`, [rosterSeasonId, sourceId, at, complete, revisionId])).rows[0].id;
  for (const entry of entries) await writer.query(`INSERT INTO sports.roster_entries(snapshot_id,season_id,player_id,club_id)
    SELECT $1,$2,p.id,c.id FROM sports.players p,sports.clubs c
    WHERE p.provider='apifootball' AND c.provider='apifootball' AND p.provider_id=$3 AND c.provider_id=$4`,
  [snapshotId, rosterSeasonId, entry.playerId, entry.clubId]);
  return snapshotId as string;
}
const rosterEntries = () => players.map((player) => ({ playerId: player.id, clubId: clubs[0].id }));

async function scoutingPeers() {
  const peers: Player[] = Array.from({ length: 10 }, (_, index) => ({
    id: String(8100 + index), name: `Scouting peer ${String(index + 1).padStart(2, "0")}`, position: "FWD",
  }));
  const fixtures = schedule.filter((fixture) => fixture.status === "final").map((fixture) => ({
    ...fixture, appearances: [...fixture.appearances, ...peers.map((player, index) => ({
      player, clubId: clubs[0].id, participation: "played" as const, minutes: 90, rating: null,
      goals: index, assists: 0, shotsOnTarget: 0, keyPasses: null, tackles: null,
      interceptions: null, saves: null, goalsConceded: null,
    }))],
  }));
  const batch: Batch = { coverage, clubs, players: [...players, ...peers], fixtures, standings: [], issues: [] };
  const text = JSON.stringify(batch);
  const observation = { action: "get_events" as const, resourceKey: randomUUID(),
    params: { league_id: "153", timezone: "UTC" }, text, contentSha256: createHash("sha256").update(text).digest("hex"), retrievedAt: "2026-08-11T11:00:00Z" };
  await new IngestionStore(writer).import({ ...observation, id: archiveId(observation) }, batch);
  await roster("2026-07-02T00:00:00Z", [...rosterEntries(), ...peers.map((player) => ({ playerId: player.id, clubId: clubs[0].id }))]);
  return peers;
}

async function additionalLeague() {
  const competition = (await writer.query(`INSERT INTO sports.competitions(provider_id,name,country_name,timezone,coefficient,enabled)
    VALUES ('164','Ligue 2','France','Europe/Paris',1.5,true) RETURNING id`)).rows[0].id;
  return (await writer.query(`INSERT INTO sports.competition_seasons(competition_id,label,starts_on,ends_on,expected_clubs,enabled)
    VALUES ($1,'2026/27','2026-07-01','2027-06-30',18,true) RETURNING id`, [competition])).rows[0].id as string;
}

beforeEach(async () => {
  const tables = (await administrator.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  await administrator.query(`TRUNCATE ${tables.map((row) => `sports.${row.tablename}`).join(",")} RESTART IDENTITY CASCADE`);
  schedule = [];
  for (let home = 0; home < clubs.length; home++) for (let away = 0; away < clubs.length; away++) {
    if (home === away) continue;
    const finished = home === 0 && away <= 5;
    schedule.push({ id: String(900000 + home * 100 + away), leagueId: "153", season: "2026/27",
      home: clubs[home], away: clubs[away], kickoffAt: finished ? `2026-08-0${away}T15:00:00Z` : "2027-01-20T15:00:00Z",
      status: finished ? "final" : "scheduled", statisticsStatus: finished ? "complete" : "missing",
      homeScore: finished ? 2 : null, awayScore: finished ? 1 : null, detailed: finished,
      appearances: finished ? players.map((player) => ({ player, clubId: clubs[0].id, participation: "played", minutes: away === 1 ? 60 : 97,
        rating: 7.5, goals: player.id === "8004" && away === 3 ? null : 0, assists: 0, shotsOnTarget: 2,
        keyPasses: 1, tackles: 2, interceptions: 1, saves: 4, goalsConceded: 1 })) : [] });
  }
  const batch: Batch = { coverage, clubs, players, fixtures: schedule, standings: [], issues: [] };
  const text = JSON.stringify(batch);
  const token = randomUUID();
  const observation = { action: "get_events" as const, resourceKey: token,
    params: { league_id: "153", timezone: "UTC" }, text, contentSha256: createHash("sha256").update(text).digest("hex"), retrievedAt: "2026-08-10T11:00:00Z" };
  const archive: ArchivedResponse = { ...observation, id: archiveId(observation) };
  await new IngestionStore(writer).import(archive, batch);
  seasonId = (await writer.query("SELECT id FROM sports.competition_seasons WHERE label='2026/27'")).rows[0].id;
  await roster("2026-07-01T00:00:00Z", rosterEntries());
  await new ForecastStore(writer).refreshMany(["8001", "8002", "8004", "8005"]);
});

test("reader catalogue joins enabled coverage, paginates and retains genuine availability/freshness", async () => {
  const overview = await service.overview();
  assert.deepEqual(overview.counts, { competitions: 1, clubs: 24, players: 5,
    forecasts: { available: 3, partial: 1, unavailable: 0, uncomputed: 1 } });
  assert.equal((await service.competitions()).items[0].id, "153");
  assert.equal((await service.clubs({ leagueId: "153" })).items.length, 24);
  assert.equal((await service.clubs({ leagueId: "164" })).items.length, 0);
  const page = await service.players({ page: 2, pageSize: 2, leagueId: "153", clubId: "3072" });
  assert.deepEqual(page.pagination, { page: 2, pageSize: 2, total: 5, pages: 3 });
  assert.deepEqual(page.items.map((player) => player.id), ["8003", "8004"]);
  assert(page.items.every((player) => player.currentClub?.id === "3072"));
  assert.equal((await service.players({ page: 9, pageSize: 2 })).pagination.total, 5);
  assert.deepEqual((await service.players({ page: 9, pageSize: 2 })).items, []);
  assert.equal((await service.players({ availability: "uncomputed" })).items[0].id, "8003");
  assert.equal((await service.players({ availability: "partial", position: "FWD" })).items[0].id, "8004");
  assert.equal((await service.players({ q: "  player 5  " })).items[0].id, "8005");
  assert.match(page.source.sourceOrdinal, /^\d+$/);
  assert(page.source.latestRetrievedAt);
  assert(page.items[1].forecast.checkedAt);
  assert.equal(page.items[1].forecast.kind, "stored-evaluation");
  assert(page.items[1].forecast.evaluationCutoffAt);
  assert(Date.parse(page.items[1].forecast.evaluationCutoffAt) <= Date.parse(page.source.cutoffAt));
  assert.equal((await service.players({ availability: "uncomputed" })).items[0].forecast.evaluationCutoffAt, null);
  assert(page.items.every((player) => player.bestStatistic.status === "unavailable" && player.bestStatistic.reason === "insufficient_cohort"));
});

test("grouped catalogue filters partition statuses before search, counts and pagination", async () => {
  // Include a genuine missing evaluation alongside an uncomputed player.
  await writer.query(`UPDATE sports.appearances SET minutes=59
    WHERE player_id=(SELECT id FROM sports.players WHERE provider_id='8001')
    AND fixture_id=(SELECT id FROM sports.fixtures WHERE provider_id='900001')`);
  await new ForecastStore(writer).refresh("8001");
  const ready = await service.players({ availability: "ready", pageSize: 1, page: 2 });
  assert.deepEqual(ready.pagination, { page: 2, pageSize: 1, total: 3, pages: 3 });
  assert.equal(ready.items[0].id, "8004");
  assert.equal(ready.items[0].forecast.status, "partial");
  const hidden = await service.players({ availability: "hidden", pageSize: 1, page: 2 });
  assert.deepEqual(hidden.pagination, { page: 2, pageSize: 1, total: 2, pages: 2 });
  assert.equal(hidden.items[0].id, "8003");
  assert.equal(hidden.items[0].forecast.status, "uncomputed");
  assert.equal((await service.players({ availability: "hidden", q: "player 1", clubId: "3072", leagueId: "153", position: "GK" })).items[0].id, "8001");
  assert.equal((await service.players({ availability: "ready", q: "player 1" })).pagination.total, 0);
  assert.equal((await service.players({ availability: "unavailable" })).items[0].id, "8001");
  assert.equal((await service.players()).pagination.total, ready.pagination.total + hidden.pagination.total);
  // Direct/shared profile requests are not subject to catalogue visibility.
  assert.equal((await service.player("8001")).player.id, "8001");
  assert.equal((await service.player("8003")).player.id, "8003");
});

test("detail separates bounded observed values, immutable forecast and latest evaluation without raw archives", async () => {
  const detail = await service.player("8004");
  assert.equal(detail.observedLimit, 50);
  assert.equal(detail.observedAppearances.length, 5);
  assert.equal(detail.observedAppearances.find((appearance) => appearance.fixtureId === "900003")?.metrics.goals, null);
  assert.equal(detail.observedAppearances[0].metrics.assists, 0);
  assert.equal(detail.observedAppearances[0].minutes, 97);
  const current = (await reader.query(`SELECT a.normalized_revision_id FROM sports.appearances a
    JOIN sports.players p ON p.id=a.player_id JOIN sports.fixtures f ON f.id=a.fixture_id
    WHERE p.provider_id='8004' AND f.provider_id=$1`, [detail.observedAppearances[0].fixtureId])).rows[0];
  assert.equal(detail.observedAppearances[0].revisionId, current.normalized_revision_id);
  assert(detail.observedAppearances.every((appearance) => appearance.membershipKnown === true));
  assert.equal(detail.forecast?.result.selected.length, 5);
  assert.equal(detail.forecast?.result.projected90.goals?.value, null);
  assert.equal(detail.forecast?.result.forecastRating.status, "available");
  assert.equal(detail.forecast?.evaluation.sourceOrdinal, detail.source.sourceOrdinal);
  assert.equal(detail.forecast?.input.player.id, "8004");
  assert(!JSON.stringify(detail).includes("hidden-archive"));
  assert(!JSON.stringify(detail).includes("archive_ref"));
  assert.equal((await service.forecast("8003")).forecast, null);
  assert.equal((await service.forecast("8004")).forecast?.id, detail.forecast?.id);
  assert.deepEqual(detail.player.bestStatistic, { status: "unavailable", reason: "insufficient_cohort" });
});

test("scouting uses the full metric-eligible cohort across search, pages, profiles and comparison", async () => {
  await scoutingPeers();
  const filtered = await service.players({ q: "Scouting peer 10", pageSize: 1 });
  assert.equal(filtered.pagination.total, 1);
  const statistic = filtered.items[0].bestStatistic;
  assert.equal(statistic.status, "available");
  if (statistic.status !== "available") return;
  assert.equal(statistic.metric, "goals");
  assert.equal(statistic.total, 45);
  assert.equal(statistic.per90, 9);
  assert.equal(statistic.cohortSize, 11, "ten new peers and the original complete zero-goal forward form the goals cohort");
  assert.equal(statistic.percentile, 90);
  assert.equal(statistic.standout, true);
  assert.equal(statistic.cutoffAt, filtered.source.cutoffAt);
  assert.deepEqual(statistic.fixtureIds, ["900001", "900002", "900003", "900004", "900005"]);
  const paged = await service.players({ position: "FWD", page: 12, pageSize: 1 });
  assert.equal(paged.items[0].id, "8109");
  assert.equal(paged.items[0].bestStatistic.status, "available");
  if (paged.items[0].bestStatistic.status !== "available") return;
  assert.equal(paged.items[0].bestStatistic.cohortSize, statistic.cohortSize);
  assert.equal(paged.items[0].bestStatistic.percentile, statistic.percentile);
  const profile = await service.player("8109");
  assert.equal(profile.forecast, null, "observed strengths do not require an issued forecast or provider ratings");
  assert.deepEqual(profile.player.bestStatistic, { ...statistic, cutoffAt: profile.source.cutoffAt });
  const appearanceBatchSizes: number[] = [];
  const observing = { connect: async () => {
    const client = await reader.connect();
    return new Proxy(client, { get(target, key) {
      if (key === "query") return async (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].includes("FROM sports.effective_appearances a") && args[0].includes("a.player_id=ANY")) {
          appearanceBatchSizes.push(((args[1] as unknown[])[1] as unknown[]).length);
        }
        return Reflect.apply(target.query, target, args);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } } as pg.Pool;
  const comparison = await new ReadService(observing).compare(["8106", "8107", "8108", "8109"]);
  assert.deepEqual(appearanceBatchSizes, [15, 4], "comparison shares one full-cohort observation batch and one selected-player forecast batch");
  assert.deepEqual(comparison.players[3].player.bestStatistic, { ...statistic, cutoffAt: comparison.cutoffAt });
  assert.equal((await administrator.query("SELECT count(*)::integer AS count FROM sports.provider_requests")).rows[0].count, 0);
});

test("scouting metrics and catalogue identities share the repeatable-read cutoff during concurrent updates", async () => {
  const peers = await scoutingPeers();
  let corrected = false;
  const observing = { connect: async () => {
    const client = await reader.connect();
    return new Proxy(client, { get(target, key) {
      if (key === "query") return async (...args: unknown[]) => {
        const result = await Reflect.apply(target.query, target, args);
        if (!corrected && typeof args[0] === "string" && args[0].includes("count(*)::integer AS total FROM summaries")) {
          corrected = true;
          await writer.query(`UPDATE sports.appearances a SET goals=100 FROM sports.players p
            WHERE p.id=a.player_id AND p.provider_id=ANY($1::text[])`, [peers.filter((player) => player.id !== "8108").map((player) => player.id)]);
        }
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } } as pg.Pool;
  const response = await new ReadService(observing).players({ q: "Scouting peer 09", pageSize: 1 });
  assert.equal(corrected, true);
  const statistic = response.items[0].bestStatistic;
  assert.equal(statistic.status, "available");
  if (statistic.status !== "available") return;
  assert.equal(statistic.percentile, 81, "peer changes committed after the snapshot cannot affect this response");
  assert.equal(statistic.cutoffAt, response.source.cutoffAt);
  const current = (await service.player("8108")).player.bestStatistic;
  assert.equal(current.status, "available");
  if (current.status !== "available") return;
  assert.equal(current.percentile, 9, "a later request sees the newly observed peer rates");
  assert.equal(current.standout, false);
});

test("latest incomplete, conflicting and excluding rosters cannot reuse a historical current club", async () => {
  const at = "2026-09-01T00:00:00Z";
  await roster(at, rosterEntries(), false);
  let player = (await service.player("8004")).player;
  assert.equal(player.currentClub, null);
  assert(player.currentClubReasons.includes("incomplete_roster_observation"));
  assert.deepEqual(player.bestStatistic, { status: "unavailable", reason: "unresolved_roster" });
  assert.equal((await service.players({ clubId: "3072" })).pagination.total, 0);
  await roster("2026-09-02T00:00:00Z", rosterEntries());
  await roster("2026-09-02T00:00:00Z", rosterEntries().map((entry) => entry.playerId === "8004" ? { ...entry, clubId: clubs[1].id } : entry));
  player = (await service.player("8004")).player;
  assert.equal(player.currentClub, null);
  assert(player.currentClubReasons.includes("ambiguous_current_club"));
  await roster("2026-09-03T00:00:00Z", rosterEntries().filter((entry) => entry.playerId !== "8004"));
  assert.equal((await service.player("8004")).player.currentClub, null);
  assert.equal((await service.player("8005")).player.currentClub?.id, "3072");
  await roster("2026-09-04T00:00:00Z", rosterEntries());
  await roster("2026-09-04T00:00:00Z", rosterEntries().filter((entry) => entry.playerId !== "8004"));
  assert((await service.player("8004")).player.currentClubReasons.includes("ambiguous_current_club"));
  await roster("2026-09-05T00:00:00Z", rosterEntries());
  await roster("2026-09-05T00:00:00Z", rosterEntries());
  assert.equal((await service.player("8004")).player.currentClub?.id, "3072");
});

for (const state of ["missing", "partial"] as const) test(`catalogue and comparison ignore an unrelated league's ${state} roster`, async () => {
  const before = await service.compare(["8004", "8005"]);
  const unrelatedSeason = await additionalLeague();
  if (state === "partial") await roster("2026-08-06T00:00:00Z", [], false, unrelatedSeason);
  const catalogue = await service.players({ leagueId: "153", clubId: "3072" });
  assert.equal(catalogue.pagination.total, players.length);
  assert.ok(catalogue.items.every((player) => player.currentClub?.id === "3072" && player.currentClubReasons.length === 0));
  const comparison = await service.compare(["8004", "8005"]);
  for (const [index, item] of comparison.players.entries()) {
    assert.equal(item.player.currentClub?.id, "3072");
    assert.deepEqual(item.player.currentClubReasons, []);
    assert.deepEqual(item.input.rosterReasons, []);
    assert.equal(item.input.currentClub?.clubId, "3072");
    assert.equal(item.result.historyStatus, "ready");
    assert.equal(item.result.forecastRating.status, "available");
    assert.equal(item.canonicalInputHash, before.players[index].canonicalInputHash);
  }
});

test("partial explicit cross-league claims block only the affected player with matching reader and forecast reasons", async () => {
  const unrelatedSeason = await additionalLeague();
  await writer.query(`INSERT INTO sports.season_clubs(season_id,club_id)
    SELECT $1,id FROM sports.clubs WHERE provider_id=$2`, [unrelatedSeason, clubs[1].id]);
  await roster("2026-08-06T00:00:00Z", [{ playerId: "8004", clubId: clubs[1].id }], false, unrelatedSeason);
  const comparison = await service.compare(["8004", "8005"]);
  const affected = comparison.players[0];
  assert.equal(affected.player.currentClub, null);
  assert.equal(affected.input.currentClub, null);
  assert.deepEqual(affected.player.currentClubReasons, ["incomplete_roster_observation", "ambiguous_current_club"]);
  assert.deepEqual(affected.input.rosterReasons.map((reason) => reason.code), affected.player.currentClubReasons);
  assert.equal(affected.result.forecastRating.status, "unavailable");
  assert.equal(comparison.players[1].player.currentClub?.id, "3072");
  assert.equal(comparison.players[1].result.forecastRating.status, "available");
});

test("an incomplete empty relevant roster remains unavailable with matching reader and forecast reasons", async () => {
  await roster("2026-08-06T00:00:00Z", [], false);
  const comparison = await service.compare(["8004", "8005"]);
  for (const item of comparison.players) {
    assert.equal(item.player.currentClub, null);
    assert.equal(item.input.currentClub, null);
    assert.deepEqual(item.player.currentClubReasons, ["incomplete_roster_observation"]);
    assert.deepEqual(item.input.rosterReasons.map((reason) => reason.code), item.player.currentClubReasons);
    assert.equal(item.result.forecastRating.status, "unavailable");
  }
});

test("future cross-league appearances and roster inclusions cannot alter current reader relevance", async () => {
  const before = await service.compare(["8004", "8005"]);
  const unrelatedSeason = await additionalLeague();
  await writer.query(`INSERT INTO sports.season_clubs(season_id,club_id)
    SELECT $1,id FROM sports.clubs WHERE provider_id=ANY($2::text[])`, [unrelatedSeason, [clubs[1].id, clubs[2].id]]);
  const future = (await writer.query(`INSERT INTO sports.fixtures(provider_id,season_id,home_club_id,away_club_id,kickoff_at,status)
    SELECT '1999999',$1,h.id,a.id,'2027-05-01T15:00:00Z','scheduled'
    FROM sports.clubs h,sports.clubs a WHERE h.provider_id=$2 AND a.provider_id=$3 RETURNING id`, [unrelatedSeason, clubs[1].id, clubs[2].id])).rows[0].id;
  await writer.query(`INSERT INTO sports.appearances(fixture_id,player_id,season_id,participation)
    SELECT $1,id,$2,'unknown' FROM sports.players WHERE provider_id='8004'`, [future, unrelatedSeason]);
  await roster("2027-05-01T00:00:00Z", [{ playerId: "8004", clubId: clubs[1].id }], false, unrelatedSeason);
  const comparison = await service.compare(["8004", "8005"]);
  for (const [index, item] of comparison.players.entries()) {
    assert.equal(item.player.currentClub?.id, "3072");
    assert.equal(item.input.currentClub?.clubId, "3072");
    assert.deepEqual(item.player.currentClubReasons, []);
    assert.deepEqual(item.input.rosterReasons, []);
    assert.equal(item.canonicalInputHash, before.players[index].canonicalInputHash);
  }
});

test("observed evidence is bounded and unknown participation/minutes remain null", async () => {
  await writer.query(`INSERT INTO sports.appearances(fixture_id,player_id,season_id,participation)
    SELECT f.id,p.id,f.season_id,'unknown' FROM sports.fixtures f,sports.players p
    WHERE p.provider_id='8004' AND NOT EXISTS (SELECT 1 FROM sports.appearances x WHERE x.fixture_id=f.id AND x.player_id=p.id)
    ORDER BY f.provider_id LIMIT 51`);
  const detail = await service.player("8004");
  assert.equal(detail.observedAppearances.length, 50);
  assert(detail.observedAppearances.every((appearance) => appearance.minutes === null && appearance.rating === null));
  assert(detail.observedAppearances.every((appearance) => appearance.revisionId === null && appearance.membershipKnown === false));
  assert.equal(detail.forecast?.result.selected.length, 5, "a read cannot rewrite the saved revision");
});

test("missing rosters do not promote a historical fixture membership to a current club", async () => {
  await administrator.query("DELETE FROM sports.roster_entries");
  await administrator.query("DELETE FROM sports.roster_snapshots");
  const player = (await service.player("8004")).player;
  assert.equal(player.currentClub, null);
  assert(player.currentClubReasons.includes("missing_roster_observation"));
  const comparison = await service.compare(["8004", "8005"]);
  assert(comparison.players.every((item) => item.result.forecastRating.status === "unavailable"));
  assert(comparison.players.every((item) => item.result.adjustedFormIndex.status === "available"));
});

test("foreign-provider fixtures and their appearances cannot enter catalogue or canonical comparisons", async () => {
  const baseline = await service.compare(["8004", "8005"]);
  const foreign = (await writer.query(`INSERT INTO sports.fixtures(provider,provider_id,season_id,home_club_id,away_club_id,kickoff_at)
    SELECT 'uncovered-provider','990001',$1,home.id,away.id,TIMESTAMPTZ '2026-08-08T15:00:00Z'
    FROM sports.clubs home,sports.clubs away WHERE home.provider_id='3072' AND away.provider_id='5001' RETURNING id`, [seasonId])).rows[0].id;
  const uncovered = (await writer.query("INSERT INTO sports.players(provider_id,name) VALUES ('8006','Foreign fixture only') RETURNING id")).rows[0].id;
  await writer.query(`INSERT INTO sports.appearances(fixture_id,player_id,season_id)
    SELECT $1::uuid,id,$2::uuid FROM sports.players WHERE provider_id='8004'
    UNION ALL SELECT $1::uuid,$3::uuid,$2::uuid`, [foreign, seasonId, uncovered]);
  assert.equal((await service.player("8004")).observedAppearances.length, 5);
  assert.equal((await service.players()).pagination.total, 5);
  await assert.rejects(service.player("8006"), { status: 404 });
  const compared = await service.compare(["8004", "8005"]);
  assert(compared.players.every((item) => !item.input.appearances.some((appearance) => appearance.fixtureId === "990001")));
  assert.deepEqual(compared.players.map((item) => item.canonicalInputHash), baseline.players.map((item) => item.canonicalInputHash));
});

test("comparison evaluates a common read-only canonical snapshot with opt-in shared metrics and separate saved revisions", async () => {
  const before = (await administrator.query("SELECT count(*)::integer AS count FROM sports.forecast_revisions")).rows[0].count;
  const same = await service.compare(["8004", "8005"]);
  assert.equal(same.kind, "transient-comparison");
  assert.equal(same.crossPosition, false);
  assert.equal(same.notice, null);
  assert.deepEqual(same.sharedMetrics, ["goals", "assists", "shotsOnTarget"]);
  assert(same.players.every((item) => item.input.cutoffAt === same.cutoffAt));
  assert(same.players.every((item) => item.provenance.sourceOrdinal === same.sourceOrdinal));
  assert(same.players.every((item) => item.storedRevision));
  await assert.rejects(service.compare(["8003", "8004"]), { status: 400, code: "position_mismatch" });
  const cross = await service.compare(["8003", "8004"], true);
  assert(cross.notice);
  assert.deepEqual(cross.sharedMetrics, ["assists"]);
  assert(cross.players.every((item) => Object.keys(item.result.projected90).join(",") === "assists"));
  assert(cross.players.every((item) => item.result.status === "available"));
  assert(cross.players.every((item) => !item.result.reasons.some((reason) => reason.field === "goals")));
  const forward = cross.players.find((item) => item.player.id === "8004")!;
  assert.equal(forward.canonicalStatus, "partial", "missing unshared goals still affect the canonical evaluation");
  assert.equal(forward.canonicalInputHash, inputHash(forward.input, evaluateForecast(forward.input)));
  assert.equal(forward.result.status, "available", "the shared assists projection remains available");
  assert.equal(forward.storedRevision?.inputHash, forward.canonicalInputHash);
  assert(!Object.hasOwn(forward, "inputHash"), "the display projection cannot be mistaken for the canonical hashed result");
  assert.equal(cross.players[0].storedRevision, null);
  assert(cross.players[1].storedRevision);
  assert.deepEqual((await service.compare(["8001", "8002"], true)).sharedMetrics, []);
  assert.equal((await administrator.query("SELECT count(*)::integer AS count FROM sports.forecast_revisions")).rows[0].count, before);
  assert.equal((await administrator.query("SELECT count(*)::integer AS count FROM sports.provider_requests")).rows[0].count, 0);
  await assert.rejects(reader.query("UPDATE sports.players SET name='forbidden' WHERE provider_id='8004'"), { code: "42501" });
});

test("filter/identifier validation rejects unknown keys, injection, expanded scope and unsafe bounds", async () => {
  const invalidFilters: unknown[] = [
    { unexpected: true }, { leagueId: "39" }, { clubId: "999999" }, { position: "wing" }, { availability: "probable" },
    { q: "x".repeat(81) }, { q: "a\u0000b" }, { page: 0 }, { page: 1.5 }, { page: null }, { page: Number.MAX_SAFE_INTEGER },
    { pageSize: 51 }, { pageSize: null }, { clubId: "3072' OR 1=1 --" },
  ];
  for (const filters of invalidFilters) await assert.rejects(service.players(filters as PlayerFilters), (error) => error instanceof ReadError && error.status === 400);
  await assert.rejects(service.clubs({ leagueId: "153", extra: true } as { leagueId?: string }), { status: 400 });
  for (const id of ["0", "8004 OR 1=1", "-1", "9007199254740992", ""]) await assert.rejects(service.player(id), { status: 400, code: "invalid_identifier" });
  await assert.rejects(service.player("999999"), { status: 404, code: "player_not_found" });
  for (const ids of [["8004"], ["8004", "8004"], ["8001", "8002", "8003", "8004", "8005"]]) await assert.rejects(service.compare(ids), { status: 400 });
  assert.equal((await service.players({ q: "%_' OR 1=1 --" })).pagination.total, 0);
  assert.equal((await service.players()).pagination.total, 5);
});

test("catalogue count and rows share one repeatable read-only snapshot during a concurrent correction", async () => {
  let corrected = false;
  const observing = { connect: async () => {
    const client = await reader.connect();
    return new Proxy(client, { get(target, key) {
      if (key === "query") return async (...args: unknown[]) => {
        const result = await Reflect.apply(target.query, target, args);
        if (!corrected && typeof args[0] === "string" && args[0].includes("count(*)::integer AS total FROM summaries")) {
          corrected = true;
          await writer.query("UPDATE sports.players SET name='Corrected identity' WHERE provider_id='8005'");
        }
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } } as pg.Pool;
  const response = await new ReadService(observing).players({ q: "player 5" });
  assert.equal(corrected, true);
  assert.equal(response.pagination.total, 1);
  assert.equal(response.items.length, 1);
  assert.equal(response.items[0].name, "Read player 5");
  assert.equal((await service.players({ q: "Corrected identity" })).pagination.total, 1);
});

test("every approved season guard and enabled state limits catalogue/detail access", async () => {
  for (const [sql, restore] of [
    ["UPDATE sports.competitions SET enabled=false", "UPDATE sports.competitions SET enabled=true"],
    ["UPDATE sports.competition_seasons SET enabled=false", "UPDATE sports.competition_seasons SET enabled=true"],
    ["UPDATE sports.competition_seasons SET expected_clubs=23", "UPDATE sports.competition_seasons SET expected_clubs=24"],
    ["UPDATE sports.competition_seasons SET starts_on=DATE '2026-08-01'", "UPDATE sports.competition_seasons SET starts_on=DATE '2026-07-01'"],
    ["UPDATE sports.competitions SET coefficient=2", "UPDATE sports.competitions SET coefficient=1.5"],
    ["UPDATE sports.competitions SET timezone='Europe/Paris'", "UPDATE sports.competitions SET timezone='Europe/London'"],
  ]) {
    await writer.query(sql);
    assert.equal((await service.competitions()).items.length, 0);
    assert.equal((await service.players()).pagination.total, 0);
    await assert.rejects(service.player("8004"), { status: 404 });
    await writer.query(restore);
  }
  await writer.query("INSERT INTO sports.players(provider_id,name) VALUES ('999999','Unscoped player')");
  await assert.rejects(service.player("999999"), { status: 404 });
  assert.equal((await service.players()).pagination.total, 5);
});
