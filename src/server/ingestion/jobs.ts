import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { LEGACY_SOURCE, sourceCoverage, sourceSeasonGuard, type SourceProfile } from "./sources";
import { ProviderError } from "./provider";
import { RateLimitError } from "./store";

type SourcePayload = { provider?: "sorare" };
type StatisticsJob = { id: string; kind: "fixture.statistics"; payload: SourcePayload & { leagueId: string; fixtureId: string } };
type StandingsJob = { id: string; kind: "standings.rebuild"; payload: SourcePayload & { leagueId: string } };
type ForecastJob = { id: string; kind: "forecast.refresh"; payload: SourcePayload };
type SourceSyncJob = { id: string; kind: "source.sync"; payload: SourcePayload };
export type IngestionJob = StatisticsJob | StandingsJob | ForecastJob | SourceSyncJob;
type Claimed = { id: string; kind: string; payload: unknown; attempts: number; max_attempts: number };
type Decision = { retry: boolean; undoAttempt: boolean; delay: number; code: string };

class InvalidJob extends Error {}

function parseJob(row: Claimed, profile: SourceProfile): IngestionJob {
  const payload = row.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new InvalidJob();
  const record = payload as Record<string, unknown>;
  const current = profile.provider === "sorare";
  if (current ? record.provider !== "sorare" : Object.hasOwn(record, "provider")) throw new InvalidJob();
  const scope: SourcePayload = current ? { provider: "sorare" } : {};
  const fields = Object.keys(record).length - (current ? 1 : 0);
  if ((row.kind === "forecast.refresh" || row.kind === "source.sync") && fields === 0) {
    return { id: row.id, kind: row.kind, payload: scope };
  }
  if (typeof record.leagueId !== "string") throw new InvalidJob();
  try { sourceCoverage(profile, record.leagueId); } catch { throw new InvalidJob(); }
  if (row.kind === "standings.rebuild" && fields === 1) {
    return { id: row.id, kind: row.kind, payload: { ...scope, leagueId: record.leagueId } };
  }
  const validFixture = typeof record.fixtureId === "string" && (current
    ? /^Game:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.fixtureId)
    : /^[1-9]\d{0,17}$/.test(record.fixtureId) && Number.isSafeInteger(Number(record.fixtureId)));
  if (row.kind === "fixture.statistics" && fields === 2 && validFixture) {
    return { id: row.id, kind: row.kind, payload: { ...scope, leagueId: record.leagueId, fixtureId: record.fixtureId as string } };
  }
  throw new InvalidJob();
}

