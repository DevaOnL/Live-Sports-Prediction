import type { Pool } from "pg";
import { prepareHistoricalInputs } from "../forecast/inputs";
import { METRICS, type HistoryAppearance } from "../forecast/types";
import { COVERAGE } from "../ingestion/coverage";
import { cutoffUtc, localDate } from "../ingestion/standings";
import { evaluateBacktest, FROZEN_EVALUATION, type BacktestCase } from "./scoring";

// Keep these guards identical to the canonical model and read API allowlist.
const APPROVED = `approved AS (
  SELECT cs.id AS season_id,cs.label,c.provider_id AS league_id,c.timezone
  FROM sports.competition_seasons cs JOIN sports.competitions c ON c.id=cs.competition_id
  WHERE c.provider='apifootball' AND c.enabled AND cs.enabled
    AND c.provider_id IN ('153','164') AND cs.label='2026/27'
    AND cs.starts_on=DATE '2026-07-01' AND cs.ends_on=DATE '2027-06-30' AND c.coefficient=1.5
    AND ((c.provider_id='153' AND cs.expected_clubs=24 AND c.timezone='Europe/London')
      OR (c.provider_id='164' AND cs.expected_clubs=18 AND c.timezone='Europe/Paris'))
)`;
const fields = { goals: "goals", assists: "assists", shotsOnTarget: "shots_on_target", keyPasses: "key_passes",
  tackles: "tackles", interceptions: "interceptions", saves: "saves", goalsConceded: "goals_conceded" } as const;
type TargetRow = {
  player_id: string; fixture_id: string; league_id: string; label: string; kickoff_at: Date;
  status: HistoryAppearance["status"]; home_id: string; away_id: string; club_id: string | null;
  membership_id: string | null; participation: HistoryAppearance["participation"]; minutes: number | null;
  rating: string | null; goals: number | null; assists: number | null; shots_on_target: number | null;
  key_passes: number | null; tackles: number | null; interceptions: number | null; saves: number | null; goals_conceded: number | null;
};
export type LeagueCoverage = {
  leagueId: string; season: string; datedFixtures: number; finalFixtures: number; finalsWithAppearances: number;
  finalsWithoutAppearances: number; finalsWithCompleteStatistics: number; finalsWithPartialStatistics: number;
  finalsWithMissingStatistics: number; finalsWithUnknownStatistics: number; undatedFixturesOutsideDatedDenominator: number;
  rosterSnapshots: number; firstRosterObservedAt: string | null; latestRosterObservedAt: string | null;
};

