import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type pg from "pg";
import { ForecastStore } from "../../src/server/forecast/store";
import { coverageFor } from "../../src/server/ingestion/coverage";
import { IngestionPipeline } from "../../src/server/ingestion/pipeline";
import type { ProviderAction } from "../../src/server/ingestion/types";

const cutoffAt = "2026-08-10T12:00:00.000Z";
const positions = ["Goalkeepers", "Defenders", "Midfielders", "Forwards"] as const;
const playerIds = positions.map((_, index) => String(8001 + index));
const clubs = Array.from({ length: 24 }, (_, index) => ({
  id: index === 0 ? "3072" : String(5000 + index),
  name: `Synthetic demo club ${String(index + 1).padStart(2, "0")}`,
}));

function player(index: number) {
  return { player_key: playerIds[index], player_name: `Synthetic demo ${positions[index].toLowerCase()}`,
    player_type: positions[index] };
}

function statistics(index: number, matchday: number, rating = "7.5") {
  const dnp = matchday === 7;
  return {
    ...player(index), team_key: clubs[0].id, team_name: "home",
    player_minutes_played: String(matchday === 1 ? 60 : matchday === 6 ? 59 : dnp ? 0 : 97),
    player_rating: dnp ? "0" : rating,
    player_goals: !dnp && index === 3 && matchday === 3 ? null : String(!dnp && index === 3 ? 1 : 0),
    player_assists: String(!dnp && index === 2 ? 1 : 0),
    player_shots_on_goal: String(!dnp && index === 3 ? 2 : 0),
    player_key_passes: String(!dnp && index === 2 ? 2 : 0),
    player_tackles: String(dnp ? 0 : index === 1 ? 2 : index === 2 ? 1 : 0),
    player_interceptions: String(!dnp && index === 1 ? 1 : 0),
    player_saves: String(!dnp && index === 0 ? 4 : 0),
    player_goals_conceded: String(!dnp && index === 0 ? 1 : 0),
  };
}

/** Synthetic assignment fixtures only. The caller must own disposable servers. */
export async function seedDemo(pool: pg.Pool, db: Db): Promise<{
  playerIds: string[]; cutoffAt: string; fixtures: number; players: number; revisions: number;
}> {
  const guard = await pool.connect();
  try {
    await guard.query("SELECT pg_advisory_lock(hashtextextended('lsp:synthetic-demo-seed',0))");
    const sqlDatabase = (await guard.query<{ name: string }>("SELECT current_database() AS name")).rows[0].name;
    const disposableName = /^[a-z][a-z0-9_]{0,57}_(?:demo|test)$/;
    if (!disposableName.test(sqlDatabase) || !disposableName.test(db.databaseName)) {
      throw new Error("Synthetic seeding requires dedicated _demo or _test databases");
    }
    const tables = (await guard.query<{ tablename: string }>(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='sports' ORDER BY tablename")).rows;
    if (!tables.length || tables.some(({ tablename }) => !/^[a-z_]+$/.test(tablename))) throw new Error("Canonical schema is not ready");
    const occupied = await guard.query<{ occupied: boolean }>(`SELECT ${tables.map(({ tablename }) =>
      `EXISTS(SELECT 1 FROM sports.${tablename})`).join(" OR ")} AS occupied`);
    const [raw, metadata] = await Promise.all([
      db.collection("raw_archives").findOne({}, { projection: { _id: 1 } }),
      db.collection("import_metadata").findOne({}, { projection: { _id: 1 } }),
    ]);
    if (occupied.rows[0].occupied || raw || metadata) throw new Error("Synthetic seeding refuses existing football or archive data");

    const pipeline = new IngestionPipeline(pool, db, "synthetic-offline-demo");
    const observe = async (action: ProviderAction, params: Record<string, string>, payload: unknown, retrievedAt: string) => {
      const text = JSON.stringify(payload);
      const approved = Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
      const archive = await pipeline.archives.save({ action, params: approved,
        resourceKey: JSON.stringify({ action, params: approved }), retrievedAt, text,
        contentSha256: createHash("sha256").update(text).digest("hex") });
      await pipeline.reconcile();
      const marker = await db.collection("import_metadata").findOne({ _id: archive.id } as never);
      if (marker?.state !== "imported") throw new Error("Synthetic observation did not import");
    };

    await observe("get_teams", { league_id: "153" }, clubs.map((club, index) => ({
      team_key: club.id, team_name: club.name, players: index === 0 ? positions.map((_, playerIndex) => player(playerIndex)) : [],
    })), "2026-07-01T00:00:00.000Z");

    const fixtures = [];
    for (let home = 0; home < clubs.length; home++) for (let away = 0; away < clubs.length; away++) {
      if (home === away) continue;
      const finished = home === 0 && away <= 7;
      fixtures.push({
        match_id: String(900000 + home * 100 + away), league_id: "153", league_year: "2026/27", stage_name: "Regular Season",
        match_hometeam_id: clubs[home].id, match_hometeam_name: clubs[home].name,
        match_awayteam_id: clubs[away].id, match_awayteam_name: clubs[away].name,
        match_date: finished ? `2026-08-0${away}` : home === 0 && away === 8 ? "2026-08-20" : "2027-01-20",
        match_time: "15:00", match_status: finished ? "Finished" : "Not Started",
        match_hometeam_score: finished ? "2" : "", match_awayteam_score: finished ? "1" : "",
        ...(finished ? { player_stats: { home: positions.map((_, index) => statistics(index, away)), away: [] } } : {}),
      });
    }
    await observe("get_events", { league_id: "153", from: "2026-07-01", to: "2027-06-30", timezone: "UTC" },
      fixtures, "2026-08-10T11:00:00.000Z");
    await pipeline.store.rebuild(coverageFor("153"), "2026-08-10");
    const forecasts = new ForecastStore(pool);
    await forecasts.refreshAll(cutoffAt);
    for (const [index, rating] of ["8.5", "7.5"].entries()) {
      await observe("get_statistics", { league_id: "153", match_id: "900005" }, {
        player_statistics: positions.map((_, playerIndex) => ({
          ...statistics(playerIndex, 5, playerIndex === 0 ? rating : "7.5"), match_id: "900005",
        })),
      }, `2026-08-10T11:0${index + 1}:00.000Z`);
      await forecasts.refreshAll(cutoffAt);
    }
    const counts = (await guard.query<{ fixtures: number; players: number; revisions: number }>(
      `SELECT (SELECT count(*)::integer FROM sports.fixtures) AS fixtures,
        (SELECT count(*)::integer FROM sports.players) AS players,
        (SELECT count(*)::integer FROM sports.forecast_revisions) AS revisions`)).rows[0];
    if (counts.fixtures !== 552 || counts.players !== 4 || counts.revisions !== 6) throw new Error("Synthetic seed verification failed");
    return { playerIds: [...playerIds], cutoffAt, ...counts };
  } finally {
    await guard.query("SELECT pg_advisory_unlock(hashtextextended('lsp:synthetic-demo-seed',0))").catch(() => undefined);
    guard.release();
  }
}
