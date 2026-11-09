import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { PublicApiError } from "./error";
import { coverageFor } from "../ingestion/coverage";

export class AdminError extends PublicApiError {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(status, code, message);
    this.name = "AdminError";
  }
}

const kinds = ["source.sync", "fixture.statistics", "standings.rebuild", "forecast.refresh"] as const;
const statuses = ["ready", "running", "succeeded", "failed"] as const;
type Kind = typeof kinds[number];
type Status = typeof statuses[number];
export type AdminPagination = { page?: number; pageSize?: number };
export type AdminPage<T> = { items: T[]; page: number; pageSize: number; total: number };
const fields = {
  minutes: "minutes", rating: "rating", goals: "goals", assists: "assists", shotsOnTarget: "shots_on_target",
  keyPasses: "key_passes", tackles: "tackles", interceptions: "interceptions", saves: "saves", goalsConceded: "goals_conceded",
} as const;
export type AppearanceMetrics = Record<keyof typeof fields, number | null>;
export type AppearanceCorrection = {
  playerId: string; fixtureId: string; requestId: string; expectedRevisionId: string; reason: string;
  changes: Partial<AppearanceMetrics>;
};
export type QueuedAdminCommand = { requestId: string; accepted: true; eventId: string; kind: Kind };
export type RetriedAdminCommand = { requestId: string; accepted: true; jobId: string; kind: Kind };
export type CorrectedAppearance = {
  requestId: string; playerId: string; fixtureId: string; revisionId: string; previousRevisionId: string;
  sourceRevisionId: string; provider: "manual"; providerMaySupersede: true; metrics: AppearanceMetrics;
};
type CommandResult = QueuedAdminCommand | RetriedAdminCommand | CorrectedAppearance;
type Effect<T extends CommandResult> = {
  result: T; entityType: string; entityKey: string; revisionId?: string; detail?: Record<string, unknown>;
};

// These aliases are used only by SQL constants in this module.
const covered = `c.provider='apifootball' AND c.provider_id IN ('153','164') AND c.enabled AND s.enabled
  AND s.label='2026/27' AND s.starts_on=DATE '2026-07-01' AND s.ends_on=DATE '2027-06-30'
  AND c.coefficient=1.5
  AND ((c.provider_id='153' AND s.expected_clubs=24 AND c.timezone='Europe/London')
    OR (c.provider_id='164' AND s.expected_clubs=18 AND c.timezone='Europe/Paris'))`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const providerIdPattern = /^[1-9]\d{0,17}$/;
const errorCodes = new Set([
  "invalid_job", "lease_expired", "processing_failed", "request_budget_exhausted", "configuration_invalid", "request_invalid",
  "request_budget_unavailable", "transport_failed", "request_timeout", "http_rate_limit", "http_unavailable", "http_rejected",
  "redirect_rejected", "response_too_large", "credential_echo", "provider_rate_limit", "provider_unavailable", "provider_rejected",
]);

