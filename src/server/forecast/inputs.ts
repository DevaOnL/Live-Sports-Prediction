import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { COVERAGE } from "../ingestion/coverage";
import { LEGACY_SOURCE, sourceSeasonGuard, type SourceProfile } from "../ingestion/sources";
import { cutoffUtc, localDate, reconstructStandings } from "../ingestion/standings";
import type { Club, Coverage, Fixture, Player } from "../ingestion/types";
import { canonicalJson } from "./engine";
import { METRICS, type Context, type CurrentClub, type EligibilityGap, type ForecastInput, type HistoryAppearance, type Match, type PreparedInput, type Reason } from "./types";

type Season = { id: string; coverage: Coverage; revisionId: string | null; clubs: Club[] };
type StoredFixture = Fixture & { sqlId: string; seasonId: string; revisionId: string | null };
type StoredAppearance = {
  player_id: string; fixture_id: string; club_id: string | null; membership_id: string | null;
  participation: HistoryAppearance["participation"]; minutes: number | null; rating: string | null;
  goals: number | null; assists: number | null; shots_on_target: number | null; key_passes: number | null;
  tackles: number | null; interceptions: number | null; saves: number | null; goals_conceded: number | null;
  normalized_revision_id: string | null;
};
type Roster = { id: string; seasonId: string; observedAt: string; complete: boolean; sourceId: string; entries: Map<string, string[]> };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const iso = (value: Date | string) => new Date(value).toISOString();
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const fields = {
  goals: "goals", assists: "assists", shotsOnTarget: "shots_on_target", keyPasses: "key_passes",
  tackles: "tackles", interceptions: "interceptions", saves: "saves", goalsConceded: "goals_conceded",
} as const;

function rosterEvidence(observations: Roster[], playerId: string) {
  const clubs = [...new Set(observations.flatMap((roster) => roster.entries.get(playerId) ?? []))].sort(compare);
  return {
    clubs,
    incomplete: observations.some((roster) => !roster.complete),
    ambiguous: clubs.length > 1 || (clubs.length > 0 && observations.some((roster) => !roster.entries.get(playerId)?.length)),
  };
}

function match(fixture: StoredFixture, profile: SourceProfile): Match {
  return {
    fixtureId: fixture.id, leagueId: fixture.leagueId, season: fixture.season,
    competition: profile.competitionCodes[fixture.leagueId],
    kickoffAt: fixture.kickoffAt, status: fixture.status,
    homeClubId: fixture.home.id, awayClubId: fixture.away.id,
  };
}

/** One consistent batch of canonical evidence; callers serialize against ingestion. */
export async function prepareInputs(client: PoolClient, cutoffAt: string, providerPlayerIds?: readonly string[]): Promise<Map<string, PreparedInput>> {
  return prepare(client, cutoffAt, providerPlayerIds);
}

export async function prepareSourceInputs(client: PoolClient, cutoffAt: string, profile: SourceProfile, providerPlayerIds?: readonly string[]): Promise<Map<string, PreparedInput>> {
  return prepare(client, cutoffAt, providerPlayerIds, undefined, false, profile);
}

/** Observed eligibility evidence for scouting, without forecast context or provenance copies. */
export async function prepareObservedInputs(client: PoolClient, cutoffAt: string, profile: SourceProfile = LEGACY_SOURCE): Promise<Map<string, PreparedInput>> {
  return prepare(client, cutoffAt, undefined, undefined, true, profile);
}

/** Retrospectively corrected schedule with outcomes after the frozen date hidden. */
export async function prepareHistoricalInputs(client: PoolClient, cutoffAt: string, date: string, providerPlayerIds: readonly string[]): Promise<Map<string, PreparedInput>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !COVERAGE.some((league) => cutoffUtc(date, league.timezone) === cutoffAt)) throw new RangeError("Invalid historical cutoff");
  return prepare(client, cutoffAt, providerPlayerIds, date);
}

