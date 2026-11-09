import { coverageFor } from "./coverage";
import type {
  Appearance, Batch, Club, Coverage, Fixture, Issue, Player, ProviderResponse, ProviderStanding,
} from "./types";

type Row = Record<string, unknown>;
type State = { batch: Batch; response: ProviderResponse; coverage: Coverage };
type Metric = Exclude<keyof Appearance, "player" | "clubId" | "participation">;
const METRICS: Record<Metric, string> = {
  minutes: "player_minutes_played", rating: "player_rating", goals: "player_goals",
  assists: "player_assists", shotsOnTarget: "player_shots_on_goal", keyPasses: "player_key_passes",
  tackles: "player_tackles", interceptions: "player_interceptions", saves: "player_saves",
  goalsConceded: "player_goals_conceded",
};
const SEASONS = new Set(["2026/27", "2026/2027"]);
const STAGES = new Set(["current", "regular season", "regular"]);
const row = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const blank = (value: unknown) => value === null || value === undefined || value === "" || (typeof value === "string" && !value.trim());

function issue(state: State, code: string, resource: string, field?: string) {
  const item: Issue = field ? { code, resource, field } : { code, resource };
  if (!state.batch.issues.some((existing) => existing.code === code && existing.resource === resource && existing.field === field)) {
    state.batch.issues.push(item);
  }
}

function identifier(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === "string" && /^[1-9]\d{0,17}$/.test(value) && Number.isSafeInteger(Number(value)) ? value : null;
}

function name(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim() : null;
}

function position(value: unknown): Player["position"] {
  if (typeof value !== "string") return "UNKNOWN";
  const group = value.trim().toLowerCase();
  if (["gk", "g", "goalkeeper", "goalkeepers"].includes(group)) return "GK";
  if (["def", "d", "defender", "defenders"].includes(group)) return "DEF";
  if (["mid", "m", "midfielder", "midfielders"].includes(group)) return "MID";
  if (["fwd", "f", "forward", "forwards", "attacker", "attackers"].includes(group)) return "FWD";
  return "UNKNOWN";
}

function number(value: unknown, state: State, resource: string, field: string, options: { rating?: boolean; signed?: boolean } = {}): number | null {
  if (blank(value)) return null;
  const validText = typeof value === "string" && (options.rating ? /^\d+(?:\.\d+)?$/ : options.signed ? /^-?\d+$/ : /^\d+$/).test(value.trim());
  const parsed = typeof value === "number" ? value : validText ? Number((value as string).trim()) : NaN;
  if (!Number.isFinite(parsed) || (!options.rating && (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647 || parsed < -2_147_483_648)) || (!options.signed && parsed < 0) || (options.rating && parsed > 10)) {
    issue(state, "invalid_number", resource, field);
    return null;
  }
  return parsed;
}

function validateScope(value: Row, state: State, resource: string, requireSeason: boolean): boolean {
  if (identifier(value.league_id) !== state.coverage.id) {
    issue(state, "unsupported_league", resource, "league_id");
    return false;
  }
  if ((requireSeason || !blank(value.league_year)) && !SEASONS.has(String(value.league_year))) {
    issue(state, "unsupported_season", resource, "league_year");
    return false;
  }
  if (typeof value.stage_name !== "string" || !STAGES.has(value.stage_name.trim().toLowerCase())) {
    issue(state, "unsupported_stage", resource, "stage_name");
    return false;
  }
  return true;
}

function addClub(club: Club, state: State) {
  if (!state.batch.clubs.some((existing) => existing.id === club.id)) state.batch.clubs.push(club);
}

function addPlayer(player: Player, state: State) {
  const existing = state.batch.players.findIndex((candidate) => candidate.id === player.id);
  if (existing < 0) state.batch.players.push(player);
  else if (state.batch.players[existing].position === "UNKNOWN" && player.position !== "UNKNOWN") state.batch.players[existing] = player;
}