function invalid(): never { throw new AdminError(400, "invalid_request", "Invalid administration request"); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length || Object.keys(value).some((key) => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) invalid();
  return value.toLowerCase();
}
function providerId(value: unknown): string {
  if (typeof value !== "string" || !providerIdPattern.test(value) || !Number.isSafeInteger(Number(value))) invalid();
  return value;
}
function leagueId(value: unknown): string {
  const id = providerId(value);
  try { coverageFor(id); } catch { invalid(); }
  return id;
}
function actor(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid();
  return value;
}
function pagination(value: unknown): { page: number; pageSize: number; offset: number } {
  const input = record(value, ["page", "pageSize"]);
  const page = input.page === undefined ? 1 : input.page;
  const pageSize = input.pageSize === undefined ? 25 : input.pageSize;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 10_000
    || typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid();
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function iso(value: Date | string | null): string | null { return value === null ? null : new Date(value).toISOString(); }
function metricChanges(value: unknown): Partial<AppearanceMetrics> {
  const input = record(value, Object.keys(fields));
  if (!Object.keys(input).length) invalid();
  const result: Partial<AppearanceMetrics> = {};
  for (const key of Object.keys(fields) as (keyof AppearanceMetrics)[]) {
    if (!Object.hasOwn(input, key)) continue;
    const item = input[key];
    if (item !== null && (typeof item !== "number" || !Number.isFinite(item) || item < 0
      || (key === "rating" ? item > 10 || Math.round(item * 100) / 100 !== item
        : !Number.isInteger(item) || item > 2_147_483_647))) invalid();
    result[key] = item as number | null;
  }
  return result;
}
function metrics(row: QueryResultRow): AppearanceMetrics {
  return Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, row[column] === null ? null : Number(row[column])])) as AppearanceMetrics;
}
function safeError(error: unknown): AdminError {
  if (error instanceof AdminError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "23505" || code === "23503" || code === "40P01" || code === "40001"
    ? new AdminError(409, "data_conflict", "The operation conflicts with current data; retry with current values")
    : new AdminError(503, "admin_unavailable", "Administration service is unavailable");
}
function safePayload(kind: string, value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if ((kind === "source.sync" || kind === "forecast.refresh") && Object.keys(input).length === 0) return {};
  try {
    const league = leagueId(input.leagueId);
    if (kind === "standings.rebuild" && Object.keys(input).length === 1) return { leagueId: league };
    if (kind === "fixture.statistics" && Object.keys(input).length === 2) return { leagueId: league, fixtureId: providerId(input.fixtureId) };
  } catch { /* Invalid stored work is displayed without its payload and cannot be retried. */ }
  return null;
}
function safeDetail(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ["commandHash", "contentSha256"]) {
    if (typeof input[key] === "string" && /^[0-9a-f]{64}$/.test(input[key])) result[key] = input[key];
  }
  if (typeof input.requestId === "string" && uuidPattern.test(input.requestId)) result.requestId = input.requestId;
  if (typeof input.reason === "string") result.reason = input.reason.slice(0, 1000);
  for (const key of ["before", "after"]) {
    const item = input[key];
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const state: Record<string, unknown> = {};
    if (typeof source.revisionId === "string" && uuidPattern.test(source.revisionId)) state.revisionId = source.revisionId;
    if (typeof source.status === "string" && (statuses as readonly string[]).includes(source.status)) state.status = source.status;
    if (typeof source.attempts === "number" && Number.isInteger(source.attempts) && source.attempts >= 0) state.attempts = source.attempts;
    try { if (source.metrics) state.metrics = metricChanges(source.metrics); } catch { /* Do not expose arbitrary stored detail. */ }
    result[key] = state;
  }
  return result;
}

function replayResult(value: unknown, action: string, requestId: string): CommandResult | null {
  try {
    if (action === "admin.appearance.correct") {
      const item = record(value, ["requestId", "playerId", "fixtureId", "revisionId", "previousRevisionId", "sourceRevisionId", "provider", "providerMaySupersede", "metrics"]);
      if (uuid(item.requestId) !== requestId || item.provider !== "manual" || item.providerMaySupersede !== true) return null;
      const observed = metricChanges(item.metrics);
      if (Object.keys(observed).length !== Object.keys(fields).length) return null;
      return { requestId, playerId: providerId(item.playerId), fixtureId: providerId(item.fixtureId), revisionId: uuid(item.revisionId),
        previousRevisionId: uuid(item.previousRevisionId), sourceRevisionId: uuid(item.sourceRevisionId), provider: "manual",
        providerMaySupersede: true, metrics: observed as AppearanceMetrics };
    }
    const retry = action === "admin.job.retry";
    const item = record(value, ["requestId", "accepted", retry ? "jobId" : "eventId", "kind"]);
    if (uuid(item.requestId) !== requestId || item.accepted !== true || !(kinds as readonly unknown[]).includes(item.kind)) return null;
    if (retry) return { requestId, accepted: true, jobId: uuid(item.jobId), kind: item.kind as Kind };
    const expected = action === "admin.source.sync" ? "source.sync" : action === "admin.forecast.refresh" ? "forecast.refresh" : "fixture.statistics";
    if (item.kind !== expected) return null;
    return { requestId, accepted: true, eventId: uuid(item.eventId), kind: item.kind as Kind };
  } catch { return null; }
}

