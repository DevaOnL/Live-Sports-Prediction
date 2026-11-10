import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, evaluateForecast, inputHash } from "../forecast/engine";
import { prepareInputs } from "../forecast/inputs";
import type { ForecastResult, HistoryAppearance, PreparedInput } from "../forecast/types";

export type Row = Record<string, string | number | boolean | null>;
// Explicit columns are also the complete write allowlist for the disposable copy.
export const REPLAY_COLUMNS = {
  source_revisions: ["id", "provider", "action", "resource_key", "archive_ref", "content_sha256", "retrieved_at"],
  normalized_revisions: ["id", "ordinal", "source_revision_id", "entity_type", "entity_key", "content_sha256", "parent_id", "created_at"],
  competitions: ["id", "provider", "provider_id", "name", "country_name", "timezone", "coefficient", "enabled", "normalized_revision_id"],
  competition_seasons: ["id", "competition_id", "label", "starts_on", "ends_on", "expected_clubs", "enabled", "normalized_revision_id"],
  clubs: ["id", "provider", "provider_id", "name", "normalized_revision_id"],
  season_clubs: ["season_id", "club_id", "normalized_revision_id"],
  players: ["id", "provider", "provider_id", "name", "position", "normalized_revision_id"],
  player_memberships: ["id", "player_id", "club_id", "season_id", "valid_from", "valid_until", "normalized_revision_id"],
  fixtures: ["id", "provider", "provider_id", "season_id", "home_club_id", "away_club_id", "kickoff_at", "status", "statistics_status", "home_score", "away_score", "normalized_revision_id"],
  appearances: ["id", "fixture_id", "player_id", "season_id", "club_id", "membership_id", "participation", "minutes", "rating", "goals", "assists", "shots_on_target", "key_passes", "tackles", "interceptions", "saves", "goals_conceded", "normalized_revision_id"],
  roster_snapshots: ["id", "season_id", "source_revision_id", "observed_at", "complete", "normalized_revision_id"],
  roster_entries: ["snapshot_id", "season_id", "player_id", "club_id"],
  points_adjustments: ["id", "season_id", "club_id", "points", "reason", "effective_at", "provenance_url", "normalized_revision_id"],
} as const;
export type ReplayTable = keyof typeof REPLAY_COLUMNS;
export type ReplayTables = { [K in ReplayTable]: Row[] };
export type ReplayPlan = {
  playerId: string; position: string; sixthFixtureId: string;
  beforeSelected: string[]; afterSelected: string[];
  expectedHash: string; expectedResult: ForecastResult;
};
export type ReplaySnapshot = {
  cutoffAt: string; sourceOrdinal: string; digest: string;
  tables: ReplayTables; plan: ReplayPlan; withheldAppearance: Row;
};

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const providerId = /^[1-9]\d{0,17}$/;

/** A real observed sixth appearance, never an invented completion or DNP. */
export function replayPlan(prepared: PreparedInput): ReplayPlan | null {
  const input = prepared.input;
  if (!providerId.test(input.player.id) || !Number.isSafeInteger(Number(input.player.id))) return null;
  const original = evaluateForecast(input);
  if (original.status !== "available" || original.historyStatus !== "ready" || !original.target) return null;
  const eligible = input.appearances.filter((appearance): appearance is HistoryAppearance =>
    appearance.covered && appearance.status === "final" && appearance.kickoffAt !== null
    && Number.isFinite(Date.parse(appearance.kickoffAt)) && Date.parse(appearance.kickoffAt) < Date.parse(input.cutoffAt)
    && appearance.membershipKnown && appearance.clubId !== null
    && [appearance.homeClubId, appearance.awayClubId].includes(appearance.clubId)
    && appearance.participation === "played" && Number.isSafeInteger(appearance.minutes) && appearance.minutes! >= 60
    && appearance.minutes! <= 2_147_483_647)
    .sort((a, b) => Date.parse(a.kickoffAt!) - Date.parse(b.kickoffAt!) || compare(a.fixtureId, b.fixtureId));
  if (eligible.length < 6 || new Set(eligible.map((appearance) => appearance.fixtureId)).size !== eligible.length) return null;
  const six = eligible.slice(-6);
  const sixth = six[5];
  if (!providerId.test(sixth.fixtureId) || !Number.isSafeInteger(Number(sixth.fixtureId))) return null;
  // Choose an arrival whose missing row is independently at risk from an earlier
  // club checkpoint. The withheld row must not be its own only membership proof.
  const sixthAt = Date.parse(sixth.kickoffAt!);
  const claims = input.appearances.filter((appearance) => appearance.fixtureId !== sixth.fixtureId
    && appearance.status === "final" && appearance.kickoffAt !== null && Date.parse(appearance.kickoffAt) < sixthAt
    && appearance.membershipKnown && appearance.clubId !== null && appearance.participation !== "unknown")
    .sort((a, b) => Date.parse(a.kickoffAt!) - Date.parse(b.kickoffAt!));
  const latestClaim = claims.at(-1);
  if (!latestClaim || latestClaim.clubId !== sixth.clubId || latestClaim.leagueId !== sixth.leagueId || latestClaim.season !== sixth.season) return null;
  const claimAt = Date.parse(latestClaim.kickoffAt!);
  if (claims.some((claim) => Date.parse(claim.kickoffAt!) === claimAt && (claim.clubId !== sixth.clubId || claim.leagueId !== sixth.leagueId || claim.season !== sixth.season))) return null;
  const observations = prepared.provenance.rosterObservations;
  if (Array.isArray(observations) && observations.some((observation) => {
    if (typeof observation !== "object" || observation === null || !("observedAt" in observation) || typeof observation.observedAt !== "string") return true;
    const at = Date.parse(observation.observedAt);
    return !Number.isFinite(at) || (at >= claimAt && at <= sixthAt);
  })) return null;
  const expectedAfter = six.slice(1).map((appearance) => appearance.fixtureId);
  if (canonicalJson(original.selected.map((appearance) => appearance.fixtureId)) !== canonicalJson(expectedAfter)) return null;
  // The real schedule stays final. Missing this known row must block the old five.
  const withheld = evaluateForecast({ ...input,
    appearances: input.appearances.filter((appearance) => appearance.fixtureId !== sixth.fixtureId),
    gaps: [...input.gaps, { code: "missing_appearance_evidence", fixtureId: sixth.fixtureId, kickoffAt: sixth.kickoffAt }],
  });
  const beforeSelected = six.slice(0, 5).map((appearance) => appearance.fixtureId);
  if (withheld.historyStatus !== "incomplete_history" || withheld.status !== "unavailable"
    || canonicalJson(withheld.selected.map((appearance) => appearance.fixtureId)) !== canonicalJson(beforeSelected)) return null;
  return { playerId: input.player.id, position: input.player.position, sixthFixtureId: sixth.fixtureId,
    beforeSelected, afterSelected: expectedAfter, expectedHash: inputHash(input, original), expectedResult: original };
}

