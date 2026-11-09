import type { Pool, PoolClient } from "pg";
import { PublicApiError } from "./error";
import { evaluateForecast, inputHash } from "../forecast/engine";
import { prepareInputs } from "../forecast/inputs";
import type { SavedForecast } from "../forecast/store";
import { METRICS, type ForecastInput, type ForecastResult, type Metric, type Position } from "../forecast/types";

export class ReadError extends PublicApiError {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(status, code, message);
    this.name = "ReadError";
  }
}

export type SourceFreshness = { cutoffAt: string; sourceOrdinal: string; latestRetrievedAt: string | null };
export type PlayerFilters = {
  q?: string; leagueId?: string; clubId?: string; position?: Position;
  availability?: "available" | "partial" | "unavailable" | "uncomputed";
  page?: number; pageSize?: number;
};
export type PlayerSummary = {
  id: string; name: string; position: Position;
  currentClub: { id: string; name: string; leagueId: string; leagueName: string; season: string } | null;
  currentClubReasons: string[];
  forecast: {
    kind: "stored-evaluation"; status: "available" | "partial" | "unavailable" | "uncomputed";
    checkedAt: string | null; evaluationCutoffAt: string | null; sourceOrdinal: string | null;
  };
};

// These guards deliberately match the ingestion/model allowlist. A matching ID
// alone must not enable a different season, coefficient or competition context.
const APPROVED = `approved AS (
  SELECT cs.id AS season_id,cs.label,cs.expected_clubs,c.provider_id AS league_id,
    c.name AS league_name,c.country_name,c.timezone,c.coefficient
  FROM sports.competition_seasons cs JOIN sports.competitions c ON c.id=cs.competition_id
  WHERE c.provider='apifootball' AND c.enabled AND cs.enabled
    AND c.provider_id IN ('153','164') AND cs.label='2026/27'
    AND cs.starts_on=DATE '2026-07-01' AND cs.ends_on=DATE '2027-06-30' AND c.coefficient=1.5
    AND ((c.provider_id='153' AND cs.expected_clubs=24 AND c.timezone='Europe/London')
      OR (c.provider_id='164' AND cs.expected_clubs=18 AND c.timezone='Europe/Paris'))
)`;

// Equal-time roster observations are considered together. Incomplete latest
// evidence, conflicting clubs, and simultaneous inclusion/exclusion cannot be
// resolved by an arbitrary database UUID or an old appearance.
const CATALOGUE = `${APPROVED}, catalogue AS (
  SELECT p.* FROM sports.players p WHERE p.provider='apifootball' AND (
    EXISTS (SELECT 1 FROM sports.appearances x JOIN sports.fixtures f ON f.id=x.fixture_id
      JOIN approved a ON a.season_id=f.season_id WHERE x.player_id=p.id AND f.provider='apifootball')
    OR EXISTS (SELECT 1 FROM sports.roster_entries e JOIN approved a ON a.season_id=e.season_id WHERE e.player_id=p.id)
  )
), latest_times AS (
  SELECT a.season_id,max(r.observed_at) AS observed_at FROM approved a
  LEFT JOIN sports.roster_snapshots r ON r.season_id=a.season_id AND r.observed_at<=$1::timestamptz
  GROUP BY a.season_id
), latest_rosters AS (
  SELECT r.* FROM sports.roster_snapshots r JOIN latest_times t
    ON t.season_id=r.season_id AND t.observed_at=r.observed_at
), claims AS (
  SELECT p.id AS player_id,a.season_id,count(r.id) AS observations,
    coalesce(bool_and(r.complete),false) AS complete,
    count(DISTINCT e.club_id) AS clubs,max(e.club_id::text) AS club_id,
    coalesce(bool_and(e.player_id IS NOT NULL),false) AS all_present
  FROM catalogue p CROSS JOIN approved a
  LEFT JOIN latest_rosters r ON r.season_id=a.season_id
  LEFT JOIN sports.roster_entries e ON e.snapshot_id=r.id AND e.player_id=p.id
  GROUP BY p.id,a.season_id
), resolved AS (
  SELECT player_id,
    bool_and(observations>0 AND complete AND clubs<=1 AND (clubs=0 OR all_present)) AND sum(clubs)=1 AS known,
    max(club_id) FILTER (WHERE clubs=1) AS club_id,
    max(season_id::text) FILTER (WHERE clubs=1) AS season_id,
    bool_or(observations=0) AS missing_roster,bool_or(observations>0 AND NOT complete) AS incomplete_roster,
    bool_or(clubs>1 OR (clubs>0 AND NOT all_present)) OR sum(clubs)>1 AS ambiguous_roster
  FROM claims GROUP BY player_id
), summaries AS (
  SELECT p.id AS sql_id,p.provider_id,p.name,p.position,
    CASE WHEN r.known THEN c.provider_id END AS club_id,
    CASE WHEN r.known THEN c.name END AS club_name,
    CASE WHEN r.known THEN a.league_id END AS league_id,
    CASE WHEN r.known THEN a.league_name END AS league_name,
    CASE WHEN r.known THEN a.label END AS season,
    r.missing_roster,r.incomplete_roster,r.ambiguous_roster,
    coalesce(f.result_json->>'status','uncomputed') AS availability,
    h.checked_at,h.evaluation_cutoff_at,h.evaluation_source_ordinal::text
  FROM catalogue p LEFT JOIN resolved r ON r.player_id=p.id
  LEFT JOIN sports.clubs c ON c.id=r.club_id::uuid AND c.provider='apifootball'
  LEFT JOIN approved a ON a.season_id=r.season_id::uuid
  LEFT JOIN sports.forecast_heads h ON h.player_id=p.id
  LEFT JOIN sports.forecast_revisions f ON f.id=h.revision_id
)`;

