import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, evaluateForecast, inputHash } from "../forecast/engine";
import { prepareInputs } from "../forecast/inputs";
import { METRICS, MODEL_VERSION, type ForecastInput, type ForecastResult, type HistoryAppearance, type Position } from "../forecast/types";
import { COVERAGE } from "../ingestion/coverage";
import { cutoffUtc, localDate } from "../ingestion/standings";
import type { BaselineName, EvaluationCohort, EvaluationOutput } from "./scoring";

export const PROSPECTIVE_PROTOCOL = Object.freeze({
  id: "prospective-v1", modelVersion: MODEL_VERSION,
  issueCutoff: "capture completed strictly before 00:00 on each target competition-local date",
  fixtureUniverse: "earliest scheduled future fixture for each approved club at capture",
  predictions: "unchanged heuristic computed once from the captured read-only canonical snapshot",
  ratingBaseline: "arithmetic mean of the same five provider ratings",
  statisticBaseline: "arithmetic mean of the same five individual per-90 rates",
  additionalStatisticBaseline: "pooled unweighted per-90 rate", additionalGoalsBaseline: "constant zero",
  positionGrouping: "captured position; current canonical position only for players absent from capture",
});
const APPROVED = `approved AS (
 SELECT cs.id AS season_id,cs.label,c.provider_id AS league_id,c.timezone
 FROM sports.competition_seasons cs JOIN sports.competitions c ON c.id=cs.competition_id
 WHERE c.provider='apifootball' AND c.enabled AND cs.enabled AND c.provider_id IN ('153','164')
 AND cs.label='2026/27' AND cs.starts_on=DATE '2026-07-01' AND cs.ends_on=DATE '2027-06-30' AND c.coefficient=1.5
 AND ((c.provider_id='153' AND cs.expected_clubs=24 AND c.timezone='Europe/London')
 OR (c.provider_id='164' AND cs.expected_clubs=18 AND c.timezone='Europe/Paris'))
)`;
const OUTPUTS: Record<Position, readonly EvaluationOutput[]> = {
  FWD: ["rating", "goals", "assists", "shotsOnTarget"], MID: ["rating", "assists", "keyPasses", "tackles"],
  DEF: ["rating", "tackles", "interceptions"], GK: ["rating", "saves", "goalsConceded"], UNKNOWN: ["rating"],
};
const fields = { goals: "goals", assists: "assists", shotsOnTarget: "shots_on_target", keyPasses: "key_passes",
  tackles: "tackles", interceptions: "interceptions", saves: "saves", goalsConceded: "goals_conceded" } as const;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const count = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v >= 0 && v <= 2_147_483_647;
const rating = (v: unknown): v is number => finite(v) && v >= 0 && v <= 10;
const iso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).sort().join(",") === [...expected].sort().join(",");
const names = (output: EvaluationOutput): BaselineName[] => output === "rating" ? ["ratingMean"]
  : output === "goals" ? ["arithmeticIndividualPer90", "pooledPer90", "goalZero"] : ["arithmeticIndividualPer90", "pooledPer90"];
const validReason = (value: unknown) => object(value) && typeof value.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value.code)
  && (value.fixtureId === undefined || typeof value.fixtureId === "string") && (value.field === undefined || typeof value.field === "string");
function validOutput(value: unknown, maximum = Infinity) {
  return object(value) && ["available", "unavailable"].includes(value.status as string) && Array.isArray(value.reasons) && value.reasons.every(validReason)
    && (value.status === "available" ? finite(value.value) && value.value >= 0 && value.value <= maximum : value.value === null);
}
type Baselines = Partial<Record<EvaluationOutput, Partial<Record<BaselineName, number>>>>;
export type ProspectiveFixture = {
  fixtureId: string; leagueId: string; season: string; competition: "championship" | "ligue_2";
  kickoffAt: string; homeClubId: string; awayClubId: string; issueCutoffAt: string; earliestForClubIds: string[];
};
export type ProspectivePlayer = {
  playerId: string; input: ForecastInput; result: ForecastResult; inputHash: string;
  provenance: Record<string, unknown>; baselines: Baselines;
};
type Source = { sourceOrdinal: string; latestRetrievedAt: string | null };
type CaptureBody = {
  schemaVersion: 1; protocol: typeof PROSPECTIVE_PROTOCOL; capturedAt: string; completedAt: string; source: Source;
  fixtures: ProspectiveFixture[]; missedIssueCutoffs: ProspectiveFixture[]; players: ProspectivePlayer[]; undatedFixturesOutsideUniverse: number;
};
export type ProspectiveCapture = CaptureBody & { digest: string };
export type ObservedFixture = Omit<ProspectiveFixture, "issueCutoffAt" | "earliestForClubIds" | "kickoffAt"> & {
  kickoffAt: string | null; status: HistoryAppearance["status"]; statisticsStatus: string;
};
export type ObservedTarget = { playerId: string; position: Position; target: HistoryAppearance };
export type ProspectiveOutcomes = { scoredAt: string; source: Source; fixtures: ObservedFixture[]; appearances: ObservedTarget[] };