async function prepare(client: PoolClient, cutoffAt: string, providerPlayerIds?: readonly string[], historicalDate?: string, observationOnly = false,
  profile: SourceProfile = LEGACY_SOURCE): Promise<Map<string, PreparedInput>> {
  const cutoff = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoff)) throw new RangeError("Invalid forecast cutoff");
  cutoffAt = new Date(cutoff).toISOString();
  const provider = `'${profile.provider.replaceAll("'", "''")}'`;
  const seasonRows = await client.query<{
    id: string; league_id: string; label: string; normalized_revision_id: string | null;
  }>(`SELECT cs.id,c.provider_id AS league_id,cs.label,cs.normalized_revision_id
      FROM sports.competition_seasons cs JOIN sports.competitions c ON c.id=cs.competition_id
      WHERE ${sourceSeasonGuard(profile)}
      ORDER BY c.provider_id,cs.id`);
  const seasons = new Map<string, Season>();
  for (const row of seasonRows.rows) {
    const coverage = profile.coverage.find((candidate) => candidate.id === row.league_id && candidate.season === row.label)!;
    seasons.set(row.id, { id: row.id, coverage, revisionId: row.normalized_revision_id, clubs: [] });
  }
  const seasonIds = [...seasons.keys()];
  const players = await client.query<{ id: string; provider_id: string; position: Player["position"]; normalized_revision_id: string | null }>(
    `SELECT id,provider_id,position,normalized_revision_id FROM sports.players
     WHERE provider=${provider} AND ($1::text[] IS NULL OR provider_id=ANY($1::text[])) ORDER BY provider_id`,
    [providerPlayerIds ? [...new Set(providerPlayerIds)] : null],
  );
  const registrations = await client.query<{ season_id: string; provider_id: string; name: string }>(
      `SELECT sc.season_id,c.provider_id,c.name FROM sports.season_clubs sc
       JOIN sports.clubs c ON c.id=sc.club_id WHERE sc.season_id=ANY($1::uuid[]) AND c.provider=${provider} ORDER BY sc.season_id,c.provider_id`, [seasonIds]);
  const fixtureRows = await client.query<{
      id: string; provider_id: string; season_id: string; kickoff_at: Date | null; status: Fixture["status"];
      statistics_status: Fixture["statisticsStatus"]; home_score: number | null; away_score: number | null;
      home_id: string; home_name: string; away_id: string; away_name: string; normalized_revision_id: string | null;
    }>(`SELECT f.*,h.provider_id AS home_id,h.name AS home_name,a.provider_id AS away_id,a.name AS away_name
        FROM sports.fixtures f JOIN sports.clubs h ON h.id=f.home_club_id JOIN sports.clubs a ON a.id=f.away_club_id
        WHERE f.provider=${provider} AND f.season_id=ANY($1::uuid[]) ORDER BY f.provider_id`, [seasonIds]);
  const appearanceRows = await client.query<StoredAppearance>(
      `SELECT a.*,c.provider_id AS club_id FROM sports.appearances a
       JOIN sports.fixtures f ON f.id=a.fixture_id LEFT JOIN sports.clubs c ON c.id=a.club_id
       WHERE f.provider=${provider} AND f.season_id=ANY($1::uuid[]) AND a.player_id=ANY($2::uuid[]) ORDER BY a.player_id,a.fixture_id`,
      [seasonIds, players.rows.map((player) => player.id)]);
  const rosterRows = await client.query<{ id: string; season_id: string; observed_at: Date; complete: boolean; source_revision_id: string }>(
      `SELECT id,season_id,observed_at,complete,source_revision_id FROM sports.roster_snapshots
       WHERE season_id=ANY($1::uuid[]) AND observed_at <= $2::timestamptz
       ORDER BY observed_at,id`, [seasonIds, cutoffAt]);
  const entryRows = await client.query<{ snapshot_id: string; player_id: string; provider_id: string }>(
      `SELECT re.snapshot_id,re.player_id,c.provider_id FROM sports.roster_entries re
       JOIN sports.roster_snapshots rs ON rs.id=re.snapshot_id JOIN sports.clubs c ON c.id=re.club_id
       WHERE rs.season_id=ANY($1::uuid[]) AND rs.observed_at <= $2::timestamptz
         AND re.player_id=ANY($3::uuid[]) ORDER BY re.snapshot_id,re.player_id,c.provider_id`,
      [seasonIds, cutoffAt, players.rows.map((player) => player.id)]);
  const ordinal = await client.query<{ ordinal: string }>("SELECT coalesce(max(ordinal),0)::text AS ordinal FROM sports.normalized_revisions");
  for (const row of registrations.rows) seasons.get(row.season_id)!.clubs.push({ id: row.provider_id, name: row.name });
  const fixtures: StoredFixture[] = fixtureRows.rows.map((row) => {
    const season = seasons.get(row.season_id)!;
    const kickoffAt = row.kickoff_at ? iso(row.kickoff_at) : null;
    const hidden = Boolean(historicalDate && kickoffAt && (Date.parse(kickoffAt) >= cutoff || localDate(kickoffAt, season.coverage.timezone) >= historicalDate));
    return {
      sqlId: row.id, id: row.provider_id, seasonId: row.season_id, leagueId: season.coverage.id,
      season: season.coverage.season, home: { id: row.home_id, name: row.home_name },
      away: { id: row.away_id, name: row.away_name }, kickoffAt,
      status: hidden && ["final", "live"].includes(row.status) ? "scheduled" : row.status,
      statisticsStatus: hidden ? "missing" : row.statistics_status,
      homeScore: hidden ? null : row.home_score, awayScore: hidden ? null : row.away_score,
      detailed: !hidden && ["partial", "complete"].includes(row.statistics_status), appearances: [], revisionId: row.normalized_revision_id,
    };
  });
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.sqlId, fixture]));
  const fixturesBySeason = new Map([...seasons.keys()].map((id) => [id, fixtures.filter((fixture) => fixture.seasonId === id)]));
  const appearances = new Map<string, StoredAppearance[]>();
  for (const row of appearanceRows.rows) {
    const group = appearances.get(row.player_id) ?? [];
    group.push(row); appearances.set(row.player_id, group);
  }
  const rosters = rosterRows.rows.map((row): Roster => ({
    id: row.id, seasonId: row.season_id, observedAt: iso(row.observed_at), complete: row.complete,
    sourceId: row.source_revision_id, entries: new Map(),
  }));
  const rosterById = new Map(rosters.map((roster) => [roster.id, roster]));
  for (const row of entryRows.rows) {
    const roster = rosterById.get(row.snapshot_id)!;
    const group = roster.entries.get(row.player_id) ?? [];
    group.push(row.provider_id); roster.entries.set(row.player_id, group);
  }
  const latestRosters = new Map<string, Roster[]>();
  for (const roster of rosters) {
    const previous = latestRosters.get(roster.seasonId);
    if (!previous || previous[0].observedAt < roster.observedAt) latestRosters.set(roster.seasonId, [roster]);
    else if (previous[0].observedAt === roster.observedAt) previous.push(roster);
  }
  const contextCache = new Map<string, { table: ReturnType<typeof reconstructStandings>; key: string; cutoffAt: string }>();
  const contextFor = (fixture: StoredFixture, clubId: string | null, current: boolean): Context => {
    const season = seasons.get(fixture.seasonId)!;
    const date = current ? historicalDate ?? localDate(cutoffAt, season.coverage.timezone) : fixture.kickoffAt ? localDate(fixture.kickoffAt, season.coverage.timezone) : null;
    if (!date) return { complete: false, clubs: season.coverage.expectedClubs, own: null, opponent: null, key: "unknown-kickoff", cutoffAt, reasons: [{ code: "unknown_kickoff", fixtureId: fixture.id }] };
    const nextDate = new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    const cacheId = `${fixture.seasonId}:${current ? "current" : date}`;
    let context = contextCache.get(cacheId);
    if (!context) {
      const schedule = fixturesBySeason.get(fixture.seasonId)!;
      const contextCutoff = current && !historicalDate ? cutoffAt : cutoffUtc(date, season.coverage.timezone);
      const table = reconstructStandings(season.coverage, season.clubs, schedule, current && !historicalDate ? nextDate : date, current && !historicalDate ? { asOf: cutoffAt } : {});
      // Calendar ticks and database UUIDs do not identify new football evidence.
      const headers = schedule.map((item) => ({
        id: item.id, home: item.home.id, away: item.away.id, kickoffAt: item.kickoffAt,
        ...(item.kickoffAt === null || Date.parse(item.kickoffAt) < Date.parse(contextCutoff)
          ? { status: item.status, homeScore: item.homeScore, awayScore: item.awayScore } : {}),
      }));
      context = { table, key: digest({ leagueId: season.coverage.id, season: season.coverage.season, headers, ...table }), cutoffAt: contextCutoff };
      contextCache.set(cacheId, context);
    }
    const own = context.table.rows.find((row) => row.clubId === clubId);
    const opponentId = fixture.home.id === clubId ? fixture.away.id : fixture.away.id === clubId ? fixture.home.id : null;
    const opponent = context.table.rows.find((row) => row.clubId === opponentId);
    const rank = (row: typeof own) => row ? {
      rank: row.position, tiedCount: context!.table.rows.filter((other) => other.position === row.position).length,
      uncertain: row.rankUncertain,
    } : null;
    return {
      complete: context.table.complete && Boolean(own && opponent), clubs: season.coverage.expectedClubs,
      own: rank(own), opponent: rank(opponent), key: context.key, cutoffAt: context.cutoffAt,
      reasons: context.table.issues.map((issue) => ({ code: issue.code, ...(fixtureByProvider.has(issue.resource) ? { fixtureId: issue.resource } : {}), ...(issue.field ? { field: issue.field } : {}) })),
    };
  };
  const fixtureByProvider = new Set(fixtures.map((fixture) => fixture.id));
  const sourceOrdinal = ordinal.rows[0].ordinal;
  const result = new Map<string, PreparedInput>();
  for (const player of players.rows) {
    const stored = (appearances.get(player.id) ?? []).filter((appearance) => {
      if (!historicalDate) return true;
      const fixture = fixtureById.get(appearance.fixture_id)!;
      return !fixture.kickoffAt || (Date.parse(fixture.kickoffAt) < cutoff && localDate(fixture.kickoffAt, seasons.get(fixture.seasonId)!.coverage.timezone) < historicalDate);
    });
    const byFixture = new Map(stored.map((appearance) => [appearance.fixture_id, appearance]));
    const history: HistoryAppearance[] = stored.map((appearance) => {
      const fixture = fixtureById.get(appearance.fixture_id)!;
      return {
        ...match(fixture, profile), covered: true, clubId: appearance.club_id,
        ...(profile.provider === "sorare" ? { sourceProvider: "sorare" as const } : {}),
        membershipKnown: appearance.membership_id !== null && appearance.club_id !== null,
        participation: appearance.participation, minutes: appearance.minutes,
        rating: appearance.rating === null ? null : Number(appearance.rating),
        metrics: Object.fromEntries(METRICS.map((metric) => [metric, appearance[fields[metric]]])) as HistoryAppearance["metrics"],
        context: observationOnly ? null : contextFor(fixture, appearance.club_id, false),
      };
    });
    const rosterReasons: Reason[] = [];
    const candidates: CurrentClub[] = [];
    let latestClubClaims = 0;
    const playerSeasons = new Set(stored.map((appearance) => fixtureById.get(appearance.fixture_id)!)
      .filter((fixture) => !fixture.kickoffAt || Date.parse(fixture.kickoffAt) < cutoff).map((fixture) => fixture.seasonId));
    for (const roster of rosters) if (roster.entries.get(player.id)?.length) playerSeasons.add(roster.seasonId);
    for (const season of seasons.values()) {
      // A league with no evidence for this player cannot contradict a confirmed
      // club elsewhere. Its missing or partial roster is not player evidence.
      if (!playerSeasons.has(season.id)) continue;
      const latest = latestRosters.get(season.id);
      if (!latest) { rosterReasons.push({ code: "missing_roster_observation" }); continue; }
      const evidence = rosterEvidence(latest, player.id);
      latestClubClaims += evidence.clubs.length;
      if (evidence.incomplete) rosterReasons.push({ code: "incomplete_roster_observation" });
      if (evidence.ambiguous) rosterReasons.push({ code: "ambiguous_current_club" });
      if (!evidence.incomplete && !evidence.ambiguous) {
        for (const clubId of evidence.clubs) candidates.push({ clubId, leagueId: season.coverage.id, season: season.coverage.season });
      }
    }
    if (latestClubClaims > 1) rosterReasons.push({ code: "ambiguous_current_club" });
    if (candidates.length === 0 && rosterReasons.length === 0) rosterReasons.push({ code: "unknown_current_club" });
    const currentClub = candidates.length === 1 && rosterReasons.length === 0 ? candidates[0] : null;
    type InstantEvidence = { claims: CurrentClub[]; rosters: Map<string, Roster[]> };
    const evidenceByInstant = new Map<number, InstantEvidence>();
    const atInstant = (at: number) => {
      let evidence = evidenceByInstant.get(at);
      if (!evidence) { evidence = { claims: [], rosters: new Map() }; evidenceByInstant.set(at, evidence); }
      return evidence;
    };
    for (const appearance of history) {
      if (appearance.kickoffAt && appearance.status === "final" && appearance.membershipKnown && appearance.clubId && appearance.participation !== "unknown") {
        atInstant(Date.parse(appearance.kickoffAt)).claims.push({ clubId: appearance.clubId, leagueId: appearance.leagueId, season: appearance.season });
      }
    }
    for (const roster of rosters) {
      const group = atInstant(Date.parse(roster.observedAt)).rosters;
      const observations = group.get(roster.seasonId) ?? [];
      observations.push(roster); group.set(roster.seasonId, observations);
    }
    const checkpoints: { at: number; club: CurrentClub | null }[] = [];
    let active: CurrentClub | null = null;
    for (const [at, evidence] of [...evidenceByInstant.entries()].sort(([a], [b]) => a - b)) {
      const claims = [...evidence.claims];
      const absent: { leagueId: string; season: string }[] = [];
      let ambiguous = false;
      for (const [seasonId, observations] of evidence.rosters) {
        const season = seasons.get(seasonId)!;
        const resolved = rosterEvidence(observations, player.id);
        const affectsClaim = (active?.leagueId === season.coverage.id && active.season === season.coverage.season)
          || evidence.claims.some((claim) => claim.leagueId === season.coverage.id && claim.season === season.coverage.season);
        if (resolved.ambiguous || (resolved.incomplete && (affectsClaim || resolved.clubs.length > 0))) ambiguous = true;
        if (!resolved.incomplete && resolved.clubs.length === 0) absent.push({ leagueId: season.coverage.id, season: season.coverage.season });
        for (const clubId of resolved.clubs) claims.push({ clubId, leagueId: season.coverage.id, season: season.coverage.season });
      }
      const unique = [...new Map(claims.map((club) => [canonicalJson(club), club])).values()];
      if (ambiguous || unique.length > 1) active = null;
      else if (unique.length === 1) {
        const claim = unique[0];
        active = absent.some((season) => season.leagueId === claim.leagueId && season.season === claim.season) ? null : claim;
      } else if (active && absent.some((season) => season.leagueId === active!.leagueId && season.season === active!.season)) {
        // A complete exclusion ends the old scope; it does not establish a new
        // club or backdate a transfer. An unrelated league's absence is harmless.
        active = null;
      }
      checkpoints.push({ at, club: active });
    }
    const gaps: EligibilityGap[] = [];
    for (const appearance of history) {
      if (appearance.status === "scheduled"
        && (!appearance.kickoffAt || Date.parse(appearance.kickoffAt) < cutoff)) {
        gaps.push({ code: "unresolved_past_fixture", fixtureId: appearance.fixtureId, kickoffAt: appearance.kickoffAt });
      }
    }
    for (const fixture of fixtures) {
      if (byFixture.has(fixture.sqlId) || fixture.status === "cancelled" || fixture.status === "postponed" || fixture.status === "live") continue;
      if (fixture.kickoffAt && (Date.parse(fixture.kickoffAt) >= cutoff || (historicalDate && localDate(fixture.kickoffAt, seasons.get(fixture.seasonId)!.coverage.timezone) >= historicalDate))) continue;
      const time = fixture.kickoffAt ? Date.parse(fixture.kickoffAt) : null;
      const checkpoint = time === null ? null : checkpoints.findLast((item) => item.at <= time);
      const scope = checkpoint?.club;
      if (scope && (scope.leagueId !== fixture.leagueId || scope.season !== fixture.season || ![fixture.home.id, fixture.away.id].includes(scope.clubId))) continue;
      gaps.push({ code: fixture.status === "scheduled" ? "unresolved_past_fixture" : "missing_appearance_evidence", fixtureId: fixture.id, kickoffAt: fixture.kickoffAt });
    }
    const input: ForecastInput = {
      player: { id: player.provider_id, position: player.position }, cutoffAt, appearances: history,
      gaps, currentClub, rosterReasons: ["missing_roster_observation", "incomplete_roster_observation", "ambiguous_current_club", "unknown_current_club"]
        .filter((code) => rosterReasons.some((reason) => reason.code === code)).map((code) => ({ code })),
      targets: !observationOnly && currentClub ? fixtures.filter((fixture) => fixture.leagueId === currentClub.leagueId && fixture.season === currentClub.season
        && [fixture.home.id, fixture.away.id].includes(currentClub.clubId)).map((fixture) => ({ ...match(fixture, profile), context: contextFor(fixture, currentClub.clubId, true) })) : [],
    };
    result.set(player.provider_id, { input, sourceOrdinal, provenance: observationOnly ? {} : {
      sourceOrdinal, playerRevisionId: player.normalized_revision_id,
      appearanceRevisionIds: [...new Set(stored.map((appearance) => appearance.normalized_revision_id).filter(Boolean))].sort(),
      fixtureRevisionIds: [...new Set(fixtures.map((fixture) => fixture.revisionId).filter(Boolean))].sort(),
      rosterObservations: rosters.map((roster) => ({ snapshotId: roster.id, sourceRevisionId: roster.sourceId, observedAt: roster.observedAt, complete: roster.complete,
        leagueId: seasons.get(roster.seasonId)!.coverage.id, season: seasons.get(roster.seasonId)!.coverage.season,
        playerClubIds: [...new Set(roster.entries.get(player.id) ?? [])].sort(compare) })),
      coverage: [...seasons.values()].map((season) => ({ leagueId: season.coverage.id, season: season.coverage.season, seasonRevisionId: season.revisionId })),
    } });
  }
  return result;
}