function player(value: Row, clubId: string, state: State, resource: string, lineup = false): Player | null {
  const id = identifier(value.player_key);
  const displayName = name(lineup ? value.lineup_player : value.player_name);
  if (!id || !displayName) {
    issue(state, "invalid_player", resource, !id ? "player_key" : lineup ? "lineup_player" : "player_name");
    return null;
  }
  // lineup_position is a formation slot, not a playing-position group.
  const result: Player = { id, name: displayName, position: position(value.player_type ?? value.player_position), clubId };
  if (!lineup && result.position === "UNKNOWN") issue(state, "unknown_position", `${resource}/player:${id}`, "player_position");
  addPlayer(result, state);
  return result;
}

function unknownAppearance(known: Player, clubId: string): Appearance {
  return {
    player: known, clubId, participation: "unknown", minutes: null, rating: null,
    goals: null, assists: null, shotsOnTarget: null, keyPasses: null,
    tackles: null, interceptions: null, saves: null, goalsConceded: null,
  };
}

function appearance(value: Row, clubId: string, state: State, resource: string): Appearance | null {
  const known = player(value, clubId, state, resource);
  if (!known) return null;
  const result = unknownAppearance(known, clubId);
  const playerResource = `${resource}/player:${known.id}`;
  for (const [metric, field] of Object.entries(METRICS) as [Metric, string][]) {
    result[metric] = number(value[field], state, playerResource, field, { rating: metric === "rating" });
    if (result[metric] === null) issue(state, "missing_metric", playerResource, field);
  }
  if (result.minutes !== null && result.minutes > 0) result.participation = "played";
  else if (result.minutes === 0) {
    // Zero minutes is affirmative source evidence; positive metrics conflict with it.
    const positive = Object.keys(METRICS).some((metric) => (result[metric as Metric] ?? 0) > 0);
    if (positive) issue(state, "conflicting_participation", playerResource, "player_minutes_played");
    else result.participation = "dnp";
  }
  if (result.participation === "unknown") issue(state, "unknown_participation", playerResource);
  return result;
}

function status(value: unknown, state: State, resource: string): Fixture["status"] {
  const statuses: Record<string, Fixture["status"]> = {
    finished: "final", "not started": "scheduled", scheduled: "scheduled",
    live: "live", "half time": "live", halftime: "live", postponed: "postponed",
    cancelled: "cancelled", canceled: "cancelled",
  };
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  const result = statuses[text] ?? (/^\d+(?:\+\d+)?['’]?$/.test(text) ? "live" : "unknown");
  if (result === "unknown") issue(state, "unknown_status", resource, "match_status");
  return result;
}

function kickoff(value: Row, state: State, resource: string): string | null | false {
  if (blank(value.match_date)) {
    issue(state, "missing_date", resource, "match_date");
    return null;
  }
  const date = typeof value.match_date === "string" ? value.match_date : "";
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    issue(state, "invalid_date", resource, "match_date");
    return false;
  }
  if (date < state.coverage.startsOn || date > state.coverage.endsOn) {
    issue(state, "unsupported_season_date", resource, "match_date");
    return false;
  }
  if (blank(value.match_time)) {
    issue(state, "unknown_kickoff", resource, "match_time");
    return null;
  }
  if (typeof value.match_time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.match_time)) {
    issue(state, "invalid_time", resource, "match_time");
    return null;
  }
  return `${date}T${value.match_time}:00.000Z`;
}

function lineup(value: Row, fixture: Fixture, state: State) {
  if (!row(value.lineup)) return;
  const seen = new Set<string>();
  for (const side of ["home", "away"] as const) {
    const part = value.lineup[side];
    if (!row(part)) continue;
    for (const group of ["starting_lineups", "substitutes"]) {
      if (!Array.isArray(part[group])) continue;
      for (const raw of part[group]) {
        if (!row(raw)) { issue(state, "invalid_player", `fixture:${fixture.id}`, "lineup"); continue; }
        const known = player(raw, fixture[side].id, state, `fixture:${fixture.id}`, true);
        if (!known) continue;
        if (seen.has(known.id)) { issue(state, "duplicate_player", `fixture:${fixture.id}/player:${known.id}`); continue; }
        seen.add(known.id);
        fixture.appearances.push(unknownAppearance(known, fixture[side].id));
      }
    }
  }
}

