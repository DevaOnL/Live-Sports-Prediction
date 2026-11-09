import type { Pool, PoolClient } from "pg";
import { canonicalJson, evaluateForecast, inputHash } from "./engine";
import { prepareInputs } from "./inputs";
import type { ForecastInput, ForecastResult, PreparedInput, RefreshResult } from "./types";

export type SavedForecast = {
  id: string; ordinal: string; playerId: string; parentId: string | null; modelVersion: string;
  inputHash: string; sourceOrdinal: string; cutoffAt: string; createdAt: string;
  input: ForecastInput; provenance: Record<string, unknown>; result: ForecastResult;
};

/** The ingestion lock freezes canonical evidence for the entire comparison batch. */
export class ForecastStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lsp:ingestion',0))");
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code !== "40P01" || attempt >= 2) throw error;
      } finally { client.release(); }
    }
  }

  private async persist(client: PoolClient, prepared: PreparedInput): Promise<{ created: boolean; result: ForecastResult }> {
    const input = prepared.input;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`lsp:forecast:${input.player.id}`]);
    const player = await client.query<{ id: string }>("SELECT id FROM sports.players WHERE provider='apifootball' AND provider_id=$1", [input.player.id]);
    const playerId = player.rows[0].id;
    const previous = await client.query<{ id: string; input_hash: string; result_json: ForecastResult }>(
      `SELECT r.id,r.input_hash,r.result_json FROM sports.forecast_heads h
       JOIN sports.forecast_revisions r ON r.id=h.revision_id WHERE h.player_id=$1`, [playerId]);
    const result = evaluateForecast(input);
    const hash = inputHash(input, result);
    // Compare only with the current head. A -> B -> A is a third observation.
    if (previous.rows[0]?.input_hash === hash) return { created: false, result: previous.rows[0].result_json };
    const revision = await client.query<{ id: string }>(
      `INSERT INTO sports.forecast_revisions(player_id,parent_id,model_version,input_hash,source_ordinal,cutoff_at,input_json,provenance_json,result_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [playerId, previous.rows[0]?.id ?? null, result.modelVersion, hash, prepared.sourceOrdinal, input.cutoffAt,
        canonicalJson(input), canonicalJson(prepared.provenance), canonicalJson(result)]);
    await client.query(
      `INSERT INTO sports.forecast_heads(player_id,revision_id) VALUES ($1,$2)
       ON CONFLICT (player_id) DO UPDATE SET revision_id=EXCLUDED.revision_id,updated_at=now()`, [playerId, revision.rows[0].id]);
    // Forecasts explain canonical observations; they must not feed canonical.changed.
    await client.query(
      `INSERT INTO sports.audit_log(actor_type,action,entity_type,entity_key,detail)
       VALUES ('worker','forecast.refresh','forecast',$1,$2)`,
      [input.player.id, canonicalJson({ forecastRevisionId: revision.rows[0].id, parentId: previous.rows[0]?.id ?? null, inputHash: hash, sourceOrdinal: prepared.sourceOrdinal })]);
    return { created: true, result };
  }

  private async refreshBatch(ids: readonly string[] | undefined, cutoffAt = new Date().toISOString()): Promise<RefreshResult> {
    if (!Number.isFinite(Date.parse(cutoffAt))) throw new RangeError("Invalid forecast cutoff");
    return this.transaction(async (client) => {
      const inputs = await prepareInputs(client, cutoffAt, ids);
      const summary: RefreshResult = { players: inputs.size, created: 0, unchanged: 0, available: 0, partial: 0, unavailable: 0 };
      for (const prepared of inputs.values()) {
        const saved = await this.persist(client, prepared);
        summary[saved.created ? "created" : "unchanged"]++;
        summary[saved.result.status]++;
      }
      return summary;
    });
  }

  async refreshAll(cutoffAt?: string): Promise<RefreshResult> { return this.refreshBatch(undefined, cutoffAt); }
  async refresh(providerPlayerId: string, cutoffAt?: string): Promise<RefreshResult> { return this.refreshBatch([providerPlayerId], cutoffAt); }
  async refreshMany(ids: readonly string[], cutoffAt?: string): Promise<RefreshResult> { return this.refreshBatch(ids, cutoffAt); }

  async show(providerPlayerId: string): Promise<SavedForecast | null> {
    const rows = await this.pool.query<{
      id: string; ordinal: string; provider_id: string; parent_id: string | null; model_version: string;
      input_hash: string; source_ordinal: string; cutoff_at: Date; created_at: Date;
      input_json: ForecastInput; provenance_json: Record<string, unknown>; result_json: ForecastResult;
    }>(`SELECT r.*,p.provider_id FROM sports.forecast_heads h JOIN sports.forecast_revisions r ON r.id=h.revision_id
        JOIN sports.players p ON p.id=h.player_id WHERE p.provider='apifootball' AND p.provider_id=$1`, [providerPlayerId]);
    const row = rows.rows[0];
    return row ? {
      id: row.id, ordinal: row.ordinal, playerId: row.provider_id, parentId: row.parent_id,
      modelVersion: row.model_version, inputHash: row.input_hash, sourceOrdinal: row.source_ordinal,
      cutoffAt: row.cutoff_at.toISOString(), createdAt: row.created_at.toISOString(),
      input: row.input_json, provenance: row.provenance_json, result: row.result_json,
    } : null;
  }

  async status(): Promise<Record<string, number>> {
    const counts = await this.pool.query<{ revisions: number; players: number; available: number; partial: number; unavailable: number }>(
      `SELECT (SELECT count(*)::integer FROM sports.forecast_revisions) AS revisions,count(*)::integer AS players,
       count(*) FILTER (WHERE r.result_json->>'status'='available')::integer AS available,
       count(*) FILTER (WHERE r.result_json->>'status'='partial')::integer AS partial,
       count(*) FILTER (WHERE r.result_json->>'status'='unavailable')::integer AS unavailable
       FROM sports.forecast_heads h JOIN sports.forecast_revisions r ON r.id=h.revision_id`);
    return counts.rows[0];
  }
}