function baseline(input: ForecastInput, result: ForecastResult): Baselines {
  const selected = result.selected.map((item) => input.appearances.filter((row) => row.fixtureId === item.fixtureId));
  if (selected.length !== 5 || selected.some((rows) => rows.length !== 1)) return {};
  const history = selected.map((rows) => rows[0]);
  const values: Baselines = {};
  for (const output of OUTPUTS[input.player.position]) {
    if (output === "rating") {
      if (history.every((row) => rating(row.rating))) values.rating = { ratingMean: history.reduce((n, row) => n + row.rating!, 0) / 5 };
    } else if (history.every((row) => count(row.metrics[output]) && count(row.minutes) && row.minutes >= 60)) {
      values[output] = {
        arithmeticIndividualPer90: history.reduce((n, row) => n + 90 * row.metrics[output]! / row.minutes!, 0) / 5,
        pooledPer90: 90 * history.reduce((n, row) => n + row.metrics[output]!, 0) / history.reduce((n, row) => n + row.minutes!, 0),
        ...(output === "goals" ? { goalZero: 0 } : {}),
      };
    }
  }
  return values;
}

/** A checksum detects changed files; it is not an external timestamp or signature. */
export function sealCapture(body: CaptureBody): ProspectiveCapture {
  return { ...body, digest: createHash("sha256").update(canonicalJson(body)).digest("hex") };
}