type SummaryRow = {
  sql_id: string; provider_id: string; name: string; position: Position;
  club_id: string | null; club_name: string | null; league_id: string | null; league_name: string | null; season: string | null;
  missing_roster: boolean; incomplete_roster: boolean; ambiguous_roster: boolean;
  availability: PlayerSummary["forecast"]["status"]; checked_at: Date | null; evaluation_cutoff_at: Date | null; evaluation_source_ordinal: string | null;
};
const iso = (value: Date | string) => new Date(value).toISOString();
const positions: Position[] = ["GK", "DEF", "MID", "FWD", "UNKNOWN"];
const positionMetrics: Record<Position, Metric[]> = {
  FWD: ["goals", "assists", "shotsOnTarget"], MID: ["assists", "keyPasses", "tackles"],
  DEF: ["tackles", "interceptions"], GK: ["saves", "goalsConceded"], UNKNOWN: [],
};
const invalid = (code = "invalid_input", message = "Invalid request parameters."): never => { throw new ReadError(400, code, message); };
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[1-9]\d{0,17}$/.test(value) || !Number.isSafeInteger(Number(value))) invalid("invalid_identifier", "Invalid provider identifier.");
}
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function league(value: unknown) {
  if (value !== undefined && value !== "153" && value !== "164") invalid("invalid_league", "Unsupported competition.");
}
function summary(row: SummaryRow): PlayerSummary {
  const reasons = [
    ...(row.missing_roster ? ["missing_roster_observation"] : []),
    ...(row.incomplete_roster ? ["incomplete_roster_observation"] : []),
    ...(row.ambiguous_roster ? ["ambiguous_current_club"] : []),
  ];
  if (!row.club_id && !reasons.length) reasons.push("unknown_current_club");
  return {
    id: row.provider_id, name: row.name, position: row.position,
    currentClub: row.club_id ? { id: row.club_id, name: row.club_name!, leagueId: row.league_id!, leagueName: row.league_name!, season: row.season! } : null,
    currentClubReasons: reasons,
    forecast: { kind: "stored-evaluation", status: row.availability, checkedAt: row.checked_at ? iso(row.checked_at) : null,
      evaluationCutoffAt: row.evaluation_cutoff_at ? iso(row.evaluation_cutoff_at) : null, sourceOrdinal: row.evaluation_source_ordinal },
  };
}

