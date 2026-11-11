import { createHash } from "node:crypto";
import { HIGHLIGHTLY_LEAGUES, object, type HighlightlyBox, type HighlightlySchedule } from "./highlightly-client";
import type { EnrichmentBatch } from "./enrichment-store";
import type { ArchivedResponse, Coverage } from "./types";

export type EnrichmentAppearance = {
  id: string; primaryRevisionId: string; playerId: string; name: string; clubId: string;
  participation: string; minutes: number | null; goals: number | null; assists: number | null;
  shotsOnTarget: number | null;
};
export type EnrichmentFixture = {
  id: string; nativeId: string; revisionId: string; leagueId: string; kickoffAt: string;
  home: { id: string; name: string }; away: { id: string; name: string };
  homeScore: number; awayScore: number; appearances: EnrichmentAppearance[];
};
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
// Some upstream names contain HTML apostrophe entities. Decode only these
// separators before comparing names; unknown entities remain literal evidence.
const apostrophes = (value: string) => value.replace(/&(?:apos|#0*39|#[xX]0*27);/g, "'");
const name = (value: string) => apostrophes(value).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
export function clubName(value: string): string {
  const key = name(value.replace(/\b(?:fc|cf|afc|football|club|de|del|the)\b/gi, ""));
  const aliases: Record<string, string> = {
    brighton: "brightonhovealbion", brightonandhovealbion: "brightonhovealbion",
    manchesterutd: "manchesterunited", newcastle: "newcastleunited", wolves: "wolverhamptonwanderers",
    tottenham: "tottenhamhotspur", westham: "westhamunited", leeds: "leedsunited",
    ipswich: "ipswichtown", coventry: "coventrycity",
    nottmforest: "nottinghamforest", athleticbilbao: "athletic", athleticbilbaoathletic: "athletic",
    alaves: "deportivoalaves", dalaves: "deportivoalaves", betis: "realbetisbalompie", realbetis: "realbetisbalompie",
    celta: "rcelta", rccelta: "rcelta", celtavigo: "rcelta", rcceltavigo: "rcelta", realclubceltavigo: "rcelta",
    espanyol: "rcdespanyol", rcdespanyolbarcelona: "rcdespanyol", osasuna: "caosasuna", oviedo: "realoviedo",
    realdeportivolacoruna: "deportivolacoruna", realracingsantander: "racingsantander",
    elche: "elche", rayo: "rayovallecano", levante: "levanteud",
  };
  return aliases[key] ?? key;
}

/** Only exact names or explicit initial abbreviations; never edit-distance matching. */
export function samePlayerName(primary: string, external: string): boolean {
  const primaryName = name(primary), externalName = name(external);
  if (!primaryName || !externalName) return false;
  if (primaryName === externalName) return true;
  const tokens = (value: string) => apostrophes(value).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const a = tokens(primary), b = tokens(external);
  const firstA = a[0], firstB = b[0];
  if (!firstA || !firstB || a.length < 2 || b.length < 2 || a.at(-1) !== b.at(-1)) return false;
  // One side must actually use initials, not a different full first name.
  return (firstA.length === 1 || firstB.length === 1) && firstA[0] === firstB[0]
    && (a.length === 2 || b.length === 2 || a.slice(1).join(" ") === b.slice(1).join(" "));
}

export function primaryFingerprint(fixture: EnrichmentFixture): string {
  return createHash("sha256").update(JSON.stringify([fixture.revisionId,
    fixture.appearances.map((a) => [a.id, a.primaryRevisionId]).sort((a, b) => a[0].localeCompare(b[0]))])).digest("hex");
}

export function scheduleFixtures(archive: ArchivedResponse, coverage: Coverage): Record<string, unknown>[] {
  if (archive.params.provider !== "highlightly" || archive.params.league_id !== coverage.id || archive.action !== "get_events"
    || archive.params.format !== "highlightly-schedule-v1" || !HIGHLIGHTLY_LEAGUES[coverage.id]) throw new Error("Supplementary schedule scope mismatch");
  const bundle: HighlightlySchedule = JSON.parse(archive.text);
  if (bundle.format !== "highlightly-schedule-v1" || !Array.isArray(bundle.captures) || !bundle.captures.length || bundle.captures.length > 4) throw new Error("Incomplete supplementary schedule");
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  let total: number | undefined;
  for (const [index, capture] of bundle.captures.entries()) {
    const page: unknown = JSON.parse(capture.text);
    const expected = new URLSearchParams({ leagueId: String(HIGHLIGHTLY_LEAGUES[coverage.id]), season: "2026", limit: "100", offset: String(index * 100) });
    if (capture.path !== `/matches?${expected}` || !Number.isFinite(Date.parse(capture.retrievedAt))
      || !object(page) || !object(page.pagination) || !object(page.plan) || page.plan.tier !== "BASIC"
      || typeof page.pagination.totalCount !== "number" || !Number.isSafeInteger(page.pagination.totalCount)
      || page.pagination.totalCount < 0 || page.pagination.totalCount > 380
      || (total !== undefined && total !== page.pagination.totalCount)
      || bundle.captures.length !== Math.max(1, Math.ceil(page.pagination.totalCount / 100))
      || page.pagination.offset !== index * 100 || !Array.isArray(page.data)
      || page.data.length !== Math.min(100, page.pagination.totalCount - index * 100)) throw new Error("Invalid supplementary schedule page");
    total = page.pagination.totalCount;
    for (const row of page.data) {
      if (!object(row) || !id(row.id) || seen.has(row.id) || !object(row.league)
        || row.league.id !== HIGHLIGHTLY_LEAGUES[coverage.id] || row.league.season !== 2026) throw new Error("Invalid supplementary fixture scope");
      seen.add(row.id); rows.push(row);
    }
  }
  return rows;
}

export function sameFixture(external: Record<string, unknown>, fixture: EnrichmentFixture): boolean {
  return !!HIGHLIGHTLY_LEAGUES[fixture.leagueId] && object(external.league) && external.league.id === HIGHLIGHTLY_LEAGUES[fixture.leagueId] && external.league.season === 2026
    && typeof external.date === "string" && Date.parse(external.date) === Date.parse(fixture.kickoffAt)
    && object(external.homeTeam) && object(external.awayTeam) && typeof external.homeTeam.name === "string" && typeof external.awayTeam.name === "string"
    && clubName(external.homeTeam.name).length > 0 && clubName(external.awayTeam.name).length > 0
    && clubName(external.homeTeam.name) === clubName(fixture.home.name) && clubName(external.awayTeam.name) === clubName(fixture.away.name)
    && object(external.state) && external.state.description === "Finished" && object(external.state.score)
    && external.state.score.current === `${fixture.homeScore} - ${fixture.awayScore}`;
}

export function normalizeHighlightly(archive: ArchivedResponse, fixture: EnrichmentFixture): EnrichmentBatch {
  if (archive.action !== "get_statistics" || archive.params.provider !== "highlightly" || archive.params.league_id !== fixture.leagueId
    || archive.params.format !== "highlightly-box-v1") throw new Error("Supplementary capture scope mismatch");
  const bundle: HighlightlyBox = JSON.parse(archive.text);
  if (bundle.format !== "highlightly-box-v1" || !object(bundle.fixture) || !id(bundle.fixture.id)
    || archive.params.match_id !== String(bundle.fixture.id) || !sameFixture(bundle.fixture, fixture)
    || bundle.primaryFingerprint !== primaryFingerprint(fixture) || bundle.capture.path !== `/box-score/${bundle.fixture.id}`
    || bundle.capture.retrievedAt !== archive.retrievedAt || !/^[a-f0-9]{64}$/.test(bundle.scheduleArchiveId)) throw new Error("Supplementary fixture evidence differs");
  const boxes: unknown = JSON.parse(bundle.capture.text);
  const home = bundle.fixture.homeTeam as Record<string, unknown>, away = bundle.fixture.awayTeam as Record<string, unknown>;
  if (!Array.isArray(boxes) || boxes.length !== 2 || !id(home.id) || !id(away.id) || home.id === away.id) throw new Error("Invalid supplementary teams");
  const teams = new Set<number>(), players = new Set<number>();
  const observations: EnrichmentBatch["observations"] = [];
  for (const box of boxes) {
    if (!object(box) || !object(box.team) || !id(box.team.id) || teams.has(box.team.id)
      || ![home.id, away.id].includes(box.team.id) || !Array.isArray(box.players) || box.players.length > 50) throw new Error("Invalid supplementary team identity");
    teams.add(box.team.id);
    const club = box.team.id === home.id ? fixture.home : fixture.away;
    for (const player of box.players) {
      if (!object(player) || !id(player.id) || players.has(player.id) || count(player.minutesPlayed) === null) throw new Error("Invalid supplementary player identity");
      players.add(player.id);
      if (player.minutesPlayed === 0) continue;
      const stats = object(player.statistics) ? player.statistics : Array.isArray(player.statistics) && player.statistics.length === 1 && object(player.statistics[0]) ? player.statistics[0] : null;
      if (!stats) continue;
      const names = [player.name, player.fullName].filter((value): value is string => typeof value === "string" && value.length > 0);
      const candidates = fixture.appearances.filter((a) => a.clubId === club.id && a.participation === "played"
        && a.minutes !== null && count(a.minutes) !== null && a.minutes > 0 && names.some((n) => samePlayerName(a.name, n))
        && a.goals !== null && a.goals === count(stats.goalsScored)
        && a.assists !== null && a.assists === count(stats.assists)
        && a.shotsOnTarget !== null && a.shotsOnTarget === count(stats.shotsOnTarget));
      if (candidates.length !== 1) continue;
      const appearance = candidates[0];
      const raw = typeof player.matchRating === "number" ? player.matchRating : typeof player.matchRating === "string" && /^\d+(?:\.\d{1,2})?$/.test(player.matchRating) ? Number(player.matchRating) : null;
      const rating = raw !== null && Number.isFinite(raw) && raw >= 0 && raw <= 10 && Math.round(raw * 100) / 100 === raw ? raw : null;
      observations.push({ appearanceId: appearance.id, primaryRevisionId: appearance.primaryRevisionId, externalPlayerId: String(player.id),
        evidence: { method: "unique_name_club_goals_assists_shots_primary_minutes", primaryName: appearance.name, externalNames: names,
          minutes: appearance.minutes, primaryMinutes: appearance.minutes, externalMinutes: player.minutesPlayed,
          minutesSource: "sorare", minutesDiscrepancy: Number(player.minutesPlayed) - Number(appearance.minutes),
          goals: appearance.goals, assists: appearance.assists, shotsOnTarget: appearance.shotsOnTarget,
          externalClubId: String(box.team.id), scheduleArchiveId: bundle.scheduleArchiveId },
        metrics: { rating, keyPasses: count(stats.passesKey), tackles: count(stats.tacklesTotal), interceptions: count(stats.interceptionsTotal) } });
    }
  }
  // A second external identity matching the same primary row invalidates both.
  return { fixtureId: fixture.id, fixtureRevisionId: fixture.revisionId, externalFixtureId: String(bundle.fixture.id),
    observations: observations.filter((a) => observations.filter((b) => b.appearanceId === a.appearanceId).length === 1) };
}
