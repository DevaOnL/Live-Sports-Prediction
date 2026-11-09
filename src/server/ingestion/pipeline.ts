import type { Pool } from "pg";
import type { Db } from "mongodb";
import { ArchiveStore } from "./archive";
import { COVERAGE, coverageFor } from "./coverage";
import { normalizeResponse } from "./normalize";
import { ProviderClient } from "./provider";
import { IngestionStore } from "./store";
import type { ArchivedResponse, ImportResult, ProviderAction } from "./types";

export class IngestionPipeline {
  readonly archives: ArchiveStore;
  readonly store: IngestionStore;
  readonly provider: ProviderClient;
  constructor(private readonly pool: Pool, db: Db, apiKey: string) {
    this.archives = new ArchiveStore(db);
    this.store = new IngestionStore(pool);
    this.provider = new ProviderClient(this.store, apiKey);
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
    const coverage = coverageFor(archive.params.league_id);
    const context = archive.action === "get_statistics" ? await this.store.fixture(archive.params.match_id) : undefined;
    const batch = normalizeResponse(archive, coverage, context ?? undefined);
    const empty = !batch.clubs.length && !batch.players.length && !batch.fixtures.length && !batch.standings.length;
    if (empty) {
      await this.archives.mark(archive.id, "invalid", batch.issues.length ? batch.issues : [{ code: "empty_payload", resource: archive.action }]);
      return null;
    }
    try {
      const result = await this.store.import(archive, batch);
      // A failure here is recovered through the SQL commit marker on the next replay.
      await this.archives.mark(archive.id, "imported", batch.issues, result);
      return result;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (typeof code === "string" && /^(22|23)[A-Z0-9]{3}$/.test(code)) {
        // A rejected football observation must not block newer correcting data.
        // SQL has rolled back; keep its immutable archive and quarantine metadata.
        await this.archives.mark(archive.id, "invalid", [...batch.issues, { code: "relational_validation_failed", resource: archive.action }]);
        return null;
      }
      await this.archives.mark(archive.id, "failed", [{ code: "sql_or_marker_unavailable", resource: archive.action }]).catch(() => undefined);
      throw new Error("Import persistence unavailable");
    }
  }

  private async recover(): Promise<number> {
    let count = 0;
    for (const archive of await this.archives.pending(1000)) { await this.apply(archive); count++; }
    return count;
  }

  async reconcile(): Promise<number> { return this.exclusive(() => this.recover()); }

  private async request(action: ProviderAction, params: Record<string, string>): Promise<ImportResult | null> {
    const response = await this.provider.request(action, params);
    return this.apply(await this.archives.save(response));
  }

  async statistics(leagueId: string, fixtureId: string): Promise<void> {
    await this.exclusive(async () => {
      await this.recover();
      const fixture = await this.store.fixture(fixtureId);
      if (!fixture || fixture.leagueId !== coverageFor(leagueId).id) throw new Error("Fixture is outside approved coverage");
      if (fixture.status !== "final" && fixture.status !== "live") return;
      await this.request("get_statistics", { league_id: leagueId, match_id: fixtureId });
    });
  }

  async sync(): Promise<Array<{ leagueId: string; imports: Array<ImportResult | null> }>> {
    return this.exclusive(async () => {
      await this.recover();
      const result = [];
      for (const coverage of COVERAGE) {
        const imports = [];
        imports.push(await this.request("get_teams", { league_id: coverage.id }));
        imports.push(await this.request("get_events", { league_id: coverage.id, from: coverage.startsOn, to: coverage.endsOn, timezone: "UTC" }));
        imports.push(await this.request("get_standings", { league_id: coverage.id }));
        result.push({ leagueId: coverage.id, imports });
      }
      return result;
    });
  }
}