/** Reject malformed/changed captures. Scoring never regenerates model estimates. */
export function validateCapture(value: unknown): ProspectiveCapture {
  const invalid = (): never => { throw new Error("Invalid or changed prospective capture"); };
  if (!object(value) || !keys(value, ["schemaVersion", "protocol", "capturedAt", "completedAt", "source", "fixtures", "missedIssueCutoffs", "players", "undatedFixturesOutsideUniverse", "digest"])) invalid();
  const item = value as unknown as ProspectiveCapture;
  const { digest, ...body } = item;
  if (item.schemaVersion !== 1 || canonicalJson(item.protocol) !== canonicalJson(PROSPECTIVE_PROTOCOL)
    || !iso(item.capturedAt) || !iso(item.completedAt) || item.completedAt < item.capturedAt
    || !object(item.source) || !keys(item.source, ["sourceOrdinal", "latestRetrievedAt"]) || !/^\d+$/.test(item.source.sourceOrdinal)
    || (item.source.latestRetrievedAt !== null && (!iso(item.source.latestRetrievedAt) || item.source.latestRetrievedAt > item.capturedAt)) || !count(item.undatedFixturesOutsideUniverse)
    || !Array.isArray(item.fixtures) || !Array.isArray(item.missedIssueCutoffs) || !Array.isArray(item.players) || typeof digest !== "string"
    || digest !== sealCapture(body).digest) invalid();
  const fixtureIds = new Set<string>();
  for (const fixture of [...item.fixtures, ...item.missedIssueCutoffs]) {
    const missed = item.missedIssueCutoffs.includes(fixture);
    const coverage = COVERAGE.find((row) => row.id === fixture?.leagueId && row.season === fixture?.season);
    if (!object(fixture) || !keys(fixture, ["fixtureId", "leagueId", "season", "competition", "kickoffAt", "homeClubId", "awayClubId", "issueCutoffAt", "earliestForClubIds"])
      || !coverage || fixture.competition !== (fixture.leagueId === "153" ? "championship" : "ligue_2")
      || ![fixture.fixtureId, fixture.homeClubId, fixture.awayClubId].every((id) => typeof id === "string" && /^[1-9]\d{0,17}$/.test(id))
      || fixture.homeClubId === fixture.awayClubId || !iso(fixture.kickoffAt) || !iso(fixture.issueCutoffAt)
      || localDate(fixture.kickoffAt, coverage.timezone) < coverage.startsOn || localDate(fixture.kickoffAt, coverage.timezone) > coverage.endsOn
      || fixture.issueCutoffAt !== cutoffUtc(localDate(fixture.kickoffAt, coverage.timezone), coverage.timezone)
      || (missed ? fixture.issueCutoffAt > item.completedAt : fixture.issueCutoffAt <= item.completedAt)
      || fixture.kickoffAt <= item.capturedAt || !Array.isArray(fixture.earliestForClubIds) || !fixture.earliestForClubIds.length
      || new Set(fixture.earliestForClubIds).size !== fixture.earliestForClubIds.length
      || fixture.earliestForClubIds.some((id) => ![fixture.homeClubId, fixture.awayClubId].includes(id)) || fixtureIds.has(fixture.fixtureId)) invalid();
    fixtureIds.add(fixture.fixtureId);
  }
  const playerIds = new Set<string>();
  for (const player of item.players) {
    if (!object(player) || !keys(player, ["playerId", "input", "result", "inputHash", "provenance", "baselines"])
      || typeof player.playerId !== "string" || !/^[1-9]\d{0,17}$/.test(player.playerId) || playerIds.has(player.playerId)
      || !object(player.input) || !object(player.input.player) || !Object.hasOwn(OUTPUTS, player.input.player.position)
      || player.input.player.id !== player.playerId || player.input.cutoffAt !== item.capturedAt
      || !Array.isArray(player.input.appearances) || !Array.isArray(player.input.targets) || !Array.isArray(player.input.gaps)
      || !Array.isArray(player.input.rosterReasons) || !player.input.rosterReasons.every(validReason)
      || !object(player.result) || player.result.playerId !== player.playerId || player.result.cutoffAt !== item.capturedAt
      || player.result.modelVersion !== MODEL_VERSION || !Array.isArray(player.result.selected)
      || !["available", "partial", "unavailable"].includes(player.result.status)
      || !["ready", "incomplete_history", "insufficient_history"].includes(player.result.historyStatus)
      || !Array.isArray(player.result.reasons) || !player.result.reasons.every(validReason)
      || !Array.isArray(player.result.warnings) || !player.result.warnings.every(validReason)
      || !validOutput(player.result.adjustedFormIndex, 100) || !validOutput(player.result.forecastRating, 10)
      || !validOutput(player.result.displayedForecastRating, 100) || !object(player.result.projected90)
      || !object(player.provenance) || !object(player.baselines)) invalid();
    try {
      const expectedMetrics = OUTPUTS[player.input.player.position].filter((output) => output !== "rating");
      if (Object.keys(player.result.projected90).sort().join(",") !== [...expectedMetrics].sort().join(",")) invalid();
      if (player.input.appearances.some((row) => row.kickoffAt !== null && (!iso(row.kickoffAt) || row.kickoffAt >= item.capturedAt))
        || player.input.gaps.some((row) => row.kickoffAt !== null && (!iso(row.kickoffAt) || row.kickoffAt >= item.capturedAt))) invalid();
      if (player.provenance.sourceOrdinal !== item.source.sourceOrdinal
        || Object.keys(player.provenance).some((key) => !["sourceOrdinal", "playerRevisionId", "appearanceRevisionIds", "fixtureRevisionIds", "rosterObservations", "coverage"].includes(key))) invalid();
      const observations = player.provenance.rosterObservations;
      if (observations !== undefined && (!Array.isArray(observations) || observations.some((row) => !object(row) || !iso(row.observedAt) || row.observedAt > item.capturedAt))) invalid();
      // Validate the frozen selection without calculating model estimates again.
      const seen = new Set<string>();
      const expected = [...player.input.appearances].sort((a, b) => Date.parse(a.kickoffAt!) - Date.parse(b.kickoffAt!) || compare(a.fixtureId, b.fixtureId)
        || compare(canonicalJson(a), canonicalJson(b))).filter((row) => {
        if (!row.covered || ["live", "postponed", "cancelled"].includes(row.status) || !row.kickoffAt || !iso(row.kickoffAt)
          || row.kickoffAt >= item.capturedAt || seen.has(row.fixtureId)) return false;
        seen.add(row.fixtureId);
        return row.status === "final" && row.membershipKnown && row.clubId !== null && [row.homeClubId, row.awayClubId].includes(row.clubId)
          && row.participation === "played" && count(row.minutes) && row.minutes >= 60;
      }).slice(-5);
      if (canonicalJson(player.result.selected.map((row) => row.fixtureId)) !== canonicalJson(expected.map((row) => row.fixtureId))) invalid();
      const club = player.input.currentClub;
      const expectedTarget = !club || player.input.rosterReasons.length ? null : [...player.input.targets].filter((row) => row.status === "scheduled"
        && row.kickoffAt && iso(row.kickoffAt) && row.kickoffAt > item.capturedAt && row.leagueId === club.leagueId && row.season === club.season
        && [row.homeClubId, row.awayClubId].includes(club.clubId)).sort((a, b) => compare(a.kickoffAt!, b.kickoffAt!) || compare(a.fixtureId, b.fixtureId))[0] ?? null;
      if ((player.result.target?.fixtureId ?? null) !== (expectedTarget?.fixtureId ?? null)
        || (player.result.target && (player.result.target.kickoffAt !== expectedTarget!.kickoffAt || player.result.target.leagueId !== expectedTarget!.leagueId))) invalid();
      if (player.inputHash !== inputHash(player.input, player.result) || canonicalJson(player.baselines) !== canonicalJson(baseline(player.input, player.result))) invalid();
      for (const output of OUTPUTS[player.input.player.position]) {
        const estimate = output === "rating" ? player.result.forecastRating : player.result.projected90[output];
        if (!validOutput(estimate, output === "rating" ? 10 : Infinity)) invalid();
      }
    } catch { invalid(); }
    playerIds.add(player.playerId);
  }
  return item;
}