export async function replayRows(client: PoolClient, table: ReplayTable, where = "true", values: unknown[] = []): Promise<Row[]> {
  const fields = REPLAY_COLUMNS[table].map((column) => table === "normalized_revisions" && column === "ordinal" ? "ordinal::text AS ordinal" : column).join(",");
  const order = table === "normalized_revisions" ? "sports.normalized_revisions.ordinal" : REPLAY_COLUMNS[table].join(",");
  const result = await client.query<{ row: Row }>(`SELECT to_jsonb(t) AS row FROM (SELECT ${fields} FROM sports.${table} WHERE ${where} ORDER BY ${order}) t`, values);
  return result.rows.map((row) => row.row);
}

/** Read only football evidence under the same restricted identity as the app. */
export async function readReplaySnapshot(pool: Pool, signal?: AbortSignal): Promise<ReplaySnapshot> {
  const client = await pool.connect();
  const rows = (client: PoolClient, table: ReplayTable, where: string, values: unknown[] = []) => {
    signal?.throwIfAborted();
    return replayRows(client, table, where, values);
  };
  try {
    signal?.throwIfAborted();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const identity = (await client.query<{ name: string; read_only: string; writer: boolean; migrator: boolean; auth: boolean; superuser: boolean }>(
      `SELECT current_user AS name,current_setting('transaction_read_only') AS read_only,
       pg_has_role(current_user,'lsp_writer','MEMBER') AS writer,pg_has_role(current_user,'lsp_migrator','MEMBER') AS migrator,
       pg_has_role(current_user,'lsp_auth','MEMBER') AS auth,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0];
    if (identity.name !== "lsp_reader" || identity.read_only !== "on" || identity.writer || identity.migrator || identity.auth || identity.superuser) {
      throw new Error("Replay source requires the restricted reader");
    }
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const source = (await client.query<{ cutoff_at: Date; ordinal: string; watermark_id: string | null }>(
      `SELECT transaction_timestamp() AS cutoff_at,
       (SELECT coalesce(max(ordinal),0)::text FROM sports.normalized_revisions) AS ordinal,
       (SELECT id FROM sports.normalized_revisions ORDER BY ordinal DESC LIMIT 1) AS watermark_id`)).rows[0];
    const cutoffAt = source.cutoff_at.toISOString();
    const seasons = (await client.query<{ id: string; competition_id: string }>(`SELECT cs.id,cs.competition_id
      FROM sports.competition_seasons cs JOIN sports.competitions c ON c.id=cs.competition_id
      WHERE c.provider='apifootball' AND c.enabled AND cs.enabled AND c.provider_id IN ('153','164')
       AND cs.label='2026/27' AND cs.starts_on=DATE '2026-07-01' AND cs.ends_on=DATE '2027-06-30' AND c.coefficient=1.5
       AND ((c.provider_id='153' AND cs.expected_clubs=24 AND c.timezone='Europe/London')
        OR (c.provider_id='164' AND cs.expected_clubs=18 AND c.timezone='Europe/Paris')) ORDER BY c.provider_id`)).rows;
    if (!seasons.length) throw new Error("No approved canonical coverage");
    const seasonIds = seasons.map((season) => season.id);
    const candidateIds = (await client.query<{ provider_id: string }>(`SELECT p.provider_id FROM sports.players p
      JOIN sports.appearances a ON a.player_id=p.id JOIN sports.fixtures f ON f.id=a.fixture_id
      WHERE p.provider='apifootball' AND f.provider='apifootball' AND f.season_id=ANY($1::uuid[])
       AND f.status='final' AND f.kickoff_at<$2::timestamptz AND a.participation='played' AND a.minutes>=60
       AND a.membership_id IS NOT NULL AND a.club_id IN (f.home_club_id,f.away_club_id)
      GROUP BY p.provider_id HAVING count(DISTINCT f.id)>=6 ORDER BY p.provider_id`, [seasonIds, cutoffAt])).rows;
    let plan: ReplayPlan | null = null;
    for (let offset = 0; offset < candidateIds.length && !plan; offset += 16) {
      signal?.throwIfAborted();
      const prepared = await prepareInputs(client, cutoffAt, candidateIds.slice(offset, offset + 16).map((row) => row.provider_id));
      for (const item of prepared.values()) { plan = replayPlan(item); if (plan) break; }
    }
    if (!plan) throw new Error("No real player meets replay prerequisites");
    const tables = {} as ReplayTables;
    tables.competitions = await rows(client, "competitions", "id=ANY($1::uuid[])", [seasons.map((season) => season.competition_id)]);
    tables.competition_seasons = await rows(client, "competition_seasons", "id=ANY($1::uuid[])", [seasonIds]);
    tables.season_clubs = await rows(client, "season_clubs", "season_id=ANY($1::uuid[])", [seasonIds]);
    tables.clubs = await rows(client, "clubs", "id=ANY($1::uuid[])", [[...new Set(tables.season_clubs.map((row) => row.club_id))]]);
    tables.fixtures = await rows(client, "fixtures", "provider='apifootball' AND season_id=ANY($1::uuid[])", [seasonIds]);
    tables.appearances = await rows(client, "appearances", "fixture_id=ANY($1::uuid[])", [tables.fixtures.map((row) => row.id)]);
    tables.player_memberships = await rows(client, "player_memberships", "season_id=ANY($1::uuid[])", [seasonIds]);
    tables.roster_snapshots = await rows(client, "roster_snapshots", "season_id=ANY($1::uuid[])", [seasonIds]);
    tables.roster_entries = await rows(client, "roster_entries", "season_id=ANY($1::uuid[])", [seasonIds]);
    const playerIds = [...new Set([...tables.appearances, ...tables.player_memberships, ...tables.roster_entries].map((row) => row.player_id))];
    tables.players = await rows(client, "players", "id=ANY($1::uuid[])", [playerIds]);
    tables.points_adjustments = await rows(client, "points_adjustments", "season_id=ANY($1::uuid[])", [seasonIds]);
    const rootIds = [...new Set(Object.values(tables).flatMap((items) => items.map((row) => row.normalized_revision_id)).filter((id) => typeof id === "string"))];
    // Retain the original watermark witness as well as every referenced parent.
    if (source.watermark_id) rootIds.push(source.watermark_id);
    const chain = (await client.query<{ id: string }>(`WITH RECURSIVE required(id,parent_id) AS (
      SELECT id,parent_id FROM sports.normalized_revisions WHERE id=ANY($1::uuid[])
      UNION SELECT n.id,n.parent_id FROM sports.normalized_revisions n JOIN required r ON n.id=r.parent_id
    ) SELECT id FROM required`, [rootIds])).rows;
    tables.normalized_revisions = await rows(client, "normalized_revisions", "id=ANY($1::uuid[])", [chain.map((row) => row.id)]);
    const sourceIds = [...new Set([...tables.normalized_revisions, ...tables.roster_snapshots].map((row) => row.source_revision_id))];
    tables.source_revisions = await rows(client, "source_revisions", "id=ANY($1::uuid[])", [sourceIds]);
    const player = tables.players.find((row) => row.provider === "apifootball" && row.provider_id === plan.playerId);
    const fixture = tables.fixtures.find((row) => row.provider_id === plan.sixthFixtureId);
    const withheldAppearance = tables.appearances.find((row) => row.player_id === player?.id && row.fixture_id === fixture?.id);
    if (!withheldAppearance) throw new Error("Replay observation is absent from snapshot");
    const encoded = canonicalJson({ cutoffAt, sourceOrdinal: source.ordinal, tables });
    if (Buffer.byteLength(encoded) > 256 * 1024 * 1024) throw new Error("Replay snapshot exceeds its in-memory limit");
    const digest = createHash("sha256").update(encoded).digest("hex");
    signal?.throwIfAborted();
    await client.query("COMMIT");
    return { cutoffAt, sourceOrdinal: source.ordinal, tables, digest, plan, withheldAppearance };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