function detail(rawStats: unknown[], fixture: Fixture, state: State, resource: string) {
  const prior = fixture.appearances;
  const normalized = new Map<string, Appearance>();
  const duplicates = new Set<string>();
  const statsSides = new Set<string>();
  let incomplete = false;
  for (const raw of rawStats) {
    if (!row(raw)) { issue(state, "invalid_player", resource, "player_statistics"); incomplete = true; continue; }
    if (!blank(raw.match_id) && identifier(raw.match_id) !== fixture.id) {
      issue(state, "mismatched_fixture", resource, "match_id"); incomplete = true; continue;
    }
    const team = typeof raw.team_name === "string" ? raw.team_name.trim().toLowerCase() : "";
    const sideId = team === "home" ? fixture.home.id : team === "away" ? fixture.away.id : null;
    const suppliedTeamIds = [raw.team_key, raw.team_id].filter((value) => !blank(value));
    const teamIds = suppliedTeamIds.map(identifier);
    if (teamIds.some((id) => id === null)) {
      issue(state, "unknown_membership", resource, "team_id"); incomplete = true; continue;
    }
    if (new Set(teamIds).size > 1 || (sideId && teamIds.some((id) => id !== sideId))) {
      issue(state, "conflicting_membership", resource, "team_name"); incomplete = true; continue;
    }
    const teamId = teamIds[0];
    const clubId = sideId ?? (teamId === fixture.home.id || teamId === fixture.away.id ? teamId : null);
    if (!clubId) { issue(state, "unknown_membership", resource, "team_name"); incomplete = true; continue; }
    const parsed = appearance(raw, clubId, state, resource);
    if (!parsed) { incomplete = true; continue; }
    statsSides.add(clubId);
    if (normalized.has(parsed.player.id)) {
      duplicates.add(parsed.player.id);
      issue(state, "duplicate_player", `${resource}/player:${parsed.player.id}`);
      normalized.set(parsed.player.id, unknownAppearance(parsed.player, clubId));
    } else normalized.set(parsed.player.id, parsed);
  }
  for (const previous of prior) {
    const present = normalized.get(previous.player.id);
    if (!present) {
      normalized.set(previous.player.id, unknownAppearance(previous.player, previous.clubId));
      issue(state, "missing_player_statistics", `${resource}/player:${previous.player.id}`);
    } else if (present.clubId !== previous.clubId) {
      normalized.set(previous.player.id, unknownAppearance(previous.player, previous.clubId));
      issue(state, "conflicting_membership", `${resource}/player:${previous.player.id}`);
    }
  }
  fixture.appearances = [...normalized.values()];
  fixture.detailed = true;
  const participantCoverage = [fixture.home.id, fixture.away.id].every((clubId) =>
    fixture.appearances.filter((item) => item.clubId === clubId && item.participation === "played"
      && item.minutes !== null && item.minutes > 0).length >= 11);
  if (!participantCoverage) issue(state, "incomplete_participant_coverage", resource);
  fixture.statisticsStatus = rawStats.length === 0 ? "missing"
    : !incomplete && statsSides.size === 2 && duplicates.size === 0 && participantCoverage
      && fixture.appearances.every((item) => item.participation !== "unknown" && Object.keys(METRICS).every((key) => item[key as Metric] !== null))
      ? "complete" : "partial";
  if (fixture.statisticsStatus !== "complete") issue(state, "incomplete_statistics", resource);
}