function retryDecision(error: unknown, attempts: number): Decision {
  // Never persist upstream messages: they can contain credentials or raw payloads.
  if (error instanceof InvalidJob) return { retry: false, undoAttempt: false, delay: 0, code: "invalid_job" };
  const boundedDelay = (date: Date | undefined, fallback: number) => {
    const delay = date ? date.getTime() - Date.now() : fallback;
    return Math.max(1000, Math.min(3_600_000, Number.isFinite(delay) ? delay : fallback));
  };
  if (error instanceof RateLimitError) {
    return { retry: true, undoAttempt: true, delay: boundedDelay(error.retryAt, 60_000), code: "request_budget_exhausted" };
  }
  const backoff = Math.min(900_000, 5_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
  if (error instanceof ProviderError) {
    return { retry: error.retryable, undoAttempt: false, delay: boundedDelay(error.retryAt, backoff), code: error.code };
  }
  return { retry: true, undoAttempt: false, delay: backoff, code: "processing_failed" };
}

/** Durable ingestion jobs. Other outbox events remain available to their consumers. */
export class JobQueue {
  constructor(private readonly pool: Pool, private readonly workerId: string = randomUUID(), private readonly forecasts = false,
    private readonly profile: SourceProfile = LEGACY_SOURCE) {
    if (!workerId || workerId.length > 128 || /[\u0000-\u001f\u007f]/.test(workerId)) throw new Error("Invalid worker identity");
  }

  private get kinds(): string {
    return this.forecasts ? "('fixture.statistics','standings.rebuild','source.sync','forecast.refresh')" : "('fixture.statistics','standings.rebuild','source.sync')";
  }

  private sourceFilter(alias = ""): string {
    const column = `${alias ? `${alias}.` : ""}payload`;
    return this.profile.provider === "sorare" ? `${column}->>'provider'='sorare'` : `NOT (${column} ? 'provider')`;
  }

  private get sourcePayload(): string { return JSON.stringify(this.profile.provider === "sorare" ? { provider: "sorare" } : {}); }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally { client.release(); }
  }

  async dispatch(limit = 50): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid dispatch limit");
    return this.transaction(async (client) => {
      const events = await client.query<{ id: string; event_type: string; deduplication_key: string; payload: unknown }>(
        `SELECT id,event_type,deduplication_key,payload FROM sports.outbox
         WHERE published_at IS NULL AND event_type IN ('fixture.statistics','standings.rebuild','source.sync') AND ${this.sourceFilter()}
         ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $1`, [limit],
      );
      for (const event of events.rows) {
        await client.query(
          `INSERT INTO sports.jobs(outbox_id,kind,deduplication_key,payload)
           VALUES ($1,$2,$3,$4) ON CONFLICT (deduplication_key) DO NOTHING`,
          [event.id, event.event_type, event.deduplication_key, JSON.stringify(event.payload)],
        );
        await client.query("UPDATE sports.outbox SET published_at=clock_timestamp() WHERE id=$1", [event.id]);
      }
      let acknowledged = events.rows.length;
      if (this.forecasts) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lsp:forecast-dispatch',0))");
        const active = await client.query(`SELECT 1 FROM sports.jobs WHERE kind='forecast.refresh' AND status IN ('ready','running') AND ${this.sourceFilter()} LIMIT 1`);
        if (!active.rowCount) {
          const changes = await client.query<{ id: string }>(`SELECT id FROM sports.outbox
            WHERE published_at IS NULL AND event_type IN ('canonical.changed','standings.changed','roster.changed','forecast.requested') AND ${this.sourceFilter()}
            ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 100000`);
          if (changes.rows.length) {
            const anchor = changes.rows[0].id;
            await client.query(`INSERT INTO sports.jobs(outbox_id,kind,deduplication_key,payload)
              VALUES ($1,'forecast.refresh',$2,$3) ON CONFLICT(deduplication_key) DO NOTHING`, [anchor, `forecast.refresh:${anchor}`, this.sourcePayload]);
            await client.query("UPDATE sports.outbox SET published_at=clock_timestamp() WHERE id=ANY($1::uuid[])", [changes.rows.map((row) => row.id)]);
            acknowledged += changes.rows.length;
          }
        }
      }
      return acknowledged;
    });
  }

  async scheduleForecast(now = new Date()): Promise<number> {
    if (!this.forecasts) return 0;
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid forecast scheduling time");
    const bucket = Math.floor(now.getTime() / 60_000);
    if (this.profile.provider === "sorare") {
      const result = await this.pool.query(`INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
        SELECT 'forecast.requested','competition',c.id,$1,$2 FROM sports.competitions c
        JOIN sports.competition_seasons cs ON cs.competition_id=c.id WHERE ${sourceSeasonGuard(this.profile)}
        ORDER BY c.provider_id LIMIT 1 ON CONFLICT(deduplication_key) DO NOTHING`, [`forecast.clock:sorare:${bucket}`, this.sourcePayload]);
      return result.rowCount ?? 0;
    }
    const result = await this.pool.query(`INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
      SELECT 'forecast.requested','competition',id,$1,'{}' FROM sports.competitions
      WHERE provider='apifootball' AND provider_id IN ('153','164') AND enabled ORDER BY provider_id LIMIT 1
      ON CONFLICT(deduplication_key) DO NOTHING`, [`forecast.clock:${bucket}`]);
    return result.rowCount ?? 0;
  }

  async scheduleStatistics(): Promise<number> {
    const guard = this.profile.provider === "sorare" ? sourceSeasonGuard(this.profile, "s", "c") : `c.provider='apifootball'
      AND c.provider_id IN ('153','164') AND c.enabled AND s.enabled AND s.label='2026/27'
      AND s.starts_on='2026-07-01' AND s.ends_on='2027-06-30'`;
    const scope = this.profile.provider === "sorare" ? ` || '{"provider":"sorare"}'::jsonb` : "";
    const prefix = this.profile.provider === "sorare" ? "statistics.refresh:sorare:" : "statistics.refresh:";
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lsp:statistics-schedule',0))");
      const result = await client.query(
        `WITH candidates AS (
           SELECT f.id,f.provider_id,c.provider_id AS league_id,
             CASE WHEN f.status='live'
               THEN 'live:'||floor(extract(epoch FROM clock_timestamp())/900)::bigint::text
               ELSE 'daily:'||to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') END AS bucket,
             CASE WHEN f.status='live'
               THEN to_timestamp(floor(extract(epoch FROM clock_timestamp())/900)*900)
               ELSE date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END AS bucket_start
           FROM sports.fixtures f JOIN sports.competition_seasons s ON s.id=f.season_id
             JOIN sports.competitions c ON c.id=s.competition_id
           WHERE f.provider='${this.profile.provider}' AND ${guard}
             AND (f.status='live' OR (f.status='final' AND
               (f.statistics_status<>'complete' OR f.kickoff_at BETWEEN clock_timestamp()-interval '7 days' AND clock_timestamp())))
         ) INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
           SELECT 'fixture.statistics','fixture',f.id,'${prefix}'||f.provider_id||':'||f.bucket,
             jsonb_build_object('fixtureId',f.provider_id,'leagueId',f.league_id)${scope}
           FROM candidates f
           WHERE NOT EXISTS (SELECT 1 FROM sports.outbox o
             WHERE o.event_type='fixture.statistics' AND o.aggregate_id=f.id AND o.published_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM sports.jobs j WHERE j.kind='fixture.statistics'
               AND j.payload->>'fixtureId'=f.provider_id AND ${this.sourceFilter("j")}
               AND (j.status IN ('ready','running') OR j.completed_at>=f.bucket_start))
           ON CONFLICT (deduplication_key) DO NOTHING`,
      );
      return result.rowCount ?? 0;
    });
  }

  private async claim(token: string, forecastOnly: boolean): Promise<Claimed | null> {
    return this.transaction(async (client) => {
      // An expired final attempt becomes terminal; other interrupted work can retry.
      await client.query(
        `UPDATE sports.jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'ready' END,
           locked_by=NULL,locked_until=NULL,last_error='lease_expired',
           completed_at=CASE WHEN attempts>=max_attempts THEN clock_timestamp() ELSE NULL END,
           run_after=clock_timestamp()
         WHERE kind IN ${this.kinds}
           AND status='running' AND locked_until<=clock_timestamp() AND ${this.sourceFilter()}`,
      );
      const result = await client.query<Claimed>(
        `WITH next AS (
           SELECT id FROM sports.jobs WHERE status='ready' AND run_after<=clock_timestamp()
             AND kind IN ${forecastOnly ? "('forecast.refresh')" : this.kinds}
             AND ${this.sourceFilter()}
           ORDER BY CASE WHEN kind='forecast.refresh' THEN 0 WHEN kind='standings.rebuild' THEN 1 ELSE 2 END,run_after,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
         ) UPDATE sports.jobs j SET status='running',attempts=attempts+1,
             locked_by=$1,locked_until=clock_timestamp()+interval '120 seconds',last_error=NULL
           FROM next WHERE j.id=next.id RETURNING j.id,j.kind,j.payload,j.attempts,j.max_attempts`, [token],
      );
      return result.rows[0] ?? null;
    });
  }

  async runForecastOnce(handler: (job: IngestionJob) => Promise<void>): Promise<boolean> {
    return this.forecasts ? this.runOnce(handler, true) : false;
  }

  async runOnce(handler: (job: IngestionJob) => Promise<void>, forecastOnly = false): Promise<boolean> {
    const token = `${this.workerId}:${randomUUID()}`;
    const row = await this.claim(token, forecastOnly);
    if (!row) return false;
    let leaseLost = false;
    let renewal: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (renewal || leaseLost) return;
      renewal = this.pool.query(
        `UPDATE sports.jobs SET locked_until=clock_timestamp()+interval '120 seconds'
         WHERE id=$1 AND status='running' AND locked_by=$2 AND locked_until>clock_timestamp()`, [row.id, token],
      ).then((result) => { if (result.rowCount !== 1) leaseLost = true; })
        .catch(() => { leaseLost = true; }).finally(() => { renewal = null; });
    }, 30_000);
    timer.unref();
    let failure: unknown;
    let failed = false;
    try { await handler(parseJob(row, this.profile)); }
    catch (error) { failure = error; failed = true; }
    finally {
      clearInterval(timer);
      if (renewal) await renewal;
    }
    if (leaseLost) throw new Error("Job lease was lost");
    if (!failed) {
      const result = await this.pool.query(
        `UPDATE sports.jobs SET status='succeeded',locked_by=NULL,locked_until=NULL,
           completed_at=clock_timestamp(),last_error=NULL
         WHERE id=$1 AND status='running' AND locked_by=$2 AND locked_until>clock_timestamp()`, [row.id, token],
      );
      if (result.rowCount !== 1) throw new Error("Job lease was lost");
      return true;
    }
    const decision = retryDecision(failure, row.attempts);
    const retry = decision.retry && (decision.undoAttempt || row.attempts < row.max_attempts);
    const result = await this.pool.query(
      `UPDATE sports.jobs SET status=$3,attempts=attempts-$4,locked_by=NULL,locked_until=NULL,
         run_after=clock_timestamp()+($5::double precision * interval '1 millisecond'),last_error=$6,
         completed_at=CASE WHEN $3='failed' THEN clock_timestamp() ELSE NULL END
       WHERE id=$1 AND status='running' AND locked_by=$2 AND locked_until>clock_timestamp()`,
      [row.id, token, retry ? "ready" : "failed", decision.undoAttempt ? 1 : 0, decision.delay, decision.code],
    );
    if (result.rowCount !== 1) throw new Error("Job lease was lost");
    return true;
  }

  async status(): Promise<{ kind: string; status: string; count: string }[]> {
    const result = await this.pool.query<{ kind: string; status: string; count: string }>(
      `SELECT kind,status,count(*)::text AS count FROM sports.jobs
       WHERE kind IN ${this.kinds} AND ${this.sourceFilter()} GROUP BY kind,status ORDER BY kind,status`,
    );
    return result.rows;
  }

  async failures(): Promise<{ id: string; kind: string; attempts: number; last_error: string | null; completed_at: Date }[]> {
    const result = await this.pool.query<{ id: string; kind: string; attempts: number; last_error: string | null; completed_at: Date }>(
      `SELECT id,kind,attempts,last_error,completed_at FROM sports.jobs
       WHERE status='failed' AND kind IN ${this.kinds} AND ${this.sourceFilter()}
       ORDER BY completed_at DESC,id LIMIT 100`,
    );
    return result.rows;
  }

  async retryFailed(id: string): Promise<boolean> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid job identifier");
    const result = await this.pool.query(
      `UPDATE sports.jobs SET status='ready',attempts=0,run_after=clock_timestamp(),
         locked_by=NULL,locked_until=NULL,last_error=NULL,completed_at=NULL
       WHERE id=$1 AND status='failed' AND kind IN ${this.kinds} AND ${this.sourceFilter()}`, [id],
    );
    return result.rowCount === 1;
  }
}