async function readOnly<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const row = (await client.query("SELECT current_user AS name,current_setting('transaction_read_only') AS read_only")).rows[0];
    if (row.name !== "lsp_reader" || row.read_only !== "on") throw new Error("Prospective measurement requires the restricted reader role");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** Called only after the capture snapshot committed and its private file was fsynced. */
export async function confirmProspectivePersistence(pool: Pool, value: unknown): Promise<string> {
  const capture = validateCapture(value);
  return readOnly(pool, async (client) => {
    const confirmedAt = (await client.query("SELECT clock_timestamp() AS at")).rows[0].at.toISOString();
    if (!iso(confirmedAt) || confirmedAt < capture.completedAt || capture.fixtures.some((fixture) => confirmedAt >= fixture.issueCutoffAt)) {
      throw new Error("Private capture was not durably confirmed before its issue cutoff");
    }
    return confirmedAt;
  });
}
async function source(client: PoolClient): Promise<Source> {
  const row = (await client.query(`SELECT (SELECT coalesce(max(ordinal),0)::text FROM sports.normalized_revisions) AS ordinal,
    (SELECT max(retrieved_at) FROM sports.source_revisions) AS latest`)).rows[0];
  return { sourceOrdinal: row.ordinal, latestRetrievedAt: row.latest?.toISOString() ?? null };
}
async function fixtures(client: PoolClient): Promise<ObservedFixture[]> {
  const rows = (await client.query(`WITH ${APPROVED} SELECT f.provider_id,a.league_id,a.label,f.kickoff_at,f.status,f.statistics_status,
    h.provider_id AS home_id,w.provider_id AS away_id FROM approved a JOIN sports.fixtures f ON f.season_id=a.season_id
    JOIN sports.clubs h ON h.id=f.home_club_id JOIN sports.clubs w ON w.id=f.away_club_id
    WHERE f.provider='apifootball' ORDER BY f.kickoff_at,f.provider_id COLLATE "C"`)).rows;
  return rows.map((row) => ({ fixtureId: row.provider_id, leagueId: row.league_id, season: row.label,
    competition: row.league_id === "153" ? "championship" : "ligue_2", kickoffAt: row.kickoff_at?.toISOString() ?? null,
    status: row.status, statisticsStatus: row.statistics_status, homeClubId: row.home_id, awayClubId: row.away_id }));
}

