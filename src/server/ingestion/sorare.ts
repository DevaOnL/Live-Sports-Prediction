import type { Pool } from "pg";
import type { Db } from "mongodb";
import { ArchiveStore } from "./archive";
import { CURRENT_SOURCE } from "./sources";
import { SorareCaptureError, SorareClient } from "./sorare-client";
import { normalizeSorareCapture } from "./sorare-normalize";
import { IngestionStore } from "./store";
import type { ArchivedResponse, ImportResult, ProviderAction } from "./types";

export { SorareClient, SorareCaptureError, SORARE_FORMAT, SORARE_QUERIES } from "./sorare-client";
export { normalizeSorareCapture } from "./sorare-normalize";

/** Archives are shared; canonical identities and recovery remain source-specific. */
export class SorarePipeline {
  readonly archives: ArchiveStore;
  readonly store: IngestionStore;
  readonly provider: SorareClient;
  constructor(private readonly pool: Pool, db: Db, apiKey: string) {
    this.archives = new ArchiveStore(db);
    this.store = new IngestionStore(pool, CURRENT_SOURCE);
    this.provider = new SorareClient(this.store, apiKey);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended('lsp:source-run',0))");
      return await operation();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended('lsp:source-run',0))").catch(() => undefined);
      client.release();
    }
  }

  private async apply(archive: ArchivedResponse): Promise<ImportResult | null> {
    if (archive.params.provider !== "sorare") throw new Error("Archive source mismatch");
    const coverage = CURRENT_SOURCE.coverage.find((item) => item.id === archive.params.league_id);
    if (!coverage) {
      await this.archives.mark(archive.id, "invalid", [{ code: "invalid_archive_scope", resource: archive.action }]);
      return null;
    }
    // A transient SQL context failure must remain retryable, never quarantine raw evidence.
    const context = archive.action === "get_statistics" ? await this.store.fixture(archive.params.match_id) : undefined;
    let batch;
    try { batch = normalizeSorareCapture(archive, coverage, context ?? undefined); }
    catch {
      await this.archives.mark(archive.id, "invalid", [{ code: "invalid_archive_scope", resource: archive.action }]);
      return null;
    }
    if (archive.action === "get_events" && (batch.fixtures.length !== coverage.expectedClubs * (coverage.expectedClubs - 1)
      || batch.issues.some((issue) => issue.code === "incomplete_schedule"))) {
      // A missing fixture could make an apparently exact last-five window skip
      // a real appearance. Keep the prior complete schedule until every ordered
      // season pairing has been captured; raw rejected evidence stays immutable.
      const issues = batch.issues.some((issue) => issue.code === "incomplete_schedule") ? batch.issues
        : [...batch.issues, { code: "incomplete_schedule", resource: coverage.id }];
      await this.archives.mark(archive.id, "invalid", issues);
      return null;
    }
    if (!batch.clubs.length && !batch.players.length && !batch.fixtures.length && !batch.standings.length) {
      await this.archives.mark(archive.id, "invalid", batch.issues.length ? batch.issues : [{ code: "empty_payload", resource: archive.action }]);
      return null;
    }
    try {
      const result = await this.store.import(archive, batch);
      await this.archives.mark(archive.id, "imported", batch.issues, result);
      return result;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (typeof code === "string" && /^(22|23)[A-Z0-9]{3}$/.test(code)) {
        await this.archives.mark(archive.id, "invalid", [...batch.issues, { code: "relational_validation_failed", resource: archive.action }]);
        return null;
      }
      await this.archives.mark(archive.id, "failed", [{ code: "sql_or_marker_unavailable", resource: archive.action }]).catch(() => undefined);
      throw new Error("Import persistence unavailable");
    }
  }

  private async recover(): Promise<number> {
    let count = 0;
    for (const archive of await this.archives.pending(1000, "sorare")) { await this.apply(archive); count++; }
    return count;
  }

  async reconcile(): Promise<number> {
    return this.exclusive(async () => {
      const recovered = await this.recover();
      for (const archive of await this.archives.latestRosters(CURRENT_SOURCE)) {
        const coverage = CURRENT_SOURCE.coverage.find((item) => item.id === archive.params.league_id)!;
        const batch = normalizeSorareCapture(archive, coverage);
        if (batch.roster && batch.clubs.length) await this.store.replayRoster(archive, batch);
      }
      return recovered;
    });
  }

  private async request(action: ProviderAction, params: Record<string, string>): Promise<ImportResult | null> {
    try { return this.apply(await this.archives.save(await this.provider.request(action, params))); }
    catch (error) {
      if (error instanceof SorareCaptureError) {
        const archive = await this.archives.save(error.capture);
        await this.archives.mark(archive.id, "invalid", [{ code: "incomplete_capture", resource: action }]);
        throw error.cause;
      }
      throw error;
    }
  }

  async statistics(leagueId: string, nativeGameId: string): Promise<void> {
    await this.exclusive(async () => {
      await this.recover();
      const coverage = CURRENT_SOURCE.coverage.find((item) => item.id === leagueId);
      const fixture = await this.store.fixture(nativeGameId);
      if (!coverage || !fixture || fixture.leagueId !== coverage.id || fixture.season !== coverage.season) throw new Error("Fixture is outside approved coverage");
      if (fixture.status !== "final" && fixture.status !== "live") return;
      await this.request("get_statistics", { league_id: leagueId, match_id: nativeGameId });
    });
  }

  async sync(): Promise<Array<{ leagueId: string; imports: Array<ImportResult | null> }>> {
    return this.exclusive(async () => {
      await this.recover();
      const results = [];
      for (const coverage of CURRENT_SOURCE.coverage) {
        const imports = [];
        imports.push(await this.request("get_teams", { league_id: coverage.id }));
        imports.push(await this.request("get_events", { league_id: coverage.id }));
        imports.push(await this.request("get_standings", { league_id: coverage.id }));
        results.push({ leagueId: coverage.id, imports });
      }
      return results;
    });
  }
}