/** Call only after a fresh database-backed administrator/session check. Uses the writer login. */
export class AdminService {
  constructor(private readonly pool: Pool) {}

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) { throw safeError(error); }
  }

  private async command<T extends CommandResult>(actorValue: string, requestValue: string, action: string, parameters: unknown,
    operation: (client: PoolClient, commandHash: string, requestId: string) => Promise<Effect<T>>): Promise<T> {
    const actorId = actor(actorValue);
    const requestId = uuid(requestValue);
    const commandHash = digest({ actorId, requestId, action, parameters });
    return this.read(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`lsp:admin-request:${requestId}`]);
        const previous = await client.query<{ actor_type: string; actor_id: string | null; action: string; detail: Record<string, unknown> }>(
          "SELECT actor_type,actor_id,action,detail FROM sports.audit_log WHERE id=$1", [requestId],
        );
        if (previous.rows[0]) {
          const item = previous.rows[0];
          const result = replayResult(item.detail.result, action, requestId);
          if (item.actor_type !== "user" || item.actor_id !== actorId || item.action !== action
            || item.detail.commandHash !== commandHash || result === null) {
            throw new AdminError(409, "request_conflict", "Request identifier was already used for another command");
          }
          await client.query("COMMIT");
          return result as T;
        }
        const effect = await operation(client, commandHash, requestId);
        await client.query(`INSERT INTO sports.audit_log(id,normalized_revision_id,actor_type,actor_id,action,entity_type,entity_key,detail)
          VALUES ($1,$2,'user',$3,$4,$5,$6,$7)`, [requestId, effect.revisionId ?? null, actorId, action, effect.entityType,
          effect.entityKey, JSON.stringify({ ...effect.detail, requestId, commandHash, result: effect.result })]);
        await client.query("COMMIT");
        return effect.result;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* Preserve a safe classification of the original failure. */ }
        throw error;
      } finally { client.release(); }
    });
  }

  async status() {
    return this.read(async () => {
      const [coverage, jobs, imports, budget] = await Promise.all([
        this.pool.query(`SELECT c.provider_id AS league_id,s.label AS season,count(f.id)::integer AS fixtures,
          count(f.id) FILTER (WHERE f.status='final')::integer AS final_fixtures,
          count(f.id) FILTER (WHERE f.status IN ('live','final') AND f.statistics_status<>'complete')::integer AS incomplete_statistics
          FROM sports.competitions c JOIN sports.competition_seasons s ON s.competition_id=c.id
          LEFT JOIN sports.fixtures f ON f.season_id=s.id AND f.provider='apifootball'
          WHERE ${covered} GROUP BY c.provider_id,s.label ORDER BY c.provider_id`),
        this.pool.query(`SELECT kind,status,count(*)::integer AS count FROM sports.jobs WHERE kind=ANY($1::text[])
          GROUP BY kind,status ORDER BY kind,status`, [kinds]),
        this.pool.query(`SELECT count(*)::integer AS batches,coalesce(sum(jsonb_array_length(issues_json)),0)::integer AS validation_issues,
          max(committed_at) AS last_committed_at FROM sports.ingestion_batches`),
        this.pool.query(`SELECT count(*)::integer AS used,min(attempted_at)+interval '1 hour' AS retry_at
          FROM sports.provider_requests WHERE attempted_at>clock_timestamp()-interval '1 hour'`),
      ]);
      const used = budget.rows[0].used as number;
      return {
        coverage: coverage.rows.map((row) => ({ leagueId: row.league_id as string, season: row.season as string,
          fixtures: row.fixtures as number, finalFixtures: row.final_fixtures as number, incompleteStatistics: row.incomplete_statistics as number })),
        jobs: jobs.rows.map((row) => ({ kind: row.kind as Kind, status: row.status as Status, count: row.count as number })),
        imports: { batches: imports.rows[0].batches as number, validationIssues: imports.rows[0].validation_issues as number,
          lastCommittedAt: iso(imports.rows[0].last_committed_at) },
        providerBudget: { limit: 120, used, remaining: Math.max(0, 120 - used), retryAt: used >= 120 ? iso(budget.rows[0].retry_at) : null },
      };
    });
  }

  async jobs(options: AdminPagination & { status?: string; kind?: string } = {}) {
    const input = record(options, ["status", "kind", "page", "pageSize"]);
    const { page, pageSize, offset } = pagination({ page: input.page, pageSize: input.pageSize });
    if ((input.status !== undefined && !(statuses as readonly unknown[]).includes(input.status))
      || (input.kind !== undefined && !(kinds as readonly unknown[]).includes(input.kind))) invalid();
    return this.read(async () => {
      const parameters = [kinds, input.status ?? null, input.kind ?? null];
      const condition = "kind=ANY($1::text[]) AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR kind=$3)";
      const [count, rows] = await Promise.all([
        this.pool.query(`SELECT count(*)::integer AS total FROM sports.jobs WHERE ${condition}`, parameters),
        this.pool.query(`SELECT id,kind,status,payload,attempts,max_attempts,run_after,locked_until,last_error,created_at,completed_at
          FROM sports.jobs WHERE ${condition} ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`, [...parameters, pageSize, offset]),
      ]);
      return { page, pageSize, total: count.rows[0].total as number, items: rows.rows.map((row) => ({
        id: row.id as string, kind: row.kind as Kind, status: row.status as Status, payload: safePayload(row.kind, row.payload) ?? {},
        attempts: row.attempts as number, maxAttempts: row.max_attempts as number, runAfter: iso(row.run_after),
        lockedUntil: iso(row.locked_until), lastError: row.last_error === null ? null : errorCodes.has(row.last_error) ? row.last_error as string : "processing_failed",
        createdAt: iso(row.created_at), completedAt: iso(row.completed_at),
      })) };
    });
  }

  async audit(options: AdminPagination = {}) {
    const { page, pageSize, offset } = pagination(options);
    return this.read(async () => {
      const [count, rows] = await Promise.all([
        this.pool.query("SELECT count(*)::integer AS total FROM sports.audit_log"),
        this.pool.query(`SELECT id,normalized_revision_id,actor_type,actor_id,action,entity_type,entity_key,detail,occurred_at
          FROM sports.audit_log ORDER BY occurred_at DESC,id DESC LIMIT $1 OFFSET $2`, [pageSize, offset]),
      ]);
      return { page, pageSize, total: count.rows[0].total as number, items: rows.rows.map((row) => ({
        id: row.id as string, revisionId: row.normalized_revision_id as string | null, actorType: row.actor_type as string,
        actorId: row.actor_id as string | null, action: row.action as string, entityType: row.entity_type as string,
        entityKey: row.entity_key as string, detail: safeDetail(row.detail), occurredAt: iso(row.occurred_at),
      })) };
    });
  }

  private enqueue(actorId: string, requestId: string, action: string, kind: Kind, eventType: string) {
    return this.command(actorId, requestId, action, {}, async (client, _hash, id): Promise<Effect<QueuedAdminCommand>> => {
      const event = await client.query<{ id: string }>(`INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
        VALUES ($1,'request',$2,$3,'{}') RETURNING id`, [eventType, id, `admin:${id}`]);
      return { entityType: "request", entityKey: id, result: { requestId: id, accepted: true, eventId: event.rows[0].id, kind } };
    });
  }

  async requestImport(actorId: string, requestId: string): Promise<QueuedAdminCommand> {
    return this.enqueue(actorId, requestId, "admin.source.sync", "source.sync", "source.sync");
  }

  async requestRefresh(actorId: string, requestId: string): Promise<QueuedAdminCommand> {
    return this.enqueue(actorId, requestId, "admin.forecast.refresh", "forecast.refresh", "forecast.requested");
  }

  async requestStatistics(actorId: string, options: { leagueId: string; fixtureId: string; requestId: string }): Promise<QueuedAdminCommand> {
    const input = record(options, ["leagueId", "fixtureId", "requestId"]);
    const league = leagueId(input.leagueId), fixture = providerId(input.fixtureId);
    return this.command(actorId, uuid(input.requestId), "admin.fixture.statistics", { leagueId: league, fixtureId: fixture }, async (client, _hash, id) => {
      const target = await client.query<{ id: string }>(`SELECT f.id FROM sports.fixtures f
        JOIN sports.competition_seasons s ON s.id=f.season_id JOIN sports.competitions c ON c.id=s.competition_id
        WHERE f.provider='apifootball' AND f.provider_id=$1 AND c.provider_id=$2 AND ${covered}
          AND f.status IN ('live','final') FOR SHARE OF f,s,c`, [fixture, league]);
      if (!target.rows[0]) throw new AdminError(409, "statistics_unavailable", "Statistics can only be requested for a covered live or final fixture");
      const event = await client.query<{ id: string }>(`INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
        VALUES ('fixture.statistics','fixture',$1,$2,$3) RETURNING id`, [target.rows[0].id, `admin:${id}`, JSON.stringify({ leagueId: league, fixtureId: fixture })]);
      return { entityType: "fixture", entityKey: fixture,
        result: { requestId: id, accepted: true, eventId: event.rows[0].id, kind: "fixture.statistics" as const } };
    });
  }

  async retry(actorId: string, jobId: string, requestId: string): Promise<RetriedAdminCommand> {
    const job = uuid(jobId);
    return this.command(actorId, requestId, "admin.job.retry", { jobId: job }, async (client, _hash, id) => {
      const found = await client.query<{ kind: Kind; status: Status; attempts: number; payload: unknown }>(
        "SELECT kind,status,attempts,payload FROM sports.jobs WHERE id=$1 FOR UPDATE", [job],
      );
      const row = found.rows[0];
      if (!row || !(kinds as readonly string[]).includes(row.kind)) throw new AdminError(404, "job_not_found", "Job was not found");
      if (row.status !== "failed") throw new AdminError(409, "job_not_failed", "Only failed jobs can be retried");
      if (!safePayload(row.kind, row.payload)) throw new AdminError(409, "invalid_job", "Job payload is invalid and cannot be retried");
      await client.query(`UPDATE sports.jobs SET status='ready',attempts=0,run_after=clock_timestamp(),locked_by=NULL,
        locked_until=NULL,last_error=NULL,completed_at=NULL WHERE id=$1`, [job]);
      return { entityType: "job", entityKey: job, detail: { before: { status: row.status, attempts: row.attempts }, after: { status: "ready", attempts: 0 } },
        result: { requestId: id, accepted: true, jobId: job, kind: row.kind } };
    });
  }

  async correctAppearance(actorId: string, options: AppearanceCorrection): Promise<CorrectedAppearance> {
    const input = record(options, ["playerId", "fixtureId", "requestId", "expectedRevisionId", "reason", "changes"]);
    const playerId = providerId(input.playerId), fixtureId = providerId(input.fixtureId), expectedRevisionId = uuid(input.expectedRevisionId);
    if (typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.length > 1000 || /[\u0000-\u001f\u007f]/.test(input.reason)) invalid();
    const reason = input.reason.trim(), changes = metricChanges(input.changes);
    return this.command(actorId, uuid(input.requestId), "admin.appearance.correct", { playerId, fixtureId, expectedRevisionId, reason, changes },
      async (client, commandHash, requestId) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lsp:ingestion',0))");
        const found = await client.query(`SELECT a.*,n.entity_type,n.entity_key,
          (${covered} AND f.status='final' AND a.participation='played' AND f.kickoff_at<=clock_timestamp()
            AND isfinite(f.kickoff_at) AND club.provider='apifootball' AND a.club_id IN (f.home_club_id,f.away_club_id)
            AND m.player_id=a.player_id AND m.club_id=a.club_id AND m.season_id=a.season_id
            AND f.kickoff_at>=m.valid_from AND (m.valid_until IS NULL OR f.kickoff_at<m.valid_until)) AS correctable
          FROM sports.appearances a JOIN sports.players p ON p.id=a.player_id JOIN sports.fixtures f ON f.id=a.fixture_id
          JOIN sports.competition_seasons s ON s.id=f.season_id JOIN sports.competitions c ON c.id=s.competition_id
          LEFT JOIN sports.clubs club ON club.id=a.club_id LEFT JOIN sports.player_memberships m ON m.id=a.membership_id
          LEFT JOIN sports.normalized_revisions n ON n.id=a.normalized_revision_id
          WHERE p.provider='apifootball' AND p.provider_id=$1 AND f.provider='apifootball' AND f.provider_id=$2
          FOR UPDATE OF a FOR SHARE OF f,s,c`, [playerId, fixtureId]);
        const row = found.rows[0];
        if (!row) throw new AdminError(404, "appearance_not_found", "Appearance was not found");
        if (row.normalized_revision_id !== expectedRevisionId) throw new AdminError(409, "revision_conflict", "Appearance changed; reload before correcting it");
        if (row.correctable !== true || row.entity_type !== "appearance" || row.entity_key !== `${fixtureId}:${playerId}`) {
          throw new AdminError(409, "correction_unavailable", "Only a known played appearance in a covered final fixture can be corrected");
        }
        const before = metrics(row), after = { ...before, ...changes };
        const source = await client.query<{ id: string }>(`INSERT INTO sports.source_revisions(provider,action,resource_key,archive_ref,content_sha256,retrieved_at)
          VALUES ('manual','appearance.correct',$1,$2,$3,clock_timestamp()) RETURNING id`, [`${fixtureId}:${playerId}`, `manual:${requestId}`, commandHash]);
        // Match the ingestion canonical shape so later provider observations can supersede a correction normally.
        const content = { fixture_id: row.fixture_id, player_id: row.player_id, season_id: row.season_id,
          club_id: row.club_id, membership_id: row.membership_id, participation: row.participation,
          ...Object.fromEntries(Object.entries(fields).map(([key, column]) => [column, after[key as keyof AppearanceMetrics]])) };
        const revision = await client.query<{ id: string }>(`INSERT INTO sports.normalized_revisions(source_revision_id,entity_type,entity_key,content_sha256,parent_id)
          VALUES ($1,'appearance',$2,$3,$4) RETURNING id`, [source.rows[0].id, `${fixtureId}:${playerId}`, digest(content), expectedRevisionId]);
        const revisionId = revision.rows[0].id;
        const columns = Object.values(fields);
        await client.query(`UPDATE sports.appearances SET ${columns.map((column, index) => `${column}=$${index + 1}`).join(",")},
          normalized_revision_id=$11 WHERE id=$12`, [...Object.keys(fields).map((key) => after[key as keyof AppearanceMetrics]), revisionId, row.id]);
        await client.query(`INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
          VALUES ('canonical.changed','appearance',$1,$2,$3)`, [row.id, `appearance:${revisionId}`, JSON.stringify({ fixtureId, playerId, revisionId })]);
        return { entityType: "appearance", entityKey: `${fixtureId}:${playerId}`, revisionId,
          detail: { reason, before: { revisionId: expectedRevisionId, metrics: before }, after: { revisionId, metrics: after } },
          result: { requestId, playerId, fixtureId, revisionId, previousRevisionId: expectedRevisionId,
            sourceRevisionId: source.rows[0].id, provider: "manual" as const, providerMaySupersede: true as const, metrics: after } };
      });
  }
}