/** Capture is a transient forecast issuance, never a historical refresh or SQL write. */
export async function captureProspective(pool: Pool): Promise<ProspectiveCapture> {
  return readOnly(pool, async (client) => {
    const capturedAt = (await client.query("SELECT clock_timestamp() AS at")).rows[0].at.toISOString();
    const schedule = await fixtures(client);
    const ids = (await client.query(`WITH ${APPROVED} SELECT DISTINCT p.provider_id FROM sports.players p
      WHERE p.provider='apifootball' AND (EXISTS(SELECT 1 FROM sports.appearances x JOIN sports.fixtures f ON f.id=x.fixture_id
      JOIN approved a ON a.season_id=f.season_id WHERE x.player_id=p.id AND f.provider='apifootball') OR EXISTS(
      SELECT 1 FROM sports.roster_entries e JOIN sports.roster_snapshots r ON r.id=e.snapshot_id JOIN approved a ON a.season_id=e.season_id
      WHERE e.player_id=p.id AND r.observed_at<=$1::timestamptz)) ORDER BY p.provider_id`, [capturedAt])).rows.map((row) => row.provider_id as string);
    const prepared = await prepareInputs(client, capturedAt, ids);
    const players = [...prepared].map(([playerId, row]): ProspectivePlayer => {
      row.input.appearances = row.input.appearances.filter((appearance) => !appearance.kickoffAt || appearance.kickoffAt < capturedAt);
      row.input.gaps = row.input.gaps.filter((gap) => !gap.kickoffAt || gap.kickoffAt < capturedAt);
      const result = evaluateForecast(row.input);
      return { playerId, input: row.input, result, inputHash: inputHash(row.input, result), provenance: row.provenance, baselines: baseline(row.input, result) };
    });
    const earliest = new Map<string, string>();
    const candidates = new Map<string, ProspectiveFixture>();
    for (const fixture of schedule) {
      if (fixture.status !== "scheduled" || !fixture.kickoffAt || fixture.kickoffAt <= capturedAt) continue;
      const coverage = COVERAGE.find((row) => row.id === fixture.leagueId)!;
      for (const clubId of [fixture.homeClubId, fixture.awayClubId]) {
        const key = `${fixture.leagueId}:${fixture.season}:${clubId}`;
        if (earliest.has(key)) continue;
        earliest.set(key, fixture.fixtureId);
        if (!candidates.has(fixture.fixtureId)) candidates.set(fixture.fixtureId, {
          fixtureId: fixture.fixtureId, leagueId: fixture.leagueId, season: fixture.season, competition: fixture.competition,
          kickoffAt: fixture.kickoffAt, homeClubId: fixture.homeClubId, awayClubId: fixture.awayClubId,
          issueCutoffAt: cutoffUtc(localDate(fixture.kickoffAt, coverage.timezone), coverage.timezone), earliestForClubIds: [],
        });
        candidates.get(fixture.fixtureId)!.earliestForClubIds.push(clubId);
      }
    }
    const capturedSource = await source(client);
    const completedAt = (await client.query("SELECT clock_timestamp() AS at")).rows[0].at.toISOString();
    const capture = sealCapture({ schemaVersion: 1, protocol: PROSPECTIVE_PROTOCOL, capturedAt, completedAt, source: capturedSource,
      fixtures: [...candidates.values()].filter((row) => row.issueCutoffAt > completedAt).sort((a, b) => compare(a.fixtureId, b.fixtureId)),
      missedIssueCutoffs: [...candidates.values()].filter((row) => row.issueCutoffAt <= completedAt).sort((a, b) => compare(a.fixtureId, b.fixtureId)),
      players, undatedFixturesOutsideUniverse: schedule.filter((row) => !row.kickoffAt).length });
    return validateCapture(capture);
  });
}

