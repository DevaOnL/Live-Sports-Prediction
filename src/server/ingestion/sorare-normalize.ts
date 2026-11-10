import { SORARE_FORMAT, sorareOperation, type SorareCapture, type SorareOperation } from "./sorare-client";
import { CURRENT_SOURCE, sourceCoverage } from "./sources";
import type { Appearance, Batch, Club, Coverage, Fixture, Issue, Player, ProviderResponse, ProviderStanding } from "./types";

type Row = Record<string, unknown>;
type Capture = { raw: SorareCapture; kind: SorareOperation; football: Row };
const row = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
const nativeId = (value: unknown, type: "Player" | "Club" | "Game"): value is string => typeof value === "string"
  && new RegExp(`^${type}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, "i").test(value);
const label = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const slug = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 200;
function position(value: unknown): Player["position"] {
  if (typeof value !== "string") return "UNKNOWN";
  const positions: Record<string, Player["position"]> = { goalkeeper: "GK", defender: "DEF", midfielder: "MID", forward: "FWD" };
  return positions[value.toLowerCase()] ?? "UNKNOWN";
}
function empty(known: Player, clubId: string): Appearance {
  return { player: known, clubId, participation: "unknown", minutes: null, rating: null, goals: null, assists: null,
    shotsOnTarget: null, keyPasses: null, tackles: null, interceptions: null, saves: null, goalsConceded: null };
}

/** Native response bytes remain in the capture; only evidenced counts enter SQL. */
export function normalizeSorareCapture(response: ProviderResponse, coverage: Coverage, fixtureContext?: Fixture): Batch {
  const approved = sourceCoverage(CURRENT_SOURCE, coverage.id);
  if (Object.entries(approved).some(([key, value]) => coverage[key as keyof Coverage] !== value)
    || response.params.provider !== "sorare" || response.params.format !== SORARE_FORMAT
    || response.params.league_id !== coverage.id || !response.resourceKey.startsWith("sorare:") || !Number.isFinite(Date.parse(response.retrievedAt))) throw new Error("Sorare capture scope mismatch");
  const batch: Batch = { coverage, clubs: [], players: [], fixtures: [], standings: [], issues: [] };
  const issue = (code: string, resource: string, field?: string): void => {
    const item: Issue = { code, resource, ...(field ? { field } : {}) };
    if (!batch.issues.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) batch.issues.push(item);
  };
  let bundle: unknown;
  try { bundle = JSON.parse(response.text); } catch { issue("invalid_capture", response.action); return batch; }
  if (!row(bundle) || bundle.format !== SORARE_FORMAT || bundle.complete !== true || !Array.isArray(bundle.captures) || !bundle.captures.length) {
    issue("incomplete_capture", response.action); return batch;
  }
  const captures: Capture[] = [];
  let previousTime = -Infinity;
  const allowed: Record<ProviderResponse["action"], SorareOperation[]> = {
    get_teams: ["teams", "players"], get_events: ["past", "future"], get_standings: ["standings"], get_statistics: ["statistics"],
  };
  for (const raw of bundle.captures) {
    if (!row(raw) || typeof raw.query !== "string" || !row(raw.variables) || typeof raw.text !== "string" || typeof raw.retrievedAt !== "string") {
      issue("invalid_capture", response.action); return batch;
    }
    const kind = sorareOperation(raw.query);
    const time = Date.parse(raw.retrievedAt);
    if (!kind || !allowed[response.action]?.includes(kind) || !Number.isFinite(time) || time < previousTime || time > Date.parse(response.retrievedAt)) {
      issue("invalid_capture", response.action); return batch;
    }
    const variableKeys = kind === "statistics" ? ["id"] : kind === "standings" ? ["slug", "year"] : ["slug", "after"];
    if (Object.keys(raw.variables).some((key) => !variableKeys.includes(key))
      || (kind !== "statistics" && kind !== "players" && raw.variables.slug !== coverage.id)) {
      issue("invalid_capture_scope", response.action); return batch;
    }
    previousTime = time;
    let payload: unknown;
    try { payload = JSON.parse(raw.text); } catch { issue("invalid_capture", response.action); return batch; }
    if (!row(payload) || (Array.isArray(payload.errors) && payload.errors.length) || !row(payload.data) || !row(payload.data.football)) {
      issue("invalid_capture", response.action); return batch;
    }
    captures.push({ kind, raw: raw as SorareCapture, football: payload.data.football });
  }
  const club = (value: unknown): Club | null => {
    if (!row(value) || !nativeId(value.id, "Club") || !label(value.name)) { issue("invalid_club", response.action); return null; }
    const known: Club = { id: value.id, name: value.name.trim(), ...(slug(value.slug) ? { slug: value.slug } : {}) };
    const old = batch.clubs.find((item) => item.id === known.id);
    if (!old) batch.clubs.push(known);
    else if (old.name !== known.name || old.slug !== known.slug) issue("conflicting_club", known.id);
    return known;
  };
  const player = (value: unknown, clubId?: string): Player | null => {
    if (!row(value) || !nativeId(value.id, "Player") || !label(value.displayName)) { issue("invalid_player", response.action); return null; }
    const known: Player = { id: value.id, name: value.displayName.trim(), position: position(value.position),
      ...(slug(value.slug) ? { slug: value.slug } : {}), ...(clubId ? { clubId } : {}) };
    const old = batch.players.find((item) => item.id === known.id);
    if (!old) batch.players.push(known);
    else if (old.name !== known.name || old.position !== known.position || old.slug !== known.slug) issue("conflicting_player", known.id);
    return known;
  };
  const chain = (kind: "teams" | "players" | "past" | "future", target: string, expectedClubId?: string): Row[] | null => {
    const sequence = captures.filter((capture) => capture.kind === kind && capture.raw.variables.slug === target);
    if (!sequence.length) { issue("missing_capture_pages", target, kind); return null; }
    let after: string | null = null;
    const cursors = new Set<string>();
    const values: Row[] = [];
    let previousDate: number | undefined;
    for (const [index, capture] of sequence.entries()) {
      if (capture.raw.variables.after !== after) { issue("invalid_cursor_chain", target, kind); return null; }
      const parent = kind === "players" ? capture.football.club : capture.football.competition;
      const field = { teams: "teams", players: "activePlayers", past: "pastGames", future: "futureGames" }[kind];
      if (!row(parent) || parent.slug !== target || (kind === "players" && parent.id !== expectedClubId) || !row(parent[field])) { issue("invalid_capture_scope", target, kind); return null; }
      const connection = parent[field] as Row;
      if (!Array.isArray(connection.nodes) || !connection.nodes.every(row) || !row(connection.pageInfo) || typeof connection.pageInfo.hasNextPage !== "boolean") {
        issue("invalid_capture_page", target, kind); return null;
      }
      const nodes = connection.nodes as Row[];
      if (kind === "past" || kind === "future") for (const game of nodes) {
        const date = typeof game.date === "string" ? Date.parse(game.date) : NaN;
        if (!Number.isFinite(date) || (previousDate !== undefined && (kind === "past" ? date > previousDate : date < previousDate))) {
          issue("invalid_game_order", target, kind); return null;
        }
        previousDate = date;
      }
      values.push(...nodes);
      const beyond = (kind === "past" || kind === "future") && nodes.length > 0 && nodes.every((game) => typeof game.date === "string"
        && (kind === "past" ? game.date.slice(0, 10) < coverage.startsOn : game.date.slice(0, 10) > coverage.endsOn));
      if (!connection.pageInfo.hasNextPage || beyond) {
        if (index !== sequence.length - 1) { issue("extra_capture_pages", target, kind); return null; }
        return values;
      }
      const cursor = connection.pageInfo.endCursor;
      if (!nodes.length || typeof cursor !== "string" || !cursor || cursors.has(cursor)) { issue("invalid_cursor_chain", target, kind); return null; }
      cursors.add(cursor);
      after = cursor;
    }
    issue("missing_capture_pages", target, kind);
    return null;
  };
  if (response.action === "get_teams") {
    const teams = chain("teams", coverage.id);
    if (!teams) return batch;
    let complete = true;
    const claims = new Map<string, Set<string>>();
    const seenClubs = new Set<string>();
    for (const value of teams) {
      const known = club(value);
      if (!known || !known.slug || seenClubs.has(known.id)) { complete = false; issue("duplicate_or_invalid_roster_club", coverage.id); continue; }
      seenClubs.add(known.id);
      const nodes = chain("players", known.slug, known.id);
      if (!nodes) { complete = false; continue; }
      const sameClub = new Set<string>();
      for (const raw of nodes) {
        const knownPlayer = player(raw, known.id);
        if (!knownPlayer) { complete = false; continue; }
        if (sameClub.has(knownPlayer.id)) { complete = false; issue("duplicate_roster_player", knownPlayer.id); }
        sameClub.add(knownPlayer.id);
        const memberships = claims.get(knownPlayer.id) ?? new Set<string>();
        memberships.add(known.id); claims.set(knownPlayer.id, memberships);
      }
      if (!nodes.length) { complete = false; issue("empty_roster_club", known.id); }
    }
    if (seenClubs.size !== coverage.expectedClubs || captures.some((capture) => capture.kind === "players" && !teams.some((team) => team.slug === capture.raw.variables.slug))) complete = false;
    for (const [id, memberships] of claims) if (memberships.size > 1) { complete = false; issue("conflicting_roster_membership", id); }
    if (batch.issues.length) complete = false;
    batch.roster = { complete, entries: [...claims].flatMap(([playerId, memberships]) => [...memberships].map((clubId) => ({ playerId, clubId }))) };
    if (!complete) issue("incomplete_roster", coverage.id);
    return batch;
  }
  const header = (value: unknown): Fixture | null => {
    if (!row(value) || !nativeId(value.id, "Game") || !row(value.competition) || value.competition.slug !== coverage.id) {
      issue("invalid_fixture_scope", response.action); return null;
    }
    const time = typeof value.date === "string" ? Date.parse(value.date) : NaN;
    if (!Number.isFinite(time)) { issue("invalid_fixture_date", value.id); return null; }
    const kickoffAt = new Date(time).toISOString();
    if (kickoffAt.slice(0, 10) < coverage.startsOn || kickoffAt.slice(0, 10) > coverage.endsOn) return null;
    const home = club(value.homeTeam), away = club(value.awayTeam);
    if (!home || !away || home.id === away.id) { issue("invalid_fixture_clubs", value.id); return null; }
    const statuses: Record<string, Fixture["status"]> = { played: "final", playing: "live", scheduled: "scheduled", postponed: "postponed", cancelled: "cancelled", suspended: "unknown" };
    const status = statuses[String(value.statusTyped)] ?? "unknown";
    if (status === "unknown") issue("unknown_status", value.id);
    const homeScore = status === "final" || status === "live" ? integer(value.homeGoals) : null;
    const awayScore = status === "final" || status === "live" ? integer(value.awayGoals) : null;
    if (status === "final" && (homeScore === null || awayScore === null)) issue("missing_final_score", value.id);
    return { id: value.id, leagueId: coverage.id, season: coverage.season, home, away, kickoffAt, status,
      homeScore, awayScore, statisticsStatus: status === "final" || status === "live" ? "missing" : "unknown", detailed: false, appearances: [] };
  };
  if (response.action === "get_events") {
    const past = chain("past", coverage.id), future = chain("future", coverage.id);
    if (!past || !future) return { ...batch, fixtures: [] };
    const unique = new Map<string, Fixture>();
    const conflicts = new Set<string>();
    for (const value of [...past, ...future]) {
      const known = header(value);
      if (!known) continue;
      const old = unique.get(known.id);
      if (old && JSON.stringify(old) !== JSON.stringify(known)) { conflicts.add(known.id); issue("conflicting_fixture", known.id); }
      else unique.set(known.id, known);
    }
    batch.fixtures = [...unique.values()].filter((fixture) => !conflicts.has(fixture.id));
    const pairings = new Set(batch.fixtures.map((fixture) => JSON.stringify([fixture.home.id, fixture.away.id])));
    const clubIds = new Set(batch.fixtures.flatMap((fixture) => [fixture.home.id, fixture.away.id]));
    if (clubIds.size !== coverage.expectedClubs || batch.fixtures.length !== coverage.expectedClubs * (coverage.expectedClubs - 1)
      || pairings.size !== batch.fixtures.length || [...clubIds].some((home) => [...clubIds].some((away) => home !== away && !pairings.has(JSON.stringify([home, away]))))) {
      issue("incomplete_schedule", coverage.id);
    }
    return batch;
  }
  if (response.action === "get_standings") {
    if (captures.length !== 1 || captures[0].raw.variables.slug !== coverage.id || captures[0].raw.variables.year !== Number(coverage.season.slice(0, 4))) {
      issue("invalid_capture_scope", response.action); return batch;
    }
    const competition = captures[0].football.competition;
    if (!row(competition) || competition.slug !== coverage.id || !Array.isArray(competition.contestants)) { issue("invalid_standings", coverage.id); return batch; }
    const fields = { played: "matchesPlayed", wins: "matchesWon", draws: "matchesDrawn", losses: "matchesLost", goalsFor: "goalsFor", goalsAgainst: "goalsAgainst", points: "points" } as const;
    for (const raw of competition.contestants) {
      if (!row(raw)) { issue("invalid_standings", coverage.id); continue; }
      const known = club(raw.anyTeam);
      if (!known) continue;
      const result = { clubId: known.id } as ProviderStanding;
      let valid = true;
      for (const [field, source] of Object.entries(fields)) {
        const value = field === "points" && typeof raw[source] === "number" && Number.isSafeInteger(raw[source]) ? raw[source] as number : integer(raw[source]);
        if (value === null) { valid = false; issue("missing_standings_metric", known.id, source); }
        else result[field as keyof typeof fields] = value;
      }
      if (valid && result.played === result.wins + result.draws + result.losses && !batch.standings.some((item) => item.clubId === result.clubId)) batch.standings.push(result);
      else issue("invalid_standings", known.id);
    }
    if (batch.standings.length !== coverage.expectedClubs) issue("incomplete_standings", coverage.id);
    return batch;
  }
  if (captures.length !== 1 || captures[0].raw.variables.id !== response.params.match_id?.slice(5)) { issue("invalid_capture_scope", response.action); return batch; }
  const game = captures[0].football.game;
  const fixture = header(game);
  if (!fixture || !row(game) || fixture.id !== response.params.match_id
    || (fixtureContext && (fixtureContext.id !== fixture.id || fixtureContext.leagueId !== coverage.id || fixtureContext.season !== coverage.season))) {
    issue("mismatched_fixture", response.action); return { ...batch, clubs: [], players: [], fixtures: [] };
  }
  fixture.detailed = true;
  fixture.statisticsStatus = "partial";
  const appearances = new Map<string, Appearance>();
  const conflicts = new Set<string>();
  for (const side of ["home", "away"] as const) {
    const formation = game[`${side}Formation`];
    if (!row(formation) || !Array.isArray(formation.startingLineup) || !Array.isArray(formation.bench)) { issue("missing_formation", fixture.id, side); continue; }
    if (formation.startingLineupAvailable !== true) issue("incomplete_formation", fixture.id, side);
    const rawPlayers = [...formation.startingLineup.flat(), ...formation.bench];
    for (const raw of rawPlayers) {
      const known = player(raw, fixture[side].id);
      if (!known) continue;
      const old = appearances.get(known.id);
      if (old && old.clubId !== fixture[side].id) { conflicts.add(known.id); issue("conflicting_membership", known.id); }
      else appearances.set(known.id, empty(known, fixture[side].id));
    }
  }
  const scores = game.playerGameScores;
  if (!Array.isArray(scores)) issue("missing_player_statistics", fixture.id);
  const seen = new Set<string>();
  for (const score of Array.isArray(scores) ? scores : []) {
    if (!row(score)) { issue("invalid_player_statistics", fixture.id); continue; }
    if (!row(score.anyPlayerGameStats)) {
      const known = player(score.anyPlayer);
      if (known) {
        const prior = appearances.get(known.id);
        if (seen.has(known.id)) { conflicts.add(known.id); issue("duplicate_player_statistics", known.id); }
        seen.add(known.id);
        appearances.set(known.id, empty(known, prior?.clubId ?? ""));
        issue("invalid_player_statistics", known.id);
      }
      issue("invalid_player_statistics", fixture.id);
      continue;
    }
    const stats = score.anyPlayerGameStats;
    const team = row(stats.anyTeam) ? stats.anyTeam.id : null;
    const clubId = team === fixture.home.id || team === fixture.away.id ? team : "";
    const known = player(score.anyPlayer, clubId);
    if (!known) continue;
    const prior = appearances.get(known.id);
    if (!clubId || (prior && prior.clubId !== clubId) || seen.has(known.id)) {
      conflicts.add(known.id); issue(seen.has(known.id) ? "duplicate_player_statistics" : "conflicting_membership", known.id);
    }
    seen.add(known.id);
    const result = empty(known, clubId);
    const details = new Map<string, number[]>();
    if (Array.isArray(score.detailedScore)) for (const detail of score.detailedScore) {
      if (!row(detail) || typeof detail.stat !== "string") continue;
      const values = details.get(detail.stat) ?? [];
      if (integer(detail.statValue) !== null) values.push(detail.statValue as number);
      else { values.push(NaN); issue("invalid_metric", known.id, detail.stat); }
      details.set(detail.stat, values);
    }
    const metrics = { minutes: ["minsPlayed", "mins_played"], goals: ["goals", "goals"], assists: ["goalAssist", "goal_assist"],
      shotsOnTarget: ["ontargetScoringAtt", "ontarget_scoring_att"], tackles: ["totalTackle", "total_tackle"],
      interceptions: ["interceptionWon", "interception_won"], saves: ["saves", "saves"], goalsConceded: ["goalsConceded", "goals_conceded"] } as const;
    for (const [metric, [direct, detailed]] of Object.entries(metrics)) {
      const raw = stats[direct];
      const value = raw === null || raw === undefined ? null : integer(raw);
      const values = details.get(detailed) ?? [];
      if (raw !== null && raw !== undefined && value === null) issue("invalid_metric", known.id, direct);
      const evidence = [...(raw !== null && raw !== undefined && value === null ? [NaN] : value === null ? [] : [value]), ...values];
      const conflicting = evidence.some((item) => !Number.isFinite(item)) || new Set(evidence).size > 1;
      result[metric as keyof typeof metrics] = conflicting ? null : evidence[0] ?? null;
      if (conflicting) issue("conflicting_metric", known.id, direct);
      else if (result[metric as keyof typeof metrics] === null) issue("missing_metric", known.id, direct);
    }
    // Sorare's fantasy score and won_tackle are different quantities. Neither
    // supplies a 0–10 rating, key passes, or total tackles.
    issue("unsupported_metric", known.id, "rating"); issue("unsupported_metric", known.id, "keyPasses");
    const positive = Object.keys(metrics).some((metric) => (result[metric as keyof typeof metrics] ?? 0) > 0);
    const explicitDnp = stats.playedInGame === false || score.scoreStatus === "DID_NOT_PLAY" || stats.fieldStatus === "NOT_ON_GAME_SHEET";
    const explicitPlayed = stats.playedInGame === true || stats.fieldStatus === "ON_FIELD" || stats.fieldStatus === "SUBSTITUTED";
    if ((explicitDnp && positive) || (result.minutes === 0 && (positive || explicitPlayed)) || (explicitDnp && explicitPlayed)) {
      issue("conflicting_participation", known.id);
    } else if ((result.minutes !== null && result.minutes > 0) || explicitPlayed) result.participation = "played";
    else if (result.minutes === 0 || explicitDnp) result.participation = "dnp";
    else issue("unknown_participation", known.id);
    if (score.scoreStatus !== "FINAL" || stats.reviewed !== true || stats.live !== false) issue("statistics_under_review", known.id);
    appearances.set(known.id, result);
  }
  for (const prior of fixtureContext?.appearances ?? []) if (!appearances.has(prior.player.id)) {
    const known = player({ id: prior.player.id, slug: prior.player.slug, displayName: prior.player.name, position: ({ GK: "Goalkeeper", DEF: "Defender", MID: "Midfielder", FWD: "Forward", UNKNOWN: "Unknown" })[prior.player.position] }, prior.clubId);
    if (known) appearances.set(known.id, empty(known, prior.clubId));
  }
  for (const [id, value] of appearances) {
    if (!seen.has(id)) issue("missing_player_statistics", id);
    if (conflicts.has(id)) appearances.set(id, empty(value.player, ""));
  }
  fixture.appearances = [...appearances.values()];
  if (game.lowCoverage === true) issue("limited_source_coverage", fixture.id);
  batch.fixtures.push(fixture);
  return batch;
}