function event(value: Row, state: State): Fixture | null {
  const id = identifier(value.match_id);
  const resource = id ? `fixture:${id}` : "get_events";
  if (!id) { issue(state, "invalid_identifier", resource, "match_id"); return null; }
  if (!validateScope(value, state, resource, true)) return null;
  const homeId = identifier(value.match_hometeam_id);
  const awayId = identifier(value.match_awayteam_id);
  const homeName = name(value.match_hometeam_name);
  const awayName = name(value.match_awayteam_name);
  if (!homeId || !awayId || homeId === awayId || !homeName || !awayName) {
    issue(state, "invalid_club", resource); return null;
  }
  const kickoffAt = kickoff(value, state, resource);
  if (kickoffAt === false) return null;
  const matchStatus = status(value.match_status, state, resource);
  const fixture: Fixture = {
    id, leagueId: state.coverage.id, season: state.coverage.season,
    home: { id: homeId, name: homeName }, away: { id: awayId, name: awayName }, kickoffAt,
    status: matchStatus, statisticsStatus: matchStatus === "final" ? "missing" : "unknown", detailed: false,
    homeScore: number(value.match_hometeam_score, state, resource, "match_hometeam_score"),
    awayScore: number(value.match_awayteam_score, state, resource, "match_awayteam_score"), appearances: [],
  };
  if (matchStatus === "final" && (fixture.homeScore === null || fixture.awayScore === null)) issue(state, "missing_result", resource);
  addClub(fixture.home, state); addClub(fixture.away, state);
  lineup(value, fixture, state);
  if (row(value.player_stats)) {
    const stats = (["home", "away"] as const).flatMap((side) => {
      const values = (value.player_stats as Row)[side];
      return Array.isArray(values) ? values.map((raw) => row(raw) ? { ...raw, team_name: side } : raw) : [];
    });
    detail(stats, fixture, state, resource);
  } else if (Array.isArray(value.player_statistics)) detail(value.player_statistics, fixture, state, resource);
  else if (matchStatus === "final") issue(state, "missing_statistics", resource);
  return fixture;
}

function teams(values: unknown[], state: State) {
  const seen = new Set<string>();
  for (const raw of values) {
    if (!row(raw)) { issue(state, "invalid_club", "get_teams"); continue; }
    const id = identifier(raw.team_key);
    const displayName = name(raw.team_name);
    if (!id || !displayName) { issue(state, "invalid_club", "get_teams"); continue; }
    if (seen.has(id)) { issue(state, "duplicate_club", `club:${id}`); continue; }
    seen.add(id);
    addClub({ id, name: displayName }, state);
    if (!Array.isArray(raw.players)) { issue(state, "missing_roster", `club:${id}`, "players"); continue; }
    const players = new Set<string>();
    for (const item of raw.players) {
      if (!row(item)) { issue(state, "invalid_player", `club:${id}`); continue; }
      const known = player(item, id, state, `club:${id}`);
      if (known && players.has(known.id)) issue(state, "duplicate_player", `club:${id}/player:${known.id}`);
      if (known) players.add(known.id);
    }
  }
}

function standings(values: unknown[], state: State) {
  const seen = new Set<string>();
  const fields: Record<Exclude<keyof ProviderStanding, "clubId">, string> = {
    played: "overall_league_payed", wins: "overall_league_W", draws: "overall_league_D", losses: "overall_league_L",
    goalsFor: "overall_league_GF", goalsAgainst: "overall_league_GA", points: "overall_league_PTS",
  };
  for (const raw of values) {
    if (!row(raw)) { issue(state, "invalid_standing", "get_standings"); continue; }
    const id = identifier(raw.team_id);
    const resource = id ? `standing:${id}` : "get_standings";
    if (!id) { issue(state, "invalid_identifier", resource, "team_id"); continue; }
    if (!validateScope(raw, state, resource, false)) continue;
    if (seen.has(id)) { issue(state, "duplicate_standing", resource); continue; }
    const values = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, number(raw[field], state, resource, field, { signed: key === "points" })]));
    if (Object.values(values).some((value) => value === null)) { issue(state, "incomplete_standing", resource); continue; }
    const result = { clubId: id, ...values } as ProviderStanding;
    if (result.wins + result.draws + result.losses !== result.played) { issue(state, "inconsistent_standing", resource); continue; }
    const displayName = name(raw.team_name);
    if (displayName) addClub({ id, name: displayName }, state);
    state.batch.standings.push(result);
    seen.add(id);
  }
}

