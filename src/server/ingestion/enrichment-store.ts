import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { archiveId, validateArchive } from "./archive";
import { CURRENT_SOURCE, sourceSeasonGuard } from "./sources";
import { RateLimitError } from "./store";
import type { ArchivedResponse, ImportResult, ProviderAction } from "./types";

export type EnrichmentMetrics = { rating: number | null; keyPasses: number | null; tackles: number | null; interceptions: number | null };
export type EnrichmentObservation = {
  appearanceId: string; primaryRevisionId: string; externalPlayerId: string;
  evidence: Record<string, unknown>; metrics: EnrichmentMetrics;
};
export type EnrichmentBatch = {
  fixtureId: string; fixtureRevisionId: string; externalFixtureId: string; observations: EnrichmentObservation[];
};
export type EnrichmentImportResult = ImportResult & { sourceRevisionId: string; activated: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const externalId = /^[1-9][0-9]{0,17}$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mappingVersion = "name-entities-v2";

/** Supplement facts are append-only; current primary revisions remain authoritative. */
export class EnrichmentStore {
  constructor(private readonly pool: Pool, private readonly requestReserve = 5) {
    if (!Number.isInteger(requestReserve) || requestReserve < 0 || requestReserve > 5) {
      throw new Error("Invalid supplementary request reserve");
    }
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  /** Header observations only reduce this day's allowance, including calls made during setup. */
  async observeQuota(remaining: number): Promise<void> {
    if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > 100) throw new Error("Invalid supplementary request allowance");
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lsp:provider-budget:highlightly',0))");
      await client.query(`INSERT INTO sports.enrichment_request_quota(provider,utc_day,remaining)
        VALUES ('highlightly',(clock_timestamp() AT TIME ZONE 'UTC')::date,$1)
        ON CONFLICT(provider) DO UPDATE SET utc_day=EXCLUDED.utc_day,
          remaining=CASE WHEN enrichment_request_quota.utc_day=EXCLUDED.utc_day
            THEN least(enrichment_request_quota.remaining,EXCLUDED.remaining) ELSE EXCLUDED.remaining END`, [remaining]);
    });
  }

  async reserveRequest(action: ProviderAction, resourceKey: string): Promise<void> {
    if (!resourceKey.startsWith("highlightly:") || resourceKey.length > 2048) throw new Error("Invalid supplementary request namespace");
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lsp:provider-budget:highlightly',0))");
      const clock = (await client.query<{ now: Date; day: string; reset: Date }>(`WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS now)
        SELECT now,to_char(now AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
          ((date_trunc('day',now AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC') AS reset FROM instant`)).rows[0];
      const usage = (await client.query<{ count: string; latest: Date | null }>(`SELECT count(*)::text AS count,max(attempted_at) AS latest
        FROM sports.provider_requests WHERE resource_key LIKE 'highlightly:%'
          AND attempted_at >= ($1::date::timestamp AT TIME ZONE 'UTC')`, [clock.day])).rows[0];
      const quota = (await client.query<{ remaining: number }>(`SELECT remaining FROM sports.enrichment_request_quota
        WHERE provider='highlightly' AND utc_day=$1::date`, [clock.day])).rows[0];
      const remaining = Math.min(quota?.remaining ?? 100, 100 - Number(usage.count));
      // Routine collection keeps five spare; an explicit bounded run may use them.
      if (remaining <= this.requestReserve) throw new RateLimitError(clock.reset);
      if (usage.latest && clock.now.getTime() - usage.latest.getTime() < 1000) {
        throw new RateLimitError(new Date(usage.latest.getTime() + 1000));
      }
      await client.query("INSERT INTO sports.provider_requests(action,resource_key,attempted_at) VALUES($1,$2,$3)", [action, resourceKey, clock.now]);
      await client.query(`INSERT INTO sports.enrichment_request_quota(provider,utc_day,remaining) VALUES('highlightly',$1,$2)
        ON CONFLICT(provider) DO UPDATE SET utc_day=EXCLUDED.utc_day,remaining=EXCLUDED.remaining`, [clock.day, remaining - 1]);
    });
  }

  /** Commit a source-only receipt after a complete schedule was archived and validated. */
  async recordSchedule(archive: ArchivedResponse): Promise<EnrichmentImportResult> {
    validateArchive(archive);
    if (archiveId(archive) !== archive.id || archive.params.provider !== "highlightly" || archive.action !== "get_events"
      || archive.params.format !== "highlightly-schedule-v1" || !archive.resourceKey.startsWith("highlightly:")
      || !CURRENT_SOURCE.coverage.some((coverage) => coverage.id === archive.params.league_id)) {
      throw new Error("Invalid supplementary schedule scope");
    }
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lsp:ingestion',0))");
      if (!(await client.query<{ valid: boolean }>("SELECT $1::timestamptz <= clock_timestamp() AS valid", [archive.retrievedAt])).rows[0].valid) {
        throw new Error("Supplementary observation is dated after the database clock");
      }
      const committed = (await client.query<{ source_revision_id: string }>(
        "SELECT source_revision_id FROM sports.ingestion_batches WHERE archive_id=$1", [archive.id])).rows[0];
      if (committed) return { archiveId: archive.id, duplicate: true, fixtures: 0, appearances: 0, issues: 0,
        sourceRevisionId: committed.source_revision_id, activated: 0 };
      const source = (await client.query<{ id: string }>(`INSERT INTO sports.source_revisions
        (provider,action,resource_key,archive_ref,content_sha256,retrieved_at)
        VALUES('highlightly',$1,$2,$3,$4,$5) RETURNING id`,
      [archive.action, archive.resourceKey, archive.id, archive.contentSha256, archive.retrievedAt])).rows[0].id;
      await client.query(`INSERT INTO sports.ingestion_batches(archive_id,source_revision_id,fixture_count,appearance_count,issues_json)
        VALUES($1,$2,0,0,'[]')`, [archive.id, source]);
      return { archiveId: archive.id, duplicate: false, fixtures: 0, appearances: 0, issues: 0,
        sourceRevisionId: source, activated: 0 };
    });
  }

  /** A later complete schedule can withdraw a previously matched source header. */
  async invalidateFixture(archive: ArchivedResponse, fixtureId: string, externalFixtureId: string): Promise<number> {
    validateArchive(archive);
    if (archiveId(archive) !== archive.id || archive.params.provider !== "highlightly" || archive.action !== "get_events"
      || archive.params.format !== "highlightly-schedule-v1" || !archive.resourceKey.startsWith("highlightly:")
      || !CURRENT_SOURCE.coverage.some((coverage) => coverage.id === archive.params.league_id)
      || !uuid.test(fixtureId) || !externalId.test(externalFixtureId) || !Number.isSafeInteger(Number(externalFixtureId))) {
      throw new Error("Invalid supplementary invalidation scope");
    }
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lsp:ingestion',0))");
      const source = (await client.query<{ id: string }>(`SELECT s.id FROM sports.source_revisions s
        JOIN sports.ingestion_batches b ON b.source_revision_id=s.id
        WHERE s.provider='highlightly' AND s.action='get_events' AND s.archive_ref=$1 AND b.archive_id=$1
          AND s.resource_key=$2 AND s.content_sha256=$3 AND s.retrieved_at=$4::timestamptz
          AND s.retrieved_at<=clock_timestamp()`,
      [archive.id, archive.resourceKey, archive.contentSha256, archive.retrievedAt])).rows[0];
      if (!source) throw new Error("Supplementary schedule lacks an accepted source receipt");
      const fixture = (await client.query<{ provider_id: string }>(`SELECT f.provider_id FROM sports.fixtures f
        JOIN sports.competition_seasons cs ON cs.id=f.season_id JOIN sports.competitions c ON c.id=cs.competition_id
        WHERE f.id=$1 AND f.provider='sorare' AND c.provider_id=$2 AND ${sourceSeasonGuard(CURRENT_SOURCE)}`,
      [fixtureId, archive.params.league_id])).rows[0];
      if (!fixture) throw new Error("Supplementary invalidation fixture scope differs");
      const heads = (await client.query<{ appearance_id: string }>(`SELECT h.appearance_id
        FROM sports.appearance_enrichment_heads h JOIN sports.appearance_enrichments e ON e.id=h.enrichment_id
        WHERE e.fixture_id=$1 AND e.external_fixture_id=$2 AND NOT h.conflicted AND e.retrieved_at<$3::timestamptz
        FOR UPDATE OF h`, [fixtureId, externalFixtureId, archive.retrievedAt])).rows;
      for (const head of heads) {
        const content = digest({ fixtureId, externalFixtureId, appearanceId: head.appearance_id,
          scheduleArchiveId: archive.id, reason: "source_header_changed" });
        const parent = (await client.query<{ id: string }>(`SELECT id FROM sports.normalized_revisions
          WHERE entity_type='appearance_enrichment_conflict' AND entity_key=$1 ORDER BY ordinal DESC LIMIT 1`, [head.appearance_id])).rows[0];
        const revision = (await client.query<{ id: string }>(`INSERT INTO sports.normalized_revisions
          (source_revision_id,entity_type,entity_key,content_sha256,parent_id)
          VALUES($1,'appearance_enrichment_conflict',$2,$3,$4) RETURNING id`,
        [source.id, head.appearance_id, content, parent?.id ?? null])).rows[0].id;
        await client.query("UPDATE sports.appearance_enrichment_heads SET conflicted=true,updated_at=clock_timestamp() WHERE appearance_id=$1", [head.appearance_id]);
        await client.query(`INSERT INTO sports.audit_log(normalized_revision_id,actor_type,action,entity_type,entity_key,detail)
          VALUES($1,'worker','enrichment.invalidate','appearance',$2,$3)`, [revision, head.appearance_id,
          JSON.stringify({ provider: "highlightly", reason: "source_header_changed", sourceRevisionId: source.id })]);
      }
      if (heads.length) await client.query(`INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
        VALUES('canonical.changed','fixture',$1,$2,$3) ON CONFLICT(deduplication_key) DO NOTHING`,
      [fixtureId, `enrichment-invalidate:${archive.id}:${fixtureId}:${externalFixtureId}`,
        JSON.stringify({ provider: "sorare", fixtureId: fixture.provider_id })]);
      return heads.length;
    });
  }

  async import(archive: ArchivedResponse, batch: EnrichmentBatch): Promise<EnrichmentImportResult> {
    return this.apply(archive, batch, false);
  }

  /** Apply newly resolved identities to the original capture without re-observing it. */
  async reprocess(archive: ArchivedResponse, batch: EnrichmentBatch): Promise<EnrichmentImportResult> {
    return this.apply(archive, batch, true);
  }

  private async apply(archive: ArchivedResponse, batch: EnrichmentBatch, reprocessing: boolean): Promise<EnrichmentImportResult> {
    validateArchive(archive);
    if (archiveId(archive) !== archive.id || archive.params.provider !== "highlightly" || archive.action !== "get_statistics"
      || !archive.resourceKey.startsWith("highlightly:") || archive.params.match_id !== batch.externalFixtureId
      || !CURRENT_SOURCE.coverage.some((coverage) => coverage.id === archive.params.league_id)
      || !externalId.test(batch.externalFixtureId) || !Number.isSafeInteger(Number(batch.externalFixtureId))
      || !uuid.test(batch.fixtureId) || !uuid.test(batch.fixtureRevisionId) || batch.observations.length > 100) {
      throw new Error("Invalid supplementary archive scope");
    }
    const known = new Set<string>();
    const external = new Set<string>();
    for (const observation of batch.observations) {
      if (!uuid.test(observation.appearanceId) || !uuid.test(observation.primaryRevisionId)
        || !externalId.test(observation.externalPlayerId) || !Number.isSafeInteger(Number(observation.externalPlayerId))
        || known.has(observation.appearanceId) || external.has(observation.externalPlayerId)
        || typeof observation.evidence !== "object" || observation.evidence === null || Array.isArray(observation.evidence)
        || JSON.stringify(observation.evidence).length > 65536) throw new Error("Invalid supplementary identity evidence");
      known.add(observation.appearanceId); external.add(observation.externalPlayerId);
      const metrics = observation.metrics;
      if (Object.keys(metrics).sort().join(",") !== "interceptions,keyPasses,rating,tackles"
        || (metrics.rating !== null && (!Number.isFinite(metrics.rating) || metrics.rating < 0 || metrics.rating > 10
          || Math.round(metrics.rating * 100) / 100 !== metrics.rating))) {
        throw new Error("Invalid supplementary rating");
      }
      for (const value of [metrics.keyPasses, metrics.tackles, metrics.interceptions]) {
        if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)) throw new Error("Invalid supplementary count");
      }
    }
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lsp:ingestion',0))");
      if (!(await client.query<{ valid: boolean }>("SELECT $1::timestamptz <= clock_timestamp() AS valid", [archive.retrievedAt])).rows[0].valid) {
        throw new Error("Supplementary observation is dated after the database clock");
      }
      const committed = (await client.query<{ source_revision_id: string; appearance_count: number }>(
        "SELECT source_revision_id,appearance_count FROM sports.ingestion_batches WHERE archive_id=$1", [archive.id])).rows[0];
      if (committed && !reprocessing) return { archiveId: archive.id, duplicate: true, fixtures: 1, appearances: committed.appearance_count,
        issues: 0, sourceRevisionId: committed.source_revision_id, activated: 0 };
      const original = reprocessing ? (await client.query<{ id: string }>(`SELECT s.id FROM sports.source_revisions s
        JOIN sports.ingestion_batches b ON b.source_revision_id=s.id
        WHERE b.archive_id=$1 AND s.archive_ref=$1 AND s.provider='highlightly' AND s.action=$2
          AND s.resource_key=$3 AND s.content_sha256=$4 AND s.retrieved_at=$5::timestamptz`,
      [archive.id, archive.action, archive.resourceKey, archive.contentSha256, archive.retrievedAt])).rows[0] : undefined;
      if (reprocessing && !original) throw new Error("Supplementary cached mapping lacks its original accepted source receipt");
      const fixture = (await client.query<{ id: string; provider_id: string }>(`SELECT f.id,f.provider_id FROM sports.fixtures f
        JOIN sports.competition_seasons cs ON cs.id=f.season_id JOIN sports.competitions c ON c.id=cs.competition_id
        WHERE f.id=$1 AND f.normalized_revision_id=$2 AND f.provider='sorare' AND f.status='final'
          AND c.provider_id=$3 AND ${sourceSeasonGuard(CURRENT_SOURCE)}`,
      [batch.fixtureId, batch.fixtureRevisionId, archive.params.league_id])).rows[0];
      if (!fixture) throw new Error("Supplementary fixture no longer matches current evidence");
      const primary = (await client.query<{ id: string; normalized_revision_id: string; provider_id: string }>(`SELECT a.id,a.normalized_revision_id,p.provider_id
        FROM sports.appearances a JOIN sports.players p ON p.id=a.player_id
        WHERE a.fixture_id=$1 AND p.provider='sorare' AND a.participation='played' AND a.minutes>0
          AND a.club_id IN (SELECT home_club_id FROM sports.fixtures WHERE id=$1
            UNION ALL SELECT away_club_id FROM sports.fixtures WHERE id=$1)`, [batch.fixtureId])).rows;
      const byId = new Map(primary.map((row) => [row.id, row]));
      for (const observation of batch.observations) {
        if (byId.get(observation.appearanceId)?.normalized_revision_id !== observation.primaryRevisionId) {
          throw new Error("Supplementary appearance no longer matches current evidence");
        }
      }
      const receiptKey = `${archive.id}:${mappingVersion}`;
      if (original && (await client.query(`SELECT id FROM sports.normalized_revisions
        WHERE source_revision_id=$1 AND entity_type='appearance_enrichment_mapping' AND entity_key=$2`,
      [original.id, receiptKey])).rowCount) {
        return { archiveId: archive.id, duplicate: true, fixtures: 1, appearances: 0,
          issues: 0, sourceRevisionId: original.id, activated: 0 };
      }
      const source = original?.id ?? (await client.query<{ id: string }>(`INSERT INTO sports.source_revisions(provider,action,resource_key,archive_ref,content_sha256,retrieved_at)
        VALUES('highlightly',$1,$2,$3,$4,$5) RETURNING id`,
      [archive.action, archive.resourceKey, archive.id, archive.contentSha256, archive.retrievedAt])).rows[0].id;
      const existing = reprocessing ? (await client.query<{ appearance_id: string; external_player_id: string }>(
        "SELECT appearance_id,external_player_id FROM sports.appearance_enrichments WHERE source_revision_id=$1", [source])).rows : [];
      const alreadyObserved = new Set(existing.map((row) => row.appearance_id));
      const existingExternal = new Map(existing.map((row) => [row.external_player_id, row.appearance_id]));
      const observations = batch.observations.filter((row) => !alreadyObserved.has(row.appearanceId));
      if (observations.some((row) => existingExternal.has(row.externalPlayerId)
        && existingExternal.get(row.externalPlayerId) !== row.appearanceId)) {
        throw new Error("Supplementary cached mapping contradicts an accepted player identity");
      }
      // A newer complete capture must reconfirm an old mapping. Absence withdraws
      // a supplement without inventing a primary appearance or a zero statistic.
      const prior = reprocessing ? [] : (await client.query<{ appearance_id: string; external_player_id: string }>(`SELECT e.appearance_id,e.external_player_id
        FROM sports.appearance_enrichment_heads h JOIN sports.appearance_enrichments e ON e.id=h.enrichment_id
        WHERE e.fixture_id=$1`, [batch.fixtureId])).rows;
      for (const row of prior) {
        const appearance = byId.get(row.appearance_id);
        if (appearance && !known.has(row.appearance_id)) observations.push({ appearanceId: row.appearance_id,
          primaryRevisionId: appearance.normalized_revision_id, externalPlayerId: row.external_player_id,
          evidence: { reason: "not_reconfirmed" }, metrics: { rating: null, keyPasses: null, tackles: null, interceptions: null } });
      }
      let activated = 0;
      for (const observation of observations) {
        const content = digest({ ...observation, fixtureRevisionId: batch.fixtureRevisionId, externalFixtureId: batch.externalFixtureId });
        const parent = (await client.query<{ id: string }>(`SELECT id FROM sports.normalized_revisions
          WHERE entity_type='appearance_enrichment' AND entity_key=$1 ORDER BY ordinal DESC LIMIT 1`, [observation.appearanceId])).rows[0];
        const revision = (await client.query<{ id: string }>(`INSERT INTO sports.normalized_revisions
          (source_revision_id,entity_type,entity_key,content_sha256,parent_id) VALUES($1,'appearance_enrichment',$2,$3,$4) RETURNING id`,
        [source, observation.appearanceId, content, parent?.id ?? null])).rows[0].id;
        const row = (await client.query<{ id: string }>(`INSERT INTO sports.appearance_enrichments
          (appearance_id,fixture_id,primary_revision_id,fixture_revision_id,source_revision_id,normalized_revision_id,
            external_fixture_id,external_player_id,retrieved_at,rating,key_passes,tackles,interceptions,evidence_json)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [observation.appearanceId, batch.fixtureId, observation.primaryRevisionId, batch.fixtureRevisionId, source, revision,
          batch.externalFixtureId, observation.externalPlayerId, archive.retrievedAt, observation.metrics.rating,
          observation.metrics.keyPasses, observation.metrics.tackles, observation.metrics.interceptions, JSON.stringify(observation.evidence)])).rows[0];
        const head = (await client.query<{ retrieved_at: Date; content_sha256: string; conflicted: boolean }>(`SELECT e.retrieved_at,n.content_sha256,h.conflicted
          FROM sports.appearance_enrichment_heads h JOIN sports.appearance_enrichments e ON e.id=h.enrichment_id
          JOIN sports.normalized_revisions n ON n.id=e.normalized_revision_id WHERE h.appearance_id=$1`, [observation.appearanceId])).rows[0];
        const time = Date.parse(archive.retrievedAt);
        const invalidation = (await client.query<{ at: Date | null }>(`SELECT max(s.retrieved_at) AS at
          FROM sports.normalized_revisions n JOIN sports.source_revisions s ON s.id=n.source_revision_id
          WHERE n.entity_type='appearance_enrichment_conflict' AND n.entity_key=$1
            AND s.provider='highlightly' AND s.action='get_events'`, [observation.appearanceId])).rows[0].at;
        const newer = (!head || time > head.retrieved_at.getTime()) && (!invalidation || time > invalidation.getTime());
        const conflict = head && time === head.retrieved_at.getTime() && content !== head.content_sha256;
        if (newer || conflict) {
          if (conflict) await client.query(`UPDATE sports.appearance_enrichment_heads SET conflicted=true,updated_at=clock_timestamp()
            WHERE appearance_id=$1`, [observation.appearanceId]);
          else await client.query(`INSERT INTO sports.appearance_enrichment_heads(appearance_id,enrichment_id)
            VALUES($1,$2) ON CONFLICT(appearance_id) DO UPDATE SET enrichment_id=EXCLUDED.enrichment_id,
              conflicted=false,updated_at=clock_timestamp()`, [observation.appearanceId, row.id]);
          activated++;
        }
        await client.query(`INSERT INTO sports.audit_log(normalized_revision_id,actor_type,action,entity_type,entity_key,detail)
          VALUES($1,'worker','enrich','appearance',$2,$3)`, [revision, observation.appearanceId, JSON.stringify({ provider: "highlightly", contentSha256: content })]);
      }
      if (activated) await client.query(`INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
        VALUES('canonical.changed','fixture',$1,$2,$3) ON CONFLICT(deduplication_key) DO NOTHING`,
      [batch.fixtureId, reprocessing ? `enrichment-reprocess:${receiptKey}` : `enrichment:${archive.id}`,
        JSON.stringify({ provider: "sorare", fixtureId: fixture.provider_id })]);
      if (reprocessing) {
        const detail = { version: mappingVersion, archiveId: archive.id, fixtureId: batch.fixtureId,
          fixtureRevisionId: batch.fixtureRevisionId, observedAt: archive.retrievedAt,
          appearances: observations.length, activated };
        const receipt = (await client.query<{ id: string }>(`INSERT INTO sports.normalized_revisions
          (source_revision_id,entity_type,entity_key,content_sha256)
          VALUES($1,'appearance_enrichment_mapping',$2,$3) RETURNING id`, [source, receiptKey, digest(detail)])).rows[0];
        await client.query(`INSERT INTO sports.audit_log(normalized_revision_id,actor_type,action,entity_type,entity_key,detail)
          VALUES($1,'worker','enrichment.reprocess','fixture',$2,$3)`, [receipt.id, batch.fixtureId, JSON.stringify(detail)]);
      } else await client.query(`INSERT INTO sports.ingestion_batches(archive_id,source_revision_id,fixture_count,appearance_count,issues_json)
        VALUES($1,$2,1,$3,'[]')`, [archive.id, source, observations.length]);
      return { archiveId: archive.id, duplicate: false, fixtures: 1, appearances: observations.length, issues: 0, sourceRevisionId: source, activated };
    });
  }
}
