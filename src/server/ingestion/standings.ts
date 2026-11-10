import type { Club, Coverage, Fixture, Issue, ProviderStanding } from "./types";

export type StandingRow = ProviderStanding & { position: number; rankUncertain: boolean };

export const POINTS_ADJUSTMENTS = [{
  leagueId: "153",
  clubId: "3072",
  points: -4,
  effectiveAt: "2026-05-19T17:45:00.000Z",
  reason: "Southampton 2026/27 points deduction",
  provenanceUrl: "https://images.gc.eflservices.co.uk/0a0e87d0-5538-11f1-ab88-f930a57d19ce.pdf",
}] as const;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string) {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    formatters.set(timezone, value);
  }
  return value;
}

function localParts(instant: Date, timezone: string) {
  const parts = formatter(timezone).formatToParts(instant);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === name)!.value;
  return {
    year: Number(part("year")), month: Number(part("month")), day: Number(part("day")),
    hour: Number(part("hour")), minute: Number(part("minute")), second: Number(part("second")),
  };
}

export function localDate(instant: string, timezone: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid UTC instant");
  const parts = localParts(date, timezone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Convert competition-local midnight to UTC, including the offset on that date. */
export function cutoffUtc(date: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError("Invalid local cutoff date");
  const midnight = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== date) {
    throw new RangeError("Invalid local cutoff date");
  }
  const wallTime = midnight.getTime();
  let candidate = wallTime;
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = localParts(new Date(candidate), timezone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const correction = wallTime - represented;
    if (correction === 0) return new Date(candidate).toISOString();
    candidate += correction;
  }
  throw new RangeError("Local cutoff midnight does not exist in this timezone");
}

type Totals = ProviderStanding & { awayGoals: number; awayWins: number };
type Result = { homeId: string; awayId: string; homeScore: number; awayScore: number };
type Metric = (row: Totals) => number;

function emptyTotals(clubId: string): Totals {
  return { clubId, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0,
    goalsAgainst: 0, points: 0, awayGoals: 0, awayWins: 0 };
}

function addResult(rows: Map<string, Totals>, result: Result) {
  const home = rows.get(result.homeId)!;
  const away = rows.get(result.awayId)!;
  home.played++;
  away.played++;
  home.goalsFor += result.homeScore;
  away.goalsFor += result.awayScore;
  home.goalsAgainst += result.awayScore;
  away.goalsAgainst += result.homeScore;
  away.awayGoals += result.awayScore;
  if (result.homeScore === result.awayScore) {
    home.draws++; away.draws++; home.points++; away.points++;
  } else {
    const winner = result.homeScore > result.awayScore ? home : away;
    const loser = winner === home ? away : home;
    winner.wins++; winner.points += 3; loser.losses++;
    if (winner === away) away.awayWins++;
  }
}

function split(rows: Totals[], metrics: Metric[]): Totals[][] {
  const compare = (a: Totals, b: Totals) => {
    for (const metric of metrics) {
      const difference = metric(b) - metric(a);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  const sorted = [...rows].sort(compare);
  const groups: Totals[][] = [];
  for (const row of sorted) {
    const previous = groups.at(-1);
    if (previous && compare(previous[0], row) === 0) previous.push(row);
    else groups.push([row]);
  }
  return groups;
}

const points: Metric = (row) => row.points;
const goalDifference: Metric = (row) => row.goalsFor - row.goalsAgainst;
const goalsFor: Metric = (row) => row.goalsFor;
const wins: Metric = (row) => row.wins;

function resolveTies(group: Totals[], results: Result[], leagueId: string): Totals[][] {
  if (group.length === 1) return [group];
  const miniTable = new Map(group.map((row) => [row.clubId, emptyTotals(row.clubId)]));
  const meetings = results.filter((result) => miniTable.has(result.homeId) && miniTable.has(result.awayId));
  const playedPairs = new Set(meetings.map((result) => JSON.stringify([result.homeId, result.awayId])));
  const bothMeetingsPlayed = group.every((home) => group.every((away) =>
    home === away || playedPairs.has(JSON.stringify([home.clubId, away.clubId]))));
  for (const meeting of meetings) addResult(miniTable, meeting);
  const headToHead = (metric: Metric): Metric => (row) => metric(miniTable.get(row.clubId)!);
  const headToHeadMetrics = leagueId === "164"
    ? (bothMeetingsPlayed ? [points, goalDifference].map(headToHead) : [])
    : [points, goalDifference, goalsFor].map(headToHead);
  const remainingMetrics: Metric[] = leagueId === "164"
    ? [goalsFor, wins, (row) => row.awayWins]
    : [wins, (row) => row.awayGoals];
  // The mini-table belongs to this whole tied group. Later criteria retain it.
  return split(group, [...headToHeadMetrics, ...remainingMetrics]);
}

function validScore(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

/** Retrospective standings from corrected results, never historical publication replay. */
export function reconstructStandings(
  coverage: Coverage, clubs: Club[], fixtures: Fixture[], cutoffDate: string,
  options: { asOf?: string } = {},
): { rows: StandingRow[]; complete: boolean; issues: Issue[] } {
  const issues: Issue[] = [];
  let complete = true;
  const gap = (code: string, resource: string, field?: string) => {
    complete = false;
    issues.push({ code, resource, ...(field ? { field } : {}) });
  };
  let cutoff: string;
  try {
    cutoff = cutoffUtc(cutoffDate, coverage.timezone);
    if (options.asOf !== undefined) {
      if (!Number.isFinite(Date.parse(options.asOf))) throw new RangeError("Invalid observation cutoff");
      cutoff = options.asOf;
    }
  } catch {
    return { rows: [], complete: false, issues: [{ code: "invalid_cutoff", resource: coverage.id }] };
  }
  const totals = new Map<string, Totals>();
  for (const club of clubs) {
    if (!club.id) { gap("invalid_club", coverage.id, "id"); continue; }
    if (totals.has(club.id)) { gap("duplicate_registration", club.id); continue; }
    totals.set(club.id, emptyTotals(club.id));
  }
  if (!Number.isSafeInteger(coverage.expectedClubs) || coverage.expectedClubs < 2 ||
      totals.size !== coverage.expectedClubs) gap("invalid_club_count", coverage.id, "clubs");
  if (coverage.id !== "153" && coverage.id !== "164") gap("unsupported_standings_rules", coverage.id);

  const uniqueFixtures = new Map<string, Fixture>();
  const conflictingIds = new Set<string>();
  for (const fixture of fixtures) {
    if (!fixture.id) { gap("invalid_fixture", coverage.id, "id"); continue; }
    const existing = uniqueFixtures.get(fixture.id);
    if (existing) {
      gap("duplicate_fixture", fixture.id);
      const fingerprint = (value: Fixture) => JSON.stringify([value.leagueId, value.season, value.home.id,
        value.away.id, value.kickoffAt, value.status, value.homeScore, value.awayScore]);
      if (fingerprint(existing) !== fingerprint(fixture)) conflictingIds.add(fixture.id);
    } else uniqueFixtures.set(fixture.id, fixture);
  }

  const schedule = new Map<string, Fixture>();
  const duplicatePairs = new Set<string>();
  for (const fixture of uniqueFixtures.values()) {
    if (conflictingIds.has(fixture.id)) { gap("conflicting_fixture", fixture.id); continue; }
    if (fixture.leagueId !== coverage.id || fixture.season !== coverage.season) {
      gap("fixture_outside_coverage", fixture.id); continue;
    }
    if (!totals.has(fixture.home.id) || !totals.has(fixture.away.id) || fixture.home.id === fixture.away.id) {
      gap("invalid_fixture_clubs", fixture.id); continue;
    }
    const pair = JSON.stringify([fixture.home.id, fixture.away.id]);
    if (schedule.has(pair)) {
      gap("duplicate_pairing", fixture.id); duplicatePairs.add(pair);
    } else schedule.set(pair, fixture);
  }
  // A missing schedule row could conceal a historical result. Require every
  // regular-season home/away pairing, even when missing rows may be in the future.
  if (schedule.size !== coverage.expectedClubs * (coverage.expectedClubs - 1) ||
      [...totals.keys()].some((home) => [...totals.keys()].some((away) =>
        home !== away && !schedule.has(JSON.stringify([home, away]))))) {
    gap("incomplete_schedule", coverage.id, "fixtures");
  }

  const results: Result[] = [];
  for (const [pair, fixture] of schedule) {
    if (duplicatePairs.has(pair)) continue;
    // These confirmed nonplaying states cannot supply a result, even when the
    // provider has removed their kickoff. Their pairings still count above.
    if (fixture.status === "cancelled" || fixture.status === "postponed") continue;
    let matchDate: string;
    try {
      if (!fixture.kickoffAt) throw new RangeError("Unknown kickoff");
      matchDate = localDate(fixture.kickoffAt, coverage.timezone);
    } catch {
      gap("unknown_kickoff", fixture.id, "kickoffAt"); continue;
    }
    if (matchDate < coverage.startsOn || matchDate > coverage.endsOn) {
      gap("fixture_outside_season", fixture.id, "kickoffAt"); continue;
    }
    if (matchDate >= cutoffDate) continue;
    // Current forecast context includes observed finals earlier on this local
    // date. A match that has not kicked off cannot contribute, and a known live
    // match has no final result yet. Stale past schedules remain an explicit gap.
    if (options.asOf !== undefined) {
      if (Date.parse(fixture.kickoffAt!) >= Date.parse(options.asOf)) continue;
      if (fixture.status === "live") continue;
    }
    if (fixture.status === "unknown") { gap("unknown_result", fixture.id, "status"); continue; }
    if (fixture.status === "scheduled" || fixture.status === "live") { gap("unfinished_past_fixture", fixture.id, "status"); continue; }
    if (fixture.status !== "final") continue;
    if (!validScore(fixture.homeScore) || !validScore(fixture.awayScore)) {
      gap("missing_final_score", fixture.id, "score"); continue;
    }
    const result = { homeId: fixture.home.id, awayId: fixture.away.id,
      homeScore: fixture.homeScore, awayScore: fixture.awayScore };
    results.push(result);
    addResult(totals, result);
  }

  for (const adjustment of POINTS_ADJUSTMENTS) {
    if (coverage.id === adjustment.leagueId && coverage.season === "2026/27" &&
        Date.parse(adjustment.effectiveAt) <= Date.parse(cutoff)) {
      const row = totals.get(adjustment.clubId);
      if (row) row.points += adjustment.points;
    }
  }

  const primaryMetrics = coverage.id === "164" ? [points, goalDifference] : [points, goalDifference, goalsFor];
  const ranked = split([...totals.values()], primaryMetrics).flatMap((group) => resolveTies(group, results, coverage.id));
  const rows: StandingRow[] = [];
  let position = 1;
  for (const group of ranked) {
    const rankUncertain = group.length > 1;
    if (rankUncertain) issues.push({ code: "unresolved_standings_tie", resource: coverage.id, field: "position" });
    for (const total of group) {
      rows.push({ clubId: total.clubId, played: total.played, wins: total.wins, draws: total.draws,
        losses: total.losses, goalsFor: total.goalsFor, goalsAgainst: total.goalsAgainst,
        points: total.points, position, rankUncertain });
    }
    position += group.length;
  }
  return { rows, complete, issues };
}
