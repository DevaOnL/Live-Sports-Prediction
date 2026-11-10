import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { AdminService } from "../src/server/api/admin";
import { ReadService } from "../src/server/api/read";
import { prepareInputs, prepareObservedInputs, prepareSourceInputs } from "../src/server/forecast/inputs";
import { ForecastStore } from "../src/server/forecast/store";
import { selectObservedWindow } from "../src/server/forecast/engine";
import { archiveId } from "../src/server/ingestion/archive";
import { CURRENT_SOURCE, LEGACY_SOURCE, sourceEntityKey, type SourceProfile } from "../src/server/ingestion/sources";
import { IngestionStore } from "../src/server/ingestion/store";
import { EnrichmentStore } from "../src/server/ingestion/enrichment-store";
import { JobQueue } from "../src/server/ingestion/jobs";
import type { ArchivedResponse, Batch, Club, Fixture, Player } from "../src/server/ingestion/types";

const database = process.env.POSTGRES_DB ?? "";
const clusterId = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) || !/^\d{10,20}$/.test(clusterId)) {
  throw new Error("Source read tests require guarded disposable PostgreSQL 17 _test databases.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const connection = { host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: Number(process.env.POSTGRES_PORT ?? "5432"), database,
  connectionTimeoutMillis: 5_000, statement_timeout: 60_000 };
const currentClubs: Club[] = Array.from({ length: 20 }, (_, index) => ({ id: `Club:${randomUUID()}`, name: `Synthetic current club ${index + 1}` }));
const currentPlayers: Player[] = Array.from({ length: 10 }, (_, index) => ({ id: `Player:${randomUUID()}`, name: `Synthetic current forward ${index + 1}`, position: "FWD" }));
const legacyPlayer: Player = { id: "8001", name: "Synthetic retired player", position: "FWD" };
let administrator: pg.Client;
let writer: pg.Pool;
let reader: pg.Pool;
let service: ReadService;
let admin: AdminService;
let fixtures: Fixture[];

before(async () => {
  administrator = new pg.Client({ ...connection, user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD });
  await administrator.connect();
  const identity = (await administrator.query(`SELECT current_database() AS name,system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(identity.name, database);
  assert.equal(identity.identifier, clusterId);
  assert.equal(Math.trunc(Number(identity.version) / 10_000), 17);
  assert.equal((await administrator.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres',current_database())")).rowCount, 0);
  for (const command of ["provision", "migrate"]) await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), command], { cwd: root, timeout: 60_000, maxBuffer: 512_000 });
  writer = new pg.Pool({ ...connection, user: "lsp_writer", password: process.env.POSTGRES_WRITER_PASSWORD, max: 4 });
  reader = new pg.Pool({ ...connection, user: "lsp_reader", password: process.env.POSTGRES_READER_PASSWORD, max: 3 });
  service = new ReadService(reader, CURRENT_SOURCE);
  admin = new AdminService(writer, CURRENT_SOURCE);
});
after(async () => { await Promise.allSettled([writer?.end(), reader?.end(), administrator?.end()]); });

async function importBatch(profile: SourceProfile, batch: Batch, retrievedAt = "2026-08-10T11:00:00.000Z") {
  const text = JSON.stringify(batch);
  const observation = { action: "get_events" as const, resourceKey: randomUUID(), params: { league_id: batch.coverage.id, timezone: "UTC",
    ...(profile.provider === "sorare" ? { provider: "sorare" } : {}) },
    text, contentSha256: createHash("sha256").update(text).digest("hex"), retrievedAt };
  const archive: ArchivedResponse = { ...observation, id: archiveId(observation) };
  await new IngestionStore(writer, profile).import(archive, batch);
}

async function roster(profile: SourceProfile, leagueId: string, players: Player[], club: Club) {
  const token = randomUUID();
  const source = (await writer.query(`INSERT INTO sports.source_revisions(provider,action,resource_key,archive_ref,content_sha256,retrieved_at)
    VALUES ($1,'get_teams',$2,$2,$3,'2026-07-01T00:00:00Z') RETURNING id`, [profile.provider, token, "a".repeat(64)])).rows[0].id;
  const revision = (await writer.query(`INSERT INTO sports.normalized_revisions(source_revision_id,entity_type,entity_key,content_sha256)
    VALUES ($1,'roster',$2,$3) RETURNING id`, [source, token, "b".repeat(64)])).rows[0].id;
  const season = (await writer.query(`SELECT s.id FROM sports.competition_seasons s JOIN sports.competitions c ON c.id=s.competition_id
    WHERE c.provider=$1 AND c.provider_id=$2`, [profile.provider, leagueId])).rows[0].id;
  const snapshot = (await writer.query(`INSERT INTO sports.roster_snapshots(season_id,source_revision_id,observed_at,complete,normalized_revision_id)
    VALUES ($1,$2,'2026-07-01T00:00:00Z',true,$3) RETURNING id`, [season, source, revision])).rows[0].id;
  await writer.query(`INSERT INTO sports.roster_entries(snapshot_id,season_id,player_id,club_id)
    SELECT $1,$2,p.id,c.id FROM sports.players p,sports.clubs c
    WHERE p.provider=$3 AND c.provider=$3 AND p.provider_id=ANY($4::text[]) AND c.provider_id=$5`,
  [snapshot, season, profile.provider, players.map((player) => player.id), club.id]);
}

beforeEach(async () => {
  const tables = (await administrator.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
  assert(tables.every((row) => /^[a-z_]+$/.test(row.tablename)));
  await administrator.query(`TRUNCATE ${tables.map((row) => `sports.${row.tablename}`).join(",")} RESTART IDENTITY CASCADE`);
  const coverage = CURRENT_SOURCE.coverage[0];
  fixtures = [];
  for (let home = 0; home < currentClubs.length; home++) for (let away = 0; away < currentClubs.length; away++) {
    if (home === away) continue;
    const final = home === 0 && away <= 5;
    fixtures.push({ id: `Game:${randomUUID()}`, leagueId: coverage.id, season: coverage.season,
      home: currentClubs[home], away: currentClubs[away], kickoffAt: final ? `2026-08-0${away}T15:00:00Z` : "2027-01-20T15:00:00Z",
      status: final ? "final" : "scheduled", statisticsStatus: final ? "complete" : "missing", detailed: final,
      homeScore: final ? 2 : null, awayScore: final ? 1 : null,
      appearances: final ? currentPlayers.map((player, index) => ({ player, clubId: currentClubs[0].id,
        participation: "played", minutes: 90, rating: null, goals: index, assists: 0, shotsOnTarget: 1,
        keyPasses: null, tackles: 0, interceptions: 0, saves: 0, goalsConceded: 0 })) : [] });
  }
  await importBatch(CURRENT_SOURCE, { coverage, clubs: currentClubs, players: currentPlayers, fixtures, standings: [], issues: [] });
  await roster(CURRENT_SOURCE, coverage.id, currentPlayers, currentClubs[0]);
  const legacyClubs = Array.from({ length: 24 }, (_, index) => ({ id: index === 0 ? "3072" : String(5000 + index), name: `Synthetic retired club ${index + 1}` }));
  await importBatch(LEGACY_SOURCE, { coverage: LEGACY_SOURCE.coverage[0], clubs: legacyClubs, players: [legacyPlayer], standings: [], issues: [],
    fixtures: [{ id: "900001", leagueId: "153", season: "2026/27", home: legacyClubs[0], away: legacyClubs[1], kickoffAt: "2026-08-01T15:00:00Z",
      status: "final", statisticsStatus: "complete", detailed: true, homeScore: 1, awayScore: 0,
      appearances: [{ player: legacyPlayer, clubId: legacyClubs[0].id, participation: "played", minutes: 90, rating: 7,
        goals: 1, assists: 0, shotsOnTarget: 1, keyPasses: 1, tackles: 0, interceptions: 0, saves: 0, goalsConceded: 0 }] }] });
  await roster(LEGACY_SOURCE, "153", [legacyPlayer], legacyClubs[0]);
});

test("current native-ID reads and full-cohort highlights exclude retained legacy data", async () => {
  const leagues = await service.competitions();
  assert.deepEqual(leagues.items.map((league) => [league.id, league.coefficient, league.expectedClubs]), [[CURRENT_SOURCE.coverage[0].id, 2, 20]]);
  assert.equal((await service.overview()).counts.players, 10);
  assert.equal((await service.clubs()).items.length, 20);
  const page = await service.players({ q: "forward 10", leagueId: CURRENT_SOURCE.coverage[0].id, clubId: currentClubs[0].id, pageSize: 1 });
  assert.equal(page.pagination.total, 1);
  assert.equal(page.items[0].id, currentPlayers[9].id);
  assert.equal(page.items[0].bestStatistic.status, "available");
  if (page.items[0].bestStatistic.status === "available") {
    assert.equal(page.items[0].bestStatistic.total, 45);
    assert.equal(page.items[0].bestStatistic.percentile, 90);
    assert.equal(page.items[0].bestStatistic.cohortSize, 10);
  }
  const detail = await service.player(currentPlayers[9].id);
  assert.equal(detail.observedAppearances.length, 5);
  assert(detail.observedAppearances.every((row) => row.rating === null && row.metrics.keyPasses === null));
  await writer.query("UPDATE sports.players SET provider_slug='synthetic-current-forward' WHERE provider='sorare' AND provider_id=$1", [currentPlayers[9].id]);
  assert.equal((await service.player(currentPlayers[9].id)).player.sourceUrl, "https://sorare.com/football/players/synthetic-current-forward");
  await assert.rejects(service.player("8001"), { status: 400 });
  await assert.rejects(service.player(`Club:${randomUUID()}`), { status: 400 });
  await assert.rejects(service.players({ leagueId: "153" }), { status: 400 });
  const legacy = new ReadService(reader);
  assert.equal((await legacy.players()).items[0].id, "8001");
  assert.equal((await legacy.overview()).counts.players, 1);
  await assert.rejects(legacy.player(currentPlayers[0].id), { status: 400 });
});

async function searchNames() {
  const names = ["Kylian Mbappé", "Wilfried Mbappé", "João Félix", "Nicolás González", "Trent Alexander-Arnold",
    "Conor O’Neill", "Martin Ødegaard", "Lukas Müller", "Literal%_\\ Player", "Álex García"];
  for (const [index, name] of names.entries()) {
    await writer.query("UPDATE sports.players SET name=$1 WHERE provider='sorare' AND provider_id=$2", [name, currentPlayers[index].id]);
  }
  await writer.query("UPDATE sports.players SET name='Kylian Mbappé' WHERE provider='apifootball' AND provider_id=$1", [legacyPlayer.id]);
  return names;
}

test("current catalogue discovery folds genuine accents, case and punctuation without changing identities", async () => {
  const names = await searchNames();
  const mbappes = new Set(currentPlayers.slice(0, 2).map((player) => player.id));
  for (const q of ["mbappe", "mbappe'", "MBAPPÉ", "mbappe\u0301", "...MbApPe?!"]) {
    const response = await service.players({ q });
    assert.equal(response.pagination.total, 2, q);
    assert.deepEqual(new Set(response.items.map((player) => player.id)), mbappes, q);
    assert(response.items.every((player) => names.includes(player.name)), "discovery does not rewrite displayed names");
  }
  for (const [q, index] of [["JOAO felix", 2], ["Joao-Felix", 2], ["GONZALEZ nicolas", 3], ["alexander'arnold", 4],
    ["oneill", 5], ["O'NEILL", 5], ["odegaard", 6], ["MULLER", 7], ["ÁLEX garcia", 9]] as const) {
    const response = await service.players({ q });
    assert.equal(response.pagination.total, 1, q);
    assert.equal(response.items[0].id, currentPlayers[index].id, q);
    assert.equal(response.items[0].name, names[index]);
  }
  assert.equal((await service.players({ q: "mbapep" })).pagination.total, 0, "discovery does not guess misspelled identities");
  assert.equal((await service.players({ q: "   " })).pagination.total, 10, "blank input keeps the unfiltered catalogue");
  assert.equal((await service.players({ q: "'...?!—" })).pagination.total, 0, "punctuation alone cannot select every player");
});

test("partial name tokens combine with current coverage filters and stable pagination", async () => {
  await searchNames();
  await writer.query("UPDATE sports.players SET position='MID' WHERE provider='sorare' AND provider_id=$1", [currentPlayers[1].id]);
  for (const q of ["kyl mbap", "mbap kyl", "  mbap'   KYL  ", "mbap ' kyl", "kylian-mbappe"]) {
    const response = await service.players({ q, leagueId: CURRENT_SOURCE.coverage[0].id, clubId: currentClubs[0].id,
      position: "FWD", availability: "uncomputed", pageSize: 1 });
    assert.equal(response.pagination.total, 1, q);
    assert.equal(response.items[0].id, currentPlayers[0].id, q);
  }
  const first = await service.players({ q: "mbap", pageSize: 1 });
  const second = await service.players({ q: "MBAPPÉ'", pageSize: 1, page: 2 });
  assert.deepEqual(first.pagination, { page: 1, pageSize: 1, total: 2, pages: 2 });
  assert.deepEqual(second.pagination, { page: 2, pageSize: 1, total: 2, pages: 2 });
  assert.deepEqual(new Set([...first.items, ...second.items].map((player) => player.id)), new Set(currentPlayers.slice(0, 2).map((player) => player.id)));
  assert.equal((await service.players({ q: "mbap", position: "MID" })).items[0].id, currentPlayers[1].id);
  assert.equal((await service.players({ q: "mbap", leagueId: CURRENT_SOURCE.coverage[1].id })).pagination.total, 0);
  assert.equal((await service.players({ q: "mbap", clubId: currentClubs[1].id })).pagination.total, 0);
  assert.equal((await service.players({ q: "mbap", availability: "available" })).pagination.total, 0);
  assert.deepEqual((await service.players({ q: "mbap", pageSize: 1, page: 3 })).items, []);
});

test("normalised search retains literal wildcards, parameter safety and bounded input", async () => {
  await searchNames();
  for (const q of ["%", "_", "\\", "%_\\", "literal%_\\ player"]) {
    const response = await service.players({ q });
    assert.equal(response.pagination.total, 1, q);
    assert.equal(response.items[0].id, currentPlayers[8].id, q);
  }
  for (const q of ["mbap%", "mbap_", "%_' OR 1=1 --", "x'); DROP TABLE sports.players; --"]) {
    assert.equal((await service.players({ q })).pagination.total, 0, q);
  }
  assert.equal((await service.players({ q: "kyl".padEnd(80) })).items[0].id, currentPlayers[0].id);
  await assert.rejects(service.players({ q: "x".repeat(81) }), { status: 400, code: "invalid_search" });
  await assert.rejects(service.players({ q: "mbap\u0000pe" }), { status: 400, code: "invalid_search" });
  assert.equal((await service.players()).pagination.total, 10);
  assert.equal((await administrator.query("SELECT count(*)::integer AS count FROM sports.provider_requests")).rows[0].count, 0);
});

test("source forecast preparation preserves observations and missing outputs without changing legacy wrappers", async () => {
  await writer.query("UPDATE sports.fixtures SET statistics_status='partial' WHERE provider='sorare' AND status='final'");
  const client = await reader.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const cutoff = "2026-11-10T12:00:00.000Z";
    const inputs = await prepareSourceInputs(client, cutoff, CURRENT_SOURCE);
    const observed = await prepareObservedInputs(client, cutoff, CURRENT_SOURCE);
    const legacy = await prepareInputs(client, cutoff);
    assert.equal(inputs.size, 10);
    assert.equal(legacy.size, 1);
    for (const [id, prepared] of inputs) {
      assert.equal(prepared.input.currentClub?.leagueId, CURRENT_SOURCE.coverage[0].id);
      assert(prepared.input.appearances.every((appearance) => appearance.competition === "premier_league"));
      const full = selectObservedWindow(prepared.input);
      assert(full.ready);
      assert.deepEqual(selectObservedWindow(observed.get(id)!.input), { ...full,
        selected: full.selected.map((appearance) => ({ ...appearance, context: null })) });
    }
  } finally { await client.query("ROLLBACK"); client.release(); }
  const forecasts = new ForecastStore(writer, CURRENT_SOURCE);
  assert.equal((await forecasts.refreshMany(currentPlayers.slice(0, 2).map((player) => player.id))).players, 2);
  const saved = (await forecasts.show(currentPlayers[1].id))!;
  assert.equal(saved.result.forecastRating.status, "unavailable");
  assert.equal(saved.result.adjustedFormIndex.status, "unavailable");
  assert.equal(saved.result.projected90.goals?.status, "available");
  assert.equal(saved.input.appearances[0].rating, null);
  assert.equal(await new ForecastStore(writer).show(currentPlayers[1].id), null);
  const comparison = await service.compare(currentPlayers.slice(0, 2).map((player) => player.id));
  assert(comparison.players.every(({ player }) => player.currentClub?.leagueId === CURRENT_SOURCE.coverage[0].id));
  assert(comparison.players.every(({ result }) => result.forecastRating.status === "unavailable" && result.projected90.goals?.status === "available"));
});

test("supplemented fields agree across profile, forecast and comparison while primary corrections invalidate them", async () => {
  const playerId = currentPlayers[9].id;
  const initial = await service.player(playerId);
  const anchors = (await reader.query<{
    fixture_id: string; fixture_revision_id: string; appearance_id: string; primary_revision_id: string;
  }>(`SELECT f.id AS fixture_id,f.normalized_revision_id AS fixture_revision_id,
      a.id AS appearance_id,a.normalized_revision_id AS primary_revision_id
    FROM sports.appearances a JOIN sports.fixtures f ON f.id=a.fixture_id JOIN sports.players p ON p.id=a.player_id
    WHERE p.provider='sorare' AND p.provider_id=$1 AND f.status='final' ORDER BY f.kickoff_at`, [playerId])).rows;
  assert.equal(anchors.length, 5);
  const observedAt = "2026-11-10T12:00:00.000Z";
  const enrichment = new EnrichmentStore(writer);
  for (const [index, anchor] of anchors.entries()) {
    const externalFixtureId = String(800_000 + index);
    const batch = { fixtureId: anchor.fixture_id, fixtureRevisionId: anchor.fixture_revision_id, externalFixtureId,
      observations: [{ appearanceId: anchor.appearance_id, primaryRevisionId: anchor.primary_revision_id, externalPlayerId: "900001",
        evidence: { synthetic: true, privateSynthetic: "matching-evidence-stays-private" },
        metrics: { rating: 7.5, keyPasses: 2, tackles: 4, interceptions: 1 } }] };
    const text = JSON.stringify(batch);
    const response = { action: "get_statistics" as const, resourceKey: `highlightly:box-score:${externalFixtureId}`,
      params: { provider: "highlightly", match_id: externalFixtureId, league_id: CURRENT_SOURCE.coverage[0].id },
      text, contentSha256: createHash("sha256").update(text).digest("hex"), retrievedAt: observedAt };
    await enrichment.import({ ...response, id: archiveId(response) }, batch);
  }
  const detail = await service.player(playerId);
  assert.equal(detail.source.latestRetrievedAt, initial.source.latestRetrievedAt, "supplement freshness cannot refresh the primary source");
  assert.equal(detail.source.supplementLatestRetrievedAt, observedAt);
  for (const appearance of detail.observedAppearances) {
    assert.equal(appearance.rating, 7.5);
    assert.equal(appearance.metrics.keyPasses, 2);
    assert.equal(appearance.metrics.tackles, 0, "explicit primary zero takes precedence");
    assert.equal(appearance.metrics.interceptions, 0);
    assert.equal(appearance.fieldSources.rating.provider, "highlightly");
    assert.equal(appearance.fieldSources.keyPasses.observedAt, observedAt);
    assert.equal(appearance.fieldSources.tackles, undefined);
    assert.equal(appearance.revisionId, initial.observedAppearances.find((row) => row.fixtureId === appearance.fixtureId)!.revisionId);
  }
  const forecasts = new ForecastStore(writer, CURRENT_SOURCE);
  await forecasts.refreshMany([playerId], "2026-11-10T12:01:00.000Z");
  const saved = (await service.forecast(playerId)).forecast!;
  assert.equal(saved.result.forecastRating.status, "available");
  assert.equal(saved.result.selected.length, 5);
  assert.deepEqual(new Set(saved.result.selected.map((row) => row.fixtureId)), new Set(initial.observedAppearances.map((row) => row.fixtureId)));
  const lineage = saved.provenance.appearanceEnrichments;
  assert(Array.isArray(lineage));
  assert.equal(lineage.length, 5);
  const comparison = await service.compare([playerId, currentPlayers[8].id]);
  assert.equal(comparison.players[0].result.forecastRating.status, "available");
  assert.equal(comparison.players[1].result.forecastRating.status, "unavailable");
  assert.deepEqual(comparison.players[0].provenance.appearanceEnrichments, lineage);
  assert.equal(JSON.stringify({ detail, saved, comparison }).includes("matching-evidence-stays-private"), false);
  const changed = detail.observedAppearances[0];
  await admin.correctAppearance("synthetic-admin", { requestId: randomUUID(), playerId, fixtureId: changed.fixtureId,
    expectedRevisionId: changed.revisionId!, reason: "Synthetic source correction invalidates prior supplemental anchoring", changes: { goals: 8 } });
  const corrected = (await service.player(playerId)).observedAppearances.find((row) => row.fixtureId === changed.fixtureId)!;
  assert.equal(corrected.rating, null);
  assert.equal(corrected.metrics.keyPasses, null);
  assert.deepEqual(corrected.fieldSources, {});
  await forecasts.refreshMany([playerId], "2026-11-10T12:02:00.000Z");
  assert.equal((await service.forecast(playerId)).forecast!.result.forecastRating.status, "unavailable");
  assert.deepEqual((await administrator.query("SELECT result_json FROM sports.forecast_revisions WHERE id=$1", [saved.id])).rows[0].result_json,
    saved.result, "the earlier enriched explanation remains immutable");
});

test("a fresh suspended observation clears only nonfinal gaps and preserves five-match count forecasts", async () => {
  const cutoff = "2026-11-10T12:00:00.000Z";
  const interrupted = fixtures.find((fixture) => fixture.home.id === currentClubs[0].id && fixture.status === "scheduled")!;
  const update = (status: Fixture["status"]): Batch => ({ coverage: CURRENT_SOURCE.coverage[0], clubs: currentClubs,
    players: currentPlayers, standings: [], issues: [], fixtures: [{ ...interrupted,
      status, kickoffAt: "2026-08-06T15:00:00Z", statisticsStatus: "unknown", homeScore: null, awayScore: null }] });
  const forecasts = new ForecastStore(writer, CURRENT_SOURCE);
  await importBatch(CURRENT_SOURCE, update("unknown"), "2026-08-10T11:01:00.000Z");
  assert.equal((await forecasts.refreshAll(cutoff)).unavailable, currentPlayers.length);
  const before = (await forecasts.show(currentPlayers[0].id))!;
  assert.equal(before.result.historyStatus, "incomplete_history");
  assert(before.input.gaps.some((gap) => gap.fixtureId === interrupted.id && gap.code === "missing_appearance_evidence"));

  await importBatch(CURRENT_SOURCE, update("suspended"), "2026-08-10T11:02:00.000Z");
  const summary = await forecasts.refreshAll(cutoff);
  assert.equal(summary.partial, currentPlayers.length);
  assert.equal(summary.unavailable, 0);
  const stored = (await writer.query(`SELECT status,home_score,away_score FROM sports.fixtures
    WHERE provider='sorare' AND provider_id=$1`, [interrupted.id])).rows[0];
  assert.deepEqual(stored, { status: "suspended", home_score: null, away_score: null });
  await assert.rejects(writer.query(`UPDATE sports.fixtures SET status='unrecognized-provider-state'
    WHERE provider='sorare' AND provider_id=$1`, [interrupted.id]), { code: "23514" });
  for (const player of currentPlayers) {
    const saved = (await forecasts.show(player.id))!;
    assert.equal(saved.result.historyStatus, "ready");
    assert.equal(saved.result.selected.length, 5);
    assert.equal(saved.input.gaps.some((gap) => gap.fixtureId === interrupted.id), false);
    assert.notEqual(saved.result.target?.fixtureId, interrupted.id);
    assert.equal(saved.result.forecastRating.status, "unavailable", "suspension cannot create missing source ratings");
    assert.equal(saved.result.projected90.goals?.status, "available");
    assert.equal(saved.result.projected90.assists?.status, "available");
    assert.equal(saved.result.projected90.shotsOnTarget?.status, "available");
    assert.equal(saved.input.appearances.some((appearance) => appearance.fixtureId === interrupted.id), false);
  }
  const after = (await forecasts.show(currentPlayers[0].id))!;
  assert.equal(after.parentId, before.id);
  assert.notEqual(after.inputHash, before.inputHash);
  assert.deepEqual((await administrator.query("SELECT result_json FROM sports.forecast_revisions WHERE id=$1", [before.id])).rows[0].result_json,
    before.result, "the blocked prior revision remains immutable");
});

test("current explicit DNP with omitted minutes leaves five played appearances usable while unknown participation blocks", async () => {
  const missed = fixtures.find((fixture) => fixture.home.id === currentClubs[0].id && fixture.status === "scheduled")!;
  await importBatch(CURRENT_SOURCE, { coverage: CURRENT_SOURCE.coverage[0], clubs: currentClubs,
    players: currentPlayers, standings: [], issues: [], fixtures: [{ ...missed,
      status: "final", kickoffAt: "2026-08-06T15:00:00Z", statisticsStatus: "partial", detailed: true,
      homeScore: 0, awayScore: 0, appearances: currentPlayers.map((player) => ({ player,
        clubId: currentClubs[0].id, participation: "dnp", minutes: null, rating: null,
        goals: null, assists: null, shotsOnTarget: null, keyPasses: null, tackles: null,
        interceptions: null, saves: null, goalsConceded: null })) }] });
  const client = await reader.connect();
  try {
    const prepared = (await prepareSourceInputs(client, "2026-11-10T12:00:00.000Z", CURRENT_SOURCE)).get(currentPlayers[9].id)!;
    const dnp = prepared.input.appearances.find((appearance) => appearance.fixtureId === missed.id)!;
    assert.equal(dnp.sourceProvider, "sorare");
    assert.equal(dnp.participation, "dnp");
    assert.equal(dnp.minutes, null);
    assert(Object.values(dnp.metrics).every((value) => value === null));
    const selected = selectObservedWindow(prepared.input);
    assert.equal(selected.ready, true);
    assert.equal(selected.selected.length, 5);
    assert(selected.selected.every((appearance) => appearance.participation === "played" && appearance.fixtureId !== missed.id));
  } finally { client.release(); }
  assert.equal((await service.player(currentPlayers[9].id)).player.bestStatistic.status, "available");
  const store = new ForecastStore(writer, CURRENT_SOURCE);
  await store.refreshMany([currentPlayers[9].id]);
  assert.equal((await store.show(currentPlayers[9].id))!.result.projected90.goals?.status, "available");
  await writer.query(`UPDATE sports.appearances a SET participation='unknown' FROM sports.fixtures f
    WHERE f.id=a.fixture_id AND f.provider='sorare' AND f.provider_id=$1`, [missed.id]);
  const unknown = await service.player(currentPlayers[9].id);
  assert.deepEqual(unknown.player.bestStatistic, { status: "unavailable", reason: "incomplete_history" });
  await store.refreshMany([currentPlayers[9].id]);
  const blocked = (await store.show(currentPlayers[9].id))!.result;
  assert.equal(blocked.historyStatus, "incomplete_history");
  assert.equal(blocked.projected90.goals?.status, "unavailable");
  assert(blocked.reasons.some((reason) => reason.code === "unknown_participation" && reason.fixtureId === missed.id));
});

test("current administration scopes queues and preserves native-ID correction provenance and CAS", async () => {
  const fixture = fixtures.find((row) => row.status === "final")!;
  const request = await admin.requestStatistics("synthetic-admin", { requestId: randomUUID(), leagueId: fixture.leagueId, fixtureId: fixture.id });
  assert.deepEqual((await administrator.query("SELECT payload FROM sports.outbox WHERE id=$1", [request.eventId])).rows[0].payload,
    { provider: "sorare", leagueId: fixture.leagueId, fixtureId: fixture.id });
  const refresh = await admin.requestRefresh("synthetic-admin", randomUUID());
  assert.deepEqual((await administrator.query("SELECT payload FROM sports.outbox WHERE id=$1", [refresh.eventId])).rows[0].payload, { provider: "sorare" });
  const detail = await service.player(currentPlayers[9].id);
  const row = detail.observedAppearances.find((appearance) => appearance.fixtureId === fixture.id)!;
  const correction = { requestId: randomUUID(), playerId: currentPlayers[9].id, fixtureId: fixture.id,
    expectedRevisionId: row.revisionId!, reason: "Synthetic source-aware correction", changes: { goals: 8 } };
  const corrected = await admin.correctAppearance("synthetic-admin", correction);
  assert.equal(corrected.metrics.rating, null);
  assert.equal(corrected.metrics.keyPasses, null);
  assert.deepEqual(await admin.correctAppearance("synthetic-admin", correction), corrected);
  await assert.rejects(admin.correctAppearance("synthetic-admin", { ...correction, requestId: randomUUID() }), { status: 409 });
  const evidence = (await administrator.query("SELECT entity_key FROM sports.normalized_revisions WHERE id=$1", [corrected.revisionId])).rows[0];
  assert.equal(evidence.entity_key, sourceEntityKey(CURRENT_SOURCE, "appearance", fixture.id, currentPlayers[9].id));
  const audits = await admin.audit({ pageSize: 100 });
  assert(audits.items.some((item) => item.revisionId === corrected.revisionId));
  assert(audits.items.some((item) => item.id === refresh.requestId));
  await assert.rejects(admin.requestStatistics("synthetic-admin", { requestId: randomUUID(), leagueId: "153", fixtureId: "900001" }), { status: 400 });
  assert.deepEqual((await admin.status()).coverage.map((league) => league.leagueId), [fixture.leagueId]);
  await administrator.query(`UPDATE sports.ingestion_batches b SET issues_json=$1 FROM sports.source_revisions s
    WHERE s.id=b.source_revision_id AND s.provider='sorare'`, [JSON.stringify([
    { code: "unsupported_metric", resource: currentPlayers[9].id, field: "rating", raw: "private-synthetic-value" },
    { code: "statistics_under_review", resource: fixture.id },
    { code: "incomplete_schedule", resource: fixture.leagueId },
    { code: "unrecognized", resource: "https://example.test/?token=private-synthetic-value" },
  ])]);
  const imports = await admin.imports();
  assert.equal(imports.total, 1);
  assert.deepEqual(imports.items[0].issues, [
    { code: "unsupported_metric", resource: currentPlayers[9].id },
    { code: "statistics_under_review", resource: fixture.id },
    { code: "incomplete_schedule", resource: fixture.leagueId },
    { code: "validation_issue", resource: "unavailable" },
  ]);
  assert.equal(JSON.stringify(imports).includes("private-synthetic-value"), false);
  const retired = await new AdminService(writer).requestImport("synthetic-admin", randomUUID());
  assert.equal((await admin.audit({ pageSize: 100 })).items.some((item) => item.id === retired.requestId), false);
  const retiredJob = randomUUID();
  await administrator.query(`INSERT INTO sports.jobs(id,outbox_id,kind,deduplication_key,payload,status,attempts,max_attempts,completed_at)
    VALUES ($1,$2,'source.sync',$3,'{}','failed',1,5,clock_timestamp())`, [retiredJob, retired.eventId, `synthetic-retired:${retiredJob}`]);
  assert.equal((await admin.jobs()).items.some((job) => job.id === retiredJob), false);
  await assert.rejects(admin.retry("synthetic-admin", retiredJob, randomUUID()), { status: 404 });
  assert.equal((await administrator.query("SELECT count(*)::integer AS count FROM sports.provider_requests")).rows[0].count, 0);
});

test("current administration reports only the source's rolling minute request cap", async () => {
  await administrator.query(`INSERT INTO sports.provider_requests(action,resource_key,attempted_at)
    SELECT 'get_events','legacy:budget',clock_timestamp() FROM generate_series(1,120)`);
  await administrator.query(`INSERT INTO sports.provider_requests(action,resource_key,attempted_at)
    VALUES ('get_events','sorare:expired',clock_timestamp()-interval '2 minutes')`);
  assert.deepEqual((await admin.status()).providerBudget, { limit: 60, windowSeconds: 60, used: 0, remaining: 60, retryAt: null });
  await administrator.query(`INSERT INTO sports.provider_requests(action,resource_key,attempted_at)
    SELECT 'get_events','sorare:budget',clock_timestamp() FROM generate_series(1,60)`);
  const budget = (await admin.status()).providerBudget;
  assert.equal(budget.limit, 60);
  assert.equal(budget.windowSeconds, 60);
  assert.equal(budget.used, 60);
  assert.equal(budget.remaining, 0);
  assert(budget.retryAt);
  const retryAt = Date.parse(budget.retryAt);
  assert(retryAt > Date.now() && retryAt <= Date.now() + 60_000);
});

test("current job dispatch, claims, expiry recovery and retries leave retired and malformed source markers untouched", async () => {
  const legacyQueue = new JobQueue(writer, "synthetic-retired-worker", true);
  await legacyQueue.dispatch(500);
  const retiredForecast = (await administrator.query(`SELECT id FROM sports.jobs
    WHERE kind='forecast.refresh' AND NOT (payload ? 'provider') AND status='ready'`)).rows[0].id;
  const legacyAdmin = new AdminService(writer);
  const pending = await legacyAdmin.requestRefresh("synthetic-admin", randomUUID());
  const expiredSource = await legacyAdmin.requestImport("synthetic-admin", randomUUID());
  const failedSource = await legacyAdmin.requestImport("synthetic-admin", randomUUID());
  const expiredId = randomUUID(), failedId = randomUUID();
  await administrator.query(`INSERT INTO sports.jobs(id,outbox_id,kind,deduplication_key,payload,status,attempts,max_attempts,locked_by,locked_until)
    VALUES ($1,$2,'source.sync',$3,'{}','running',1,1,'retired-owner',clock_timestamp()-interval '1 minute')`,
  [expiredId, expiredSource.eventId, `synthetic-expired:${expiredId}`]);
  await administrator.query(`INSERT INTO sports.jobs(id,outbox_id,kind,deduplication_key,payload,status,attempts,max_attempts,completed_at)
    VALUES ($1,$2,'source.sync',$3,'{}','failed',1,1,clock_timestamp())`, [failedId, failedSource.eventId, `synthetic-failed:${failedId}`]);
  const protectedEvents = [pending.eventId, expiredSource.eventId, failedSource.eventId];
  for (const marker of [null, "retired", ["sorare"]]) {
    const id = randomUUID();
    await administrator.query(`INSERT INTO sports.outbox(id,event_type,aggregate_type,aggregate_id,deduplication_key,payload)
      VALUES ($1,'source.sync','request',$1,$2,$3)`, [id, `synthetic-marker:${id}`, JSON.stringify({ provider: marker })]);
    protectedEvents.push(id);
  }
  const before = (await administrator.query("SELECT * FROM sports.jobs WHERE id=ANY($1::uuid[]) ORDER BY id", [[retiredForecast, expiredId, failedId]])).rows;
  const currentQueue = new JobQueue(writer, "synthetic-current-worker", true, CURRENT_SOURCE);
  assert(await currentQueue.dispatch(500) > 0);
  let forecastsRun = 0;
  assert.equal(await currentQueue.runForecastOnce(async (job) => {
    assert.equal(job.kind, "forecast.refresh");
    assert.deepEqual(job.payload, { provider: "sorare" });
    assert.notEqual(job.id, retiredForecast);
    forecastsRun++;
  }), true, "a ready retired forecast must not block the current refresh");
  assert.equal(forecastsRun, 1);
  assert.equal(await currentQueue.runForecastOnce(async () => { assert.fail("a retired forecast cannot be claimed"); }), false);
  assert.equal(await currentQueue.retryFailed(failedId), false);
  const malformed = randomUUID();
  await administrator.query(`INSERT INTO sports.outbox(id,event_type,aggregate_type,aggregate_id,deduplication_key,payload)
    VALUES ($1,'source.sync','request',$1,$2,'{"provider":"sorare","unexpected":true}')`, [malformed, `synthetic-invalid:${malformed}`]);
  await currentQueue.dispatch(500);
  const malformedJob = (await administrator.query("SELECT id FROM sports.jobs WHERE outbox_id=$1", [malformed])).rows[0].id;
  for (let index = 0; index < 50; index++) {
    if (!await currentQueue.runOnce(async (job) => {
      assert.equal(job.payload.provider, "sorare");
      assert.notEqual(job.id, malformedJob, "malformed current work must fail validation before the handler");
    })) break;
  }
  assert.deepEqual((await administrator.query("SELECT status,last_error FROM sports.jobs WHERE outbox_id=$1", [malformed])).rows[0],
    { status: "failed", last_error: "invalid_job" });
  assert.deepEqual((await administrator.query("SELECT * FROM sports.jobs WHERE id=ANY($1::uuid[]) ORDER BY id", [[retiredForecast, expiredId, failedId]])).rows, before);
  assert((await administrator.query("SELECT published_at FROM sports.outbox WHERE id=ANY($1::uuid[])", [protectedEvents])).rows.every((row) => row.published_at === null));
  assert((await currentQueue.failures()).every((job) => job.id !== failedId && job.id !== expiredId));
  const reported = (await currentQueue.status()).reduce((total, row) => total + Number(row.count), 0);
  assert.equal(reported, (await administrator.query("SELECT count(*)::integer AS count FROM sports.jobs WHERE payload->>'provider'='sorare'")).rows[0].count);
});