function reasons(codes: string[]): string[] { return [...new Set(codes)].sort(compare); }
function eligibility(target: HistoryAppearance): string[] {
  return reasons([...(target.status !== "final" ? ["target_not_final"] : []), ...(target.participation !== "played" ? ["target_not_played"] : []),
    ...(!target.membershipKnown || !target.clubId || ![target.homeClubId, target.awayClubId].includes(target.clubId) ? ["target_membership_unknown"] : []),
    ...(!count(target.minutes) ? [target.minutes === null ? "target_minutes_missing" : "target_minutes_invalid"] : target.minutes < 60 ? ["target_minutes_below_60"] : [])]);
}
type Accumulator = { cohort: Omit<EvaluationCohort, "unscoredEligible" | "coverage" | "targetExclusions" | "exclusions" | "errors">;
  targetExclusions: Map<string, number>; exclusions: Map<string, number>; errors: number[]; baselines: Partial<Record<BaselineName, number[]>> };
function add(map: Map<string, number>, codes: string[]) { for (const code of reasons(codes)) map.set(code, (map.get(code) ?? 0) + 1); }
const counts = (map: Map<string, number>) => [...map].sort(([a], [b]) => compare(a, b)).map(([code, count]) => ({ code, count }));
function errors(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, mae: n ? values.reduce((a, b) => a + b, 0) / n : null,
    medianAbsoluteError: n ? n % 2 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : null };
}
function metadata(a: ProspectiveFixture, b: ObservedFixture | undefined) {
  return b && ["fixtureId", "leagueId", "season", "competition", "kickoffAt", "homeClubId", "awayClubId"].every((key) => a[key as keyof ProspectiveFixture] === b[key as keyof ObservedFixture]);
}