/** Only canonical model provenance is exposed, never archive references/payloads. */
function publicProvenance(value: Record<string, unknown>): Record<string, unknown> {
  const keys = ["sourceOrdinal", "playerRevisionId", "appearanceRevisionIds", "fixtureRevisionIds", "rosterObservations", "coverage"];
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

export class ReadService {
  constructor(private readonly pool: Pool) {}

  private async snapshot<T>(operation: (client: PoolClient, source: SourceFreshness) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const row = (await client.query<{ cutoff_at: Date; source_ordinal: string; latest_retrieved_at: Date | null }>(
        `SELECT transaction_timestamp() AS cutoff_at,coalesce(max(n.ordinal),0)::text AS source_ordinal,
          max(s.retrieved_at) AS latest_retrieved_at FROM sports.normalized_revisions n
          LEFT JOIN sports.source_revisions s ON s.id=n.source_revision_id AND s.provider='apifootball'`)).rows[0];
      const source = { cutoffAt: iso(row.cutoff_at), sourceOrdinal: row.source_ordinal, latestRetrievedAt: row.latest_retrieved_at ? iso(row.latest_retrieved_at) : null };
      const result = await operation(client, source);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async identity(client: PoolClient, source: SourceFreshness, playerId: string): Promise<{ row: SummaryRow; player: PlayerSummary }> {
    const row = (await client.query<SummaryRow>(`WITH ${CATALOGUE} SELECT * FROM summaries WHERE provider_id=$2`, [source.cutoffAt, playerId])).rows[0];
    if (!row) throw new ReadError(404, "player_not_found", "Player not found in enabled coverage.");
    return { row, player: summary(row) };
  }

  private async stored(client: PoolClient, sqlPlayerId: string): Promise<SavedForecast | null> {
    const row = (await client.query<{
      id: string; ordinal: string; provider_id: string; parent_id: string | null; model_version: string; input_hash: string;
      source_ordinal: string; cutoff_at: Date; created_at: Date; input_json: ForecastInput; provenance_json: Record<string, unknown>; result_json: ForecastResult;
      evaluation_cutoff_at: Date; evaluation_source_ordinal: string; evaluation_provenance_json: Record<string, unknown>; checked_at: Date;
    }>(`SELECT r.*,p.provider_id,h.evaluation_cutoff_at,h.evaluation_source_ordinal,h.evaluation_provenance_json,h.checked_at
      FROM sports.forecast_heads h JOIN sports.forecast_revisions r ON r.id=h.revision_id
      JOIN sports.players p ON p.id=h.player_id WHERE h.player_id=$1`, [sqlPlayerId])).rows[0];
    return row ? {
      id: row.id, ordinal: row.ordinal, playerId: row.provider_id, parentId: row.parent_id, modelVersion: row.model_version,
      inputHash: row.input_hash, sourceOrdinal: row.source_ordinal, cutoffAt: iso(row.cutoff_at), createdAt: iso(row.created_at),
      input: row.input_json, provenance: publicProvenance(row.provenance_json), result: row.result_json,
      evaluation: { cutoffAt: iso(row.evaluation_cutoff_at), sourceOrdinal: row.evaluation_source_ordinal,
        provenance: publicProvenance(row.evaluation_provenance_json), checkedAt: iso(row.checked_at) },
    } : null;
  }

  async overview() {
    return this.snapshot(async (client, source) => {
      const row = (await client.query<{ competitions: number; clubs: number; players: number; available: number; partial: number; unavailable: number; uncomputed: number }>(
        `WITH ${CATALOGUE} SELECT (SELECT count(*)::integer FROM approved) AS competitions,
          (SELECT count(DISTINCT sc.club_id)::integer FROM sports.season_clubs sc JOIN approved a ON a.season_id=sc.season_id
            JOIN sports.clubs c ON c.id=sc.club_id WHERE c.provider='apifootball') AS clubs,
          count(*)::integer AS players,count(*) FILTER(WHERE availability='available')::integer AS available,
          count(*) FILTER(WHERE availability='partial')::integer AS partial,
          count(*) FILTER(WHERE availability='unavailable')::integer AS unavailable,
          count(*) FILTER(WHERE availability='uncomputed')::integer AS uncomputed FROM summaries`, [source.cutoffAt])).rows[0];
      return { counts: { competitions: row.competitions, clubs: row.clubs, players: row.players,
        forecasts: { available: row.available, partial: row.partial, unavailable: row.unavailable, uncomputed: row.uncomputed } }, source };
    });
  }

  async competitions() {
    return this.snapshot(async (client, source) => {
      const rows = (await client.query<{ league_id: string; league_name: string; country_name: string; label: string; timezone: string; expected_clubs: number; coefficient: string }>(
        `WITH ${APPROVED} SELECT * FROM approved ORDER BY league_id COLLATE "C"`)).rows;
      return { items: rows.map((row) => ({ id: row.league_id, name: row.league_name, country: row.country_name, season: row.label,
        timezone: row.timezone, expectedClubs: row.expected_clubs, coefficient: Number(row.coefficient) })), source };
    });
  }

  async clubs(filters: { leagueId?: string } = {}) {
    fields(filters, ["leagueId"]); league(filters.leagueId);
    return this.snapshot(async (client, source) => {
      const rows = (await client.query<{ provider_id: string; name: string; league_id: string; league_name: string; label: string }>(
        `WITH ${APPROVED} SELECT c.provider_id,c.name,a.league_id,a.league_name,a.label FROM sports.clubs c
          JOIN sports.season_clubs sc ON sc.club_id=c.id JOIN approved a ON a.season_id=sc.season_id
          WHERE c.provider='apifootball' AND ($1::text IS NULL OR a.league_id=$1)
          ORDER BY a.league_id COLLATE "C",c.name,c.provider_id COLLATE "C"`, [filters.leagueId ?? null])).rows;
      return { items: rows.map((row) => ({ id: row.provider_id, name: row.name, leagueId: row.league_id, leagueName: row.league_name, season: row.label })), source };
    });
  }

  async players(filters: PlayerFilters = {}) {
    fields(filters, ["q", "leagueId", "clubId", "position", "availability", "page", "pageSize"]);
    league(filters.leagueId);
    if (filters.clubId !== undefined) identifier(filters.clubId);
    if (filters.position !== undefined && !positions.includes(filters.position)) invalid("invalid_position", "Unsupported player position.");
    if (filters.availability !== undefined && !["available", "partial", "unavailable", "uncomputed"].includes(filters.availability)) invalid("invalid_availability", "Unsupported forecast availability.");
    if (filters.q !== undefined && (typeof filters.q !== "string" || filters.q.length > 80 || /[\u0000-\u001f\u007f]/.test(filters.q))) invalid("invalid_search", "Search must contain at most 80 characters.");
    const page = filters.page === undefined ? 1 : filters.page;
    const pageSize = filters.pageSize === undefined ? 20 : filters.pageSize;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50
      || !Number.isSafeInteger((page - 1) * pageSize)) invalid("invalid_pagination", "Invalid catalogue page or page size.");
    const search = filters.q?.trim().replace(/[\\%_]/g, "\\$&");
    return this.snapshot(async (client, source) => {
      if (filters.clubId) {
        const found = await client.query(`WITH ${APPROVED} SELECT 1 FROM sports.clubs c JOIN sports.season_clubs sc ON sc.club_id=c.id
          JOIN approved a ON a.season_id=sc.season_id WHERE c.provider='apifootball' AND c.provider_id=$1
          AND ($2::text IS NULL OR a.league_id=$2) LIMIT 1`, [filters.clubId, filters.leagueId ?? null]);
        if (!found.rowCount) invalid("invalid_club", "Club not found in the selected enabled coverage.");
      }
      const values = [source.cutoffAt, search ? `%${search}%` : null, filters.leagueId ?? null, filters.clubId ?? null, filters.position ?? null, filters.availability ?? null];
      const condition = `($2::text IS NULL OR name ILIKE $2 ESCAPE '\\') AND ($3::text IS NULL OR league_id=$3)
        AND ($4::text IS NULL OR club_id=$4) AND ($5::text IS NULL OR position=$5) AND ($6::text IS NULL OR availability=$6)`;
      const total = (await client.query<{ total: number }>(`WITH ${CATALOGUE} SELECT count(*)::integer AS total FROM summaries WHERE ${condition}`, values)).rows[0].total;
      const rows = (await client.query<SummaryRow>(`WITH ${CATALOGUE} SELECT * FROM summaries WHERE ${condition}
        ORDER BY name,provider_id COLLATE "C" LIMIT $7 OFFSET $8`, [...values, pageSize, (page - 1) * pageSize])).rows;
      return { items: rows.map(summary), pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) }, source };
    });
  }

  async player(playerId: string) {
    identifier(playerId);
    return this.snapshot(async (client, source) => {
      const identity = await this.identity(client, source, playerId);
      const rows = (await client.query<{
        fixture_id: string; league_id: string; season: string; kickoff_at: Date | null; status: string; statistics_status: string;
        home_id: string; home_name: string; away_id: string; away_name: string; club_id: string | null; club_name: string | null;
        participation: string; minutes: number | null; rating: string | null; goals: number | null; assists: number | null;
        shots_on_target: number | null; key_passes: number | null; tackles: number | null; interceptions: number | null; saves: number | null; goals_conceded: number | null;
      }>(`WITH ${APPROVED} SELECT f.provider_id AS fixture_id,a.league_id,a.label AS season,f.kickoff_at,f.status,f.statistics_status,
          home.provider_id AS home_id,home.name AS home_name,away.provider_id AS away_id,away.name AS away_name,
          club.provider_id AS club_id,club.name AS club_name,x.participation,x.minutes,x.rating,x.goals,x.assists,
          x.shots_on_target,x.key_passes,x.tackles,x.interceptions,x.saves,x.goals_conceded
        FROM sports.appearances x JOIN sports.fixtures f ON f.id=x.fixture_id JOIN approved a ON a.season_id=f.season_id
        JOIN sports.clubs home ON home.id=f.home_club_id JOIN sports.clubs away ON away.id=f.away_club_id
        LEFT JOIN sports.clubs club ON club.id=x.club_id WHERE x.player_id=$1 AND f.provider='apifootball'
        ORDER BY f.kickoff_at DESC NULLS FIRST,f.provider_id COLLATE "C" DESC LIMIT 50`, [identity.row.sql_id])).rows;
      const observedAppearances = rows.map((row) => ({
        fixtureId: row.fixture_id, leagueId: row.league_id, season: row.season, kickoffAt: row.kickoff_at ? iso(row.kickoff_at) : null,
        status: row.status, statisticsStatus: row.statistics_status,
        homeClub: { id: row.home_id, name: row.home_name }, awayClub: { id: row.away_id, name: row.away_name },
        club: row.club_id ? { id: row.club_id, name: row.club_name! } : null,
        participation: row.participation, minutes: row.minutes, rating: row.rating === null ? null : Number(row.rating),
        metrics: { goals: row.goals, assists: row.assists, shotsOnTarget: row.shots_on_target, keyPasses: row.key_passes,
          tackles: row.tackles, interceptions: row.interceptions, saves: row.saves, goalsConceded: row.goals_conceded },
      }));
      return { player: identity.player, observedAppearances, observedLimit: 50 as const,
        forecast: await this.stored(client, identity.row.sql_id), source };
    });
  }

  async forecast(playerId: string) {
    identifier(playerId);
    return this.snapshot(async (client, source) => {
      const identity = await this.identity(client, source, playerId);
      return { player: identity.player, forecast: await this.stored(client, identity.row.sql_id), source };
    });
  }

  async compare(playerIds: readonly string[], allowCrossPosition = false) {
    if (!Array.isArray(playerIds) || playerIds.length < 2 || playerIds.length > 4 || new Set(playerIds).size !== playerIds.length
      || typeof allowCrossPosition !== "boolean") invalid("invalid_comparison", "Choose two to four distinct players.");
    playerIds.forEach(identifier);
    return this.snapshot(async (client, source) => {
      const identities: { row: SummaryRow; player: PlayerSummary }[] = [];
      for (const playerId of playerIds) identities.push(await this.identity(client, source, playerId));
      const crossPosition = new Set(identities.map(({ player }) => player.position)).size > 1;
      if (crossPosition && !allowCrossPosition) invalid("position_mismatch", "Cross-position comparison requires explicit opt-in.");
      const sharedMetrics = METRICS.filter((metric) => identities.every(({ player }) => positionMetrics[player.position].includes(metric)));
      const prepared = await prepareInputs(client, source.cutoffAt, playerIds);
      const players = [];
      for (const { row, player } of identities) {
        const evidence = prepared.get(player.id)!;
        const evaluated = evaluateForecast(evidence.input);
        const hash = inputHash(evidence.input, evaluated);
        const projected90 = Object.fromEntries(sharedMetrics.map((metric) => [metric, evaluated.projected90[metric]!])) as ForecastResult["projected90"];
        const outputs = [evaluated.adjustedFormIndex, evaluated.forecastRating, evaluated.displayedForecastRating, ...Object.values(projected90)];
        const available = outputs.filter((output) => output.status === "available").length;
        const result: ForecastResult = { ...evaluated, projected90,
          status: available === 0 ? "unavailable" : available === outputs.length && player.position !== "UNKNOWN" ? "available" : "partial",
          reasons: evaluated.reasons.filter((reason) => !reason.field || !METRICS.includes(reason.field as Metric) || sharedMetrics.includes(reason.field as Metric)),
        };
        const stored = await this.stored(client, row.sql_id);
        // Hash/status describe the full canonical evaluation. `result` is the
        // comparison display projection and may omit unavailable unshared metrics.
        players.push({ player, canonicalInputHash: hash, canonicalStatus: evaluated.status,
          input: evidence.input, provenance: publicProvenance(evidence.provenance), result,
          storedRevision: stored ? { id: stored.id, ordinal: stored.ordinal, inputHash: stored.inputHash, cutoffAt: stored.cutoffAt } : null });
      }
      return { kind: "transient-comparison" as const, cutoffAt: source.cutoffAt, sourceOrdinal: source.sourceOrdinal,
        crossPosition, sharedMetrics, notice: crossPosition ? "Players have different positions. Only shared position statistics with matching per-90 units are shown." : null,
        players, source };
    });
  }
}