/** Pure source validation. Issues contain fixed field names and validated IDs only. */
export function normalizeResponse(response: ProviderResponse, coverage: Coverage, context?: Fixture): Batch {
  const allowed = coverageFor(coverage.id);
  if (Object.keys(allowed).some((key) => coverage[key as keyof Coverage] !== allowed[key as keyof Coverage])) throw new Error("Unsupported coverage configuration");
  const batch: Batch = { coverage: { ...allowed }, clubs: [], players: [], fixtures: [], standings: [], issues: [] };
  const state: State = { batch, response, coverage: allowed };
  if ((!blank(response.params.league_id) && response.params.league_id !== coverage.id)
    || (!blank(response.params.season) && !SEASONS.has(response.params.season))) {
    issue(state, "unsupported_request_scope", response.action); return batch;
  }
  let payload: unknown;
  try { payload = JSON.parse(response.text); } catch {
    if (response.action === "get_statistics" && context) {
      const missing = normalizeResponse({ ...response, text: "{}" }, coverage, context);
      missing.issues.unshift({ code: "invalid_json", resource: response.action });
      return missing;
    }
    issue(state, "invalid_json", response.action); return batch;
  }
  if (response.action === "get_events") {
    if (response.params.timezone !== "UTC") { issue(state, "unsupported_timezone", response.action, "timezone"); return batch; }
    if (!Array.isArray(payload)) { issue(state, "invalid_payload", response.action); return batch; }
    const seen = new Map<string, Fixture>();
    for (const raw of payload) {
      if (!row(raw)) { issue(state, "invalid_fixture", response.action); continue; }
      const parsed = event(raw, state);
      if (!parsed) continue;
      const previous = seen.get(parsed.id);
      if (previous) {
        const resource = `fixture:${parsed.id}`;
        issue(state, "duplicate_fixture", resource);
        const fingerprint = (fixture: Fixture) => JSON.stringify({
          ...fixture, appearances: [...fixture.appearances].sort((a, b) => a.player.id.localeCompare(b.player.id)),
        });
        if (fingerprint(previous) !== fingerprint(parsed)) {
          issue(state, "conflicting_fixture", resource);
          // Keep a row that invalidates any earlier confirmed SQL result. An
          // omitted conflicting row would leave stale canonical data in place.
          previous.status = "unknown";
          previous.homeScore = null;
          previous.awayScore = null;
          previous.statisticsStatus = "partial";
          previous.detailed = true;
          previous.appearances = previous.appearances.map((item) => unknownAppearance(item.player, item.clubId));
        }
        continue;
      }
      seen.set(parsed.id, parsed); batch.fixtures.push(parsed);
    }
    // Parsing rejected duplicates must not register their additional clubs or
    // players in the covered season.
    batch.clubs = [];
    batch.players = [];
    for (const fixture of batch.fixtures) {
      addClub(fixture.home, state); addClub(fixture.away, state);
      for (const item of fixture.appearances) addPlayer(item.player, state);
    }
  } else if (response.action === "get_statistics") {
    if (!context || context.leagueId !== coverage.id || context.season !== coverage.season
      || !identifier(context.id) || (!blank(response.params.match_id) && response.params.match_id !== context.id)) {
      issue(state, "missing_fixture_context", response.action); return batch;
    }
    const resource = `fixture:${context.id}`;
    const fixture: Fixture = {
      ...context, home: { ...context.home }, away: { ...context.away },
      appearances: context.appearances.map((item) => ({ ...item, player: { ...item.player } })),
    };
    let stats: unknown;
    if (Array.isArray(payload)) stats = payload;
    else if (row(payload) && Array.isArray(payload.player_statistics)) stats = payload.player_statistics;
    else if (row(payload)) {
      const keyed = payload[context.id];
      if (row(keyed)) stats = keyed.player_statistics;
    }
    if (!Array.isArray(stats)) issue(state, "invalid_payload", resource, "player_statistics");
    // A successfully received football response with broken detail supersedes
    // earlier metrics with an explicit gap. Provider/HTTP errors stop in the client.
    detail(Array.isArray(stats) ? stats : [], fixture, state, resource);
    addClub(fixture.home, state); addClub(fixture.away, state);
    for (const item of fixture.appearances) addPlayer(item.player, state);
    batch.fixtures.push(fixture);
  } else if (response.action === "get_teams" || response.action === "get_standings") {
    if (response.params.league_id !== coverage.id) { issue(state, "unsupported_request_scope", response.action, "league_id"); return batch; }
    if (!Array.isArray(payload)) { issue(state, "invalid_payload", response.action); return batch; }
    if (response.action === "get_teams") teams(payload, state); else standings(payload, state);
  } else issue(state, "unsupported_action", "provider");
  return batch;
}