/** Pure outcome scoring: saved model estimates and baselines are never re-evaluated. */
export function scoreCapture(value: unknown, outcomes: ProspectiveOutcomes) {
  const capture = validateCapture(value);
  if (!iso(outcomes.scoredAt) || outcomes.scoredAt < capture.completedAt) throw new Error("Outcome snapshot precedes capture");
  const observed = new Map(outcomes.fixtures.map((row) => [row.fixtureId, row]));
  const frozen = new Map(capture.fixtures.map((row) => [row.fixtureId, row]));
  const players = new Map(capture.players.map((row) => [row.playerId, row]));
  const orderChanged = new Map<string, Set<string>>();
  for (const fixture of capture.fixtures) {
    const clubs = new Set(fixture.earliestForClubIds.filter((clubId) => outcomes.fixtures.some((row) => row.fixtureId !== fixture.fixtureId
      && row.leagueId === fixture.leagueId && row.season === fixture.season && row.kickoffAt && row.kickoffAt > capture.capturedAt
      && (row.kickoffAt < fixture.kickoffAt || (row.kickoffAt === fixture.kickoffAt && compare(row.fixtureId, fixture.fixtureId) < 0))
      && [row.homeClubId, row.awayClubId].includes(clubId) && ["scheduled", "live", "final"].includes(row.status))));
    if (clubs.size) orderChanged.set(fixture.fixtureId, clubs);
  }
  const fixtureCoverage = { captured: capture.fixtures.length, pending: 0, final: 0, missing: 0, undated: 0,
    metadataChanged: 0, orderChanged: orderChanged.size, finalsWithoutAppearances: 0, cancelledOrPostponed: 0,
    undatedOutsideUniverse: capture.undatedFixturesOutsideUniverse, missedIssueCutoffs: capture.missedIssueCutoffs.length,
    finalsWithCompleteStatistics: 0, finalsWithPartialStatistics: 0, finalsWithMissingStatistics: 0, finalsWithUnknownStatistics: 0 };
  for (const fixture of capture.fixtures) {
    const actual = observed.get(fixture.fixtureId);
    if (!actual) { fixtureCoverage.missing++; continue; }
    if (!actual.kickoffAt) fixtureCoverage.undated++;
    if (!metadata(fixture, actual)) fixtureCoverage.metadataChanged++;
    if (actual.status === "final") {
      fixtureCoverage.final++;
      if (actual.statisticsStatus === "complete") fixtureCoverage.finalsWithCompleteStatistics++;
      else if (actual.statisticsStatus === "partial") fixtureCoverage.finalsWithPartialStatistics++;
      else if (actual.statisticsStatus === "missing") fixtureCoverage.finalsWithMissingStatistics++;
      else if (actual.statisticsStatus === "unknown") fixtureCoverage.finalsWithUnknownStatistics++;
      if (!outcomes.appearances.some((row) => row.target.fixtureId === fixture.fixtureId)) fixtureCoverage.finalsWithoutAppearances++;
    } else if (["cancelled", "postponed"].includes(actual.status)) fixtureCoverage.cancelledOrPostponed++;
    else fixtureCoverage.pending++;
  }
  const accumulators = new Map<string, Accumulator>();
  const seen = new Set<string>();
  let candidateTargets = 0, eligibleTargets = 0, scoredTargetCases = 0;
  for (const row of [...outcomes.appearances].sort((a, b) => compare(a.playerId, b.playerId) || compare(a.target.fixtureId, b.target.fixtureId))) {
    const fixture = frozen.get(row.target.fixtureId);
    if (!fixture) continue;
    const caseKey = JSON.stringify([row.playerId, fixture.fixtureId]);
    if (seen.has(caseKey)) throw new Error("Duplicate prospective outcome");
    seen.add(caseKey); candidateTargets++;
    const saved = players.get(row.playerId), position = saved?.input.player.position ?? row.position;
    const targetReasons = eligibility(row.target), eligible = targetReasons.length === 0;
    if (eligible) eligibleTargets++;
    const validation = [
      ...(!metadata(fixture, observed.get(fixture.fixtureId)) ? ["target_metadata_changed"] : []),
      ...(orderChanged.get(fixture.fixtureId)?.has(row.target.clubId ?? "") ? ["target_order_changed"] : []),
      ...(!row.target.kickoffAt || row.target.kickoffAt > outcomes.scoredAt ? ["target_future_final"] : []),
    ];
    if (!saved) validation.push("prediction_not_captured");
    else {
      if (saved.result.target?.fixtureId !== fixture.fixtureId) validation.push("target_selection_mismatch");
      if (!saved.input.currentClub || saved.input.currentClub.clubId !== row.target.clubId
        || saved.input.currentClub.leagueId !== fixture.leagueId || saved.input.currentClub.season !== fixture.season) validation.push("target_club_mismatch");
    }
    let scoredAny = false;
    for (const output of OUTPUTS[position]) {
      const actual = output === "rating" ? row.target.rating : row.target.metrics[output];
      const validActual = output === "rating" ? rating(actual) : count(actual);
      const estimate = saved ? output === "rating" ? saved.result.forecastRating : saved.result.projected90[output] : undefined;
      const paired = saved?.baselines[output];
      const unavailable = reasons([...validation,
        ...(!validActual ? [actual === null ? "target_metric_missing" : "target_metric_invalid"] : []),
        ...(!estimate || estimate.status !== "available" ? ["model_output_unavailable", ...(estimate?.reasons.map((reason) => reason.code) ?? [])] : []),
        ...(!paired || names(output).some((name) => !finite(paired[name])) ? ["baseline_inputs_unavailable"] : []),
      ]);
      const scored = eligible && unavailable.length === 0;
      if (scored) scoredAny = true;
      for (const [leagueId, group] of [["all", "all"], [fixture.leagueId, "all"], ["all", position], [fixture.leagueId, position]] as const) {
        const key = JSON.stringify([leagueId, group, output]);
        let accumulator = accumulators.get(key);
        if (!accumulator) {
          accumulator = { cohort: { leagueId: leagueId as EvaluationCohort["leagueId"], position: group, output,
            unit: output === "rating" ? "0–10 rating" : "events per 90 minutes", candidateTargets: 0, eligibleTargets: 0, targetValueAvailable: 0, scored: 0 },
          targetExclusions: new Map(), exclusions: new Map(), errors: [], baselines: Object.fromEntries(names(output).map((name) => [name, []])) };
          accumulators.set(key, accumulator);
        }
        accumulator.cohort.candidateTargets++;
        if (!eligible) add(accumulator.targetExclusions, targetReasons);
        else {
          accumulator.cohort.eligibleTargets++;
          if (validActual) accumulator.cohort.targetValueAvailable++;
          if (!scored) add(accumulator.exclusions, unavailable);
          else {
            accumulator.cohort.scored++;
            const realized = output === "rating" ? actual! : 90 * actual! / row.target.minutes!;
            accumulator.errors.push(Math.abs(estimate!.value! - realized));
            for (const name of names(output)) accumulator.baselines[name]!.push(Math.abs(paired![name]! - realized));
          }
        }
      }
    }
    if (scoredAny) scoredTargetCases++;
  }
  const cohorts: EvaluationCohort[] = [...accumulators.values()].map((row) => ({ ...row.cohort,
    unscoredEligible: row.cohort.eligibleTargets - row.cohort.scored,
    coverage: row.cohort.eligibleTargets ? row.cohort.scored / row.cohort.eligibleTargets : null,
    targetExclusions: counts(row.targetExclusions), exclusions: counts(row.exclusions),
    errors: { heuristic: errors(row.errors), baselines: Object.fromEntries(names(row.cohort.output).map((name) => [name, errors(row.baselines[name]!)])) },
  })).sort((a, b) => compare(JSON.stringify([a.leagueId, a.position, a.output]), JSON.stringify([b.leagueId, b.position, b.output])));
  const measurementStatus = scoredTargetCases ? "measured" : !capture.fixtures.length ? "no_eligible_future_targets"
    : fixtureCoverage.pending ? "pending_outcomes" : "no_scorable_cases";
  const measurementReasons = scoredTargetCases ? [] : reasons([
    ...(!capture.fixtures.length ? [capture.missedIssueCutoffs.length ? "issue_cutoff_missed" : "no_future_fixture"] : []),
    ...(fixtureCoverage.pending ? ["pending_outcomes"] : []),
    ...(capture.fixtures.length && !fixtureCoverage.pending && !eligibleTargets ? ["no_eligible_target_appearances"] : []),
  ]);
  return { schemaVersion: 1, protocol: PROSPECTIVE_PROTOCOL, captureDigest: capture.digest, capturedAt: capture.capturedAt,
    completedAt: capture.completedAt, scoredAt: outcomes.scoredAt, source: outcomes.source, fixtureCoverage,
    measurementStatus, measurementReasons, candidateTargets, eligibleTargets, scoredTargetCases,
    coverageDenominator: "all observed eligible target appearances in the captured fixture universe, including uncaptured players and missing metrics",
    reasonCounts: "nonexclusive; each reason counted at most once per case and output", cohorts };
}