/** A fixed retrospective evaluation, never a refresh of live forecast revisions. */
export async function readFrozenEvaluation(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const identity = (await client.query<{ name: string; read_only: string }>(
      "SELECT current_user AS name,current_setting('transaction_read_only') AS read_only")).rows[0];
    if (identity.name !== "lsp_reader" || identity.read_only !== "on") throw new Error("Evaluation requires the restricted reader role");
    const source = (await client.query<{ snapshot_at: Date; ordinal: string; latest_retrieved_at: Date | null }>(
      `SELECT transaction_timestamp() AS snapshot_at,
        (SELECT coalesce(max(ordinal),0)::text FROM sports.normalized_revisions) AS ordinal,
        (SELECT max(retrieved_at) FROM sports.source_revisions) AS latest_retrieved_at`)).rows[0];
    const profile = await client.query<{
      league_id: string; label: string; dated_fixtures: number; final_fixtures: number; finals_with_appearances: number;
      finals_without_appearances: number; complete: number; partial: number; missing: number; unknown_statistics: number; undated: number;
      roster_snapshots: number; first_roster: Date | null; latest_roster: Date | null;
    }>(`WITH ${APPROVED}, fixtures AS (
      SELECT f.*,a.league_id,a.label,(f.kickoff_at AT TIME ZONE a.timezone)::date AS local_date,
        EXISTS(SELECT 1 FROM sports.appearances x WHERE x.fixture_id=f.id) AS has_appearances
      FROM approved a JOIN sports.fixtures f ON f.season_id=a.season_id AND f.provider='apifootball'
    ) SELECT a.league_id,a.label,
      count(f.id) FILTER (WHERE f.local_date BETWEEN $1::date AND $2::date)::int AS dated_fixtures,
      count(f.id) FILTER (WHERE f.local_date BETWEEN $1::date AND $2::date AND f.status='final')::int AS final_fixtures,
      count(f.id) FILTER (WHERE f.local_date BETWEEN $1::date AND $2::date AND f.status='final' AND f.has_appearances)::int AS finals_with_appearances,
      count(f.id) FILTER (WHERE f.local_date BETWEEN $1::date AND $2::date AND f.status='final' AND NOT f.has_appearances)::int AS finals_without_appearances,
      count(f.id) FILTER (WHERE f.local_date BETWEEN $1::date AND $2::date AND f.status='final' AND f.statistics_status='complete')::int AS complete,
      count(f.id) FILTER (WHERE f.local_date BETWEEN $1::date AND $2::date AND f.status='final' AND f.statistics_status='partial')::int AS partial,
      count(f.id) FILTER (WHERE f.local_date BETWEEN $1::date AND $2::date AND f.status='final' AND f.statistics_status='missing')::int AS missing,
      count(f.id) FILTER (WHERE f.local_date BETWEEN $1::date AND $2::date AND f.status='final' AND f.statistics_status='unknown')::int AS unknown_statistics,
      count(f.id) FILTER (WHERE f.kickoff_at IS NULL)::int AS undated,
      (SELECT count(*)::int FROM sports.roster_snapshots r WHERE r.season_id=a.season_id) AS roster_snapshots,
      (SELECT min(observed_at) FROM sports.roster_snapshots r WHERE r.season_id=a.season_id) AS first_roster,
      (SELECT max(observed_at) FROM sports.roster_snapshots r WHERE r.season_id=a.season_id) AS latest_roster
      FROM approved a LEFT JOIN fixtures f ON f.season_id=a.season_id
      GROUP BY a.season_id,a.league_id,a.label ORDER BY a.league_id`, [FROZEN_EVALUATION.holdoutStart, FROZEN_EVALUATION.holdoutEnd]);
    const targets = await client.query<TargetRow>(`WITH ${APPROVED}
      SELECT x.*,p.provider_id AS player_id,f.provider_id AS fixture_id,a.league_id,a.label,f.kickoff_at,f.status,
        h.provider_id AS home_id,w.provider_id AS away_id,c.provider_id AS club_id
      FROM approved a JOIN sports.fixtures f ON f.season_id=a.season_id AND f.provider='apifootball'
      JOIN sports.appearances x ON x.fixture_id=f.id JOIN sports.players p ON p.id=x.player_id AND p.provider='apifootball'
      JOIN sports.clubs h ON h.id=f.home_club_id JOIN sports.clubs w ON w.id=f.away_club_id
      LEFT JOIN sports.clubs c ON c.id=x.club_id
      WHERE (f.kickoff_at AT TIME ZONE a.timezone)::date BETWEEN $1::date AND $2::date
      ORDER BY a.league_id,f.kickoff_at,f.provider_id,p.provider_id`, [FROZEN_EVALUATION.holdoutStart, FROZEN_EVALUATION.holdoutEnd]);
    const groups = new Map<string, { cutoff: string; date: string; rows: TargetRow[] }>();
    for (const row of targets.rows) {
      const coverage = COVERAGE.find((item) => item.id === row.league_id)!;
      const date = localDate(row.kickoff_at.toISOString(), coverage.timezone);
      const key = `${row.league_id}:${date}`;
      if (!groups.has(key)) groups.set(key, { cutoff: cutoffUtc(date, coverage.timezone), date, rows: [] });
      groups.get(key)!.rows.push(row);
    }
    const cases: BacktestCase[] = [];
    for (const group of groups.values()) {
      const prepared = await prepareHistoricalInputs(client, group.cutoff, group.date, group.rows.map((row) => row.player_id));
      for (const row of group.rows) {
        const input = prepared.get(row.player_id)?.input;
        if (!input) throw new Error("Missing evaluation player");
        cases.push({ input, target: {
          fixtureId: row.fixture_id, leagueId: row.league_id, season: row.label,
          competition: row.league_id === "153" ? "championship" : "ligue_2", covered: true,
          kickoffAt: row.kickoff_at.toISOString(), status: row.status, homeClubId: row.home_id, awayClubId: row.away_id,
          clubId: row.club_id, membershipKnown: row.membership_id !== null && row.club_id !== null,
          participation: row.participation, minutes: row.minutes, rating: row.rating === null ? null : Number(row.rating),
          metrics: Object.fromEntries(METRICS.map((metric) => [metric, row[fields[metric]]])) as HistoryAppearance["metrics"],
          context: null,
        } });
      }
    }
    const evaluation = evaluateBacktest(cases, { snapshotAt: source.snapshot_at.toISOString(), sourceOrdinal: source.ordinal,
      latestRetrievedAt: source.latest_retrieved_at?.toISOString() ?? null });
    const coverage: LeagueCoverage[] = profile.rows.map((row) => ({ leagueId: row.league_id, season: row.label,
      datedFixtures: row.dated_fixtures, finalFixtures: row.final_fixtures, finalsWithAppearances: row.finals_with_appearances,
      finalsWithoutAppearances: row.finals_without_appearances, finalsWithCompleteStatistics: row.complete,
      finalsWithPartialStatistics: row.partial, finalsWithMissingStatistics: row.missing, finalsWithUnknownStatistics: row.unknown_statistics,
      undatedFixturesOutsideDatedDenominator: row.undated, rosterSnapshots: row.roster_snapshots,
      firstRosterObservedAt: row.first_roster?.toISOString() ?? null, latestRosterObservedAt: row.latest_roster?.toISOString() ?? null }));
    await client.query("COMMIT");
    return { report: { ...evaluation.report, fixtureCoverage: coverage }, audit: evaluation.audit };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