export async function scoreProspective(pool: Pool, value: unknown) {
  const capture = validateCapture(value);
  return readOnly(pool, async (client) => {
    const schedule = await fixtures(client);
    const rows = (await client.query(`WITH ${APPROVED} SELECT x.*,p.provider_id AS player_id,p.position,f.provider_id AS fixture_id,
      a.league_id,a.label,f.kickoff_at,f.status,h.provider_id AS home_id,w.provider_id AS away_id,c.provider_id AS club_id
      FROM approved a JOIN sports.fixtures f ON f.season_id=a.season_id AND f.provider='apifootball'
      JOIN sports.appearances x ON x.fixture_id=f.id JOIN sports.players p ON p.id=x.player_id AND p.provider='apifootball'
      JOIN sports.clubs h ON h.id=f.home_club_id JOIN sports.clubs w ON w.id=f.away_club_id LEFT JOIN sports.clubs c ON c.id=x.club_id
      WHERE f.provider_id=ANY($1::text[]) ORDER BY p.provider_id,f.provider_id`, [capture.fixtures.map((row) => row.fixtureId)])).rows;
    const appearances: ObservedTarget[] = rows.map((row) => ({ playerId: row.player_id, position: row.position,
      target: { fixtureId: row.fixture_id, leagueId: row.league_id, season: row.label,
        competition: row.league_id === "153" ? "championship" : "ligue_2", covered: true,
        kickoffAt: row.kickoff_at?.toISOString() ?? null, status: row.status, homeClubId: row.home_id, awayClubId: row.away_id,
        clubId: row.club_id, membershipKnown: row.membership_id !== null && row.club_id !== null, participation: row.participation,
        minutes: row.minutes, rating: row.rating === null ? null : Number(row.rating),
        metrics: Object.fromEntries(METRICS.map((metric) => [metric, row[fields[metric]]])) as HistoryAppearance["metrics"], context: null } }));
    const snapshotSource = await source(client);
    const scoredAt = (await client.query("SELECT clock_timestamp() AS at")).rows[0].at.toISOString();
    return scoreCapture(capture, { scoredAt, source: snapshotSource, fixtures: schedule, appearances });
  });
}
