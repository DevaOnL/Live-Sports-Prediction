import type { Db } from "mongodb";
import type { Pool } from "pg";
import { ArchiveStore, archiveId, validateArchive } from "./archive";
import { EnrichmentStore } from "./enrichment-store";
import { HighlightlyClient, HighlightlyScheduleError, highlightlyResponse, object, type HighlightlyBox } from "./highlightly-client";
import { normalizeHighlightly, primaryFingerprint, sameFixture, scheduleFixtures, type EnrichmentAppearance, type EnrichmentFixture } from "./highlightly-normalize";
import { CURRENT_SOURCE, sourceSeasonGuard } from "./sources";
import type { ArchivedResponse } from "./types";

type StoredArchive = Omit<ArchivedResponse, "id"> & { _id: string };
export type EnrichmentProgress = { fixtures: number; appearances: number; pending: number; unmapped: number };
export type EnrichmentReprocessProgress = { captures: number; appearances: number; skipped: number; duplicates: number };

/** Optional worker-only supplementation. The primary source always runs independently. */
export class EnrichmentPipeline {
  readonly store: EnrichmentStore;
  readonly archives: ArchiveStore;
  readonly provider: HighlightlyClient;
  constructor(private readonly pool: Pool, private readonly db: Db, key: string, options: { requestReserve?: number } = {}) {
    this.store = new EnrichmentStore(pool, options.requestReserve ?? 5);
    this.archives = new ArchiveStore(db);
    this.provider = new HighlightlyClient(this.store, key);
  }

  private async fixtures(): Promise<EnrichmentFixture[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const fixtures = (await client.query<{
        id: string; native_id: string; revision_id: string; league_id: string; kickoff_at: Date;
        home_id: string; home_name: string; away_id: string; away_name: string; home_score: number; away_score: number;
      }>(`SELECT f.id,f.provider_id AS native_id,f.normalized_revision_id AS revision_id,c.provider_id AS league_id,
        f.kickoff_at,h.id AS home_id,h.name AS home_name,a.id AS away_id,a.name AS away_name,f.home_score,f.away_score
        FROM sports.fixtures f JOIN sports.competition_seasons cs ON cs.id=f.season_id
        JOIN sports.competitions c ON c.id=cs.competition_id JOIN sports.clubs h ON h.id=f.home_club_id
        JOIN sports.clubs a ON a.id=f.away_club_id WHERE f.provider='sorare' AND f.status='final'
        AND f.kickoff_at IS NOT NULL AND f.home_score IS NOT NULL AND f.away_score IS NOT NULL
        AND ${sourceSeasonGuard(CURRENT_SOURCE)} ORDER BY f.kickoff_at DESC,f.provider_id`)).rows;
      const appearances = (await client.query<{
        id: string; fixture_id: string; primary_revision_id: string; player_id: string; name: string; club_id: string;
        participation: string; minutes: number | null; goals: number | null; assists: number | null; shots_on_target: number | null;
      }>(`SELECT a.id,a.fixture_id,a.normalized_revision_id AS primary_revision_id,a.player_id,p.name,a.club_id,
        a.participation,a.minutes,a.goals,a.assists,a.shots_on_target
        FROM sports.appearances a JOIN sports.players p ON p.id=a.player_id WHERE a.fixture_id=ANY($1::uuid[])
        ORDER BY a.id`, [fixtures.map((f) => f.id)])).rows;
      const byFixture = new Map<string, EnrichmentAppearance[]>();
      for (const a of appearances) {
        const rows = byFixture.get(a.fixture_id) ?? [];
        rows.push({ id: a.id, primaryRevisionId: a.primary_revision_id, playerId: a.player_id, name: a.name,
          clubId: a.club_id, participation: a.participation, minutes: a.minutes, goals: a.goals, assists: a.assists, shotsOnTarget: a.shots_on_target });
        byFixture.set(a.fixture_id, rows);
      }
      await client.query("COMMIT");
      return fixtures.map((f) => ({ id: f.id, nativeId: f.native_id, revisionId: f.revision_id, leagueId: f.league_id,
        kickoffAt: f.kickoff_at.toISOString(), home: { id: f.home_id, name: f.home_name }, away: { id: f.away_id, name: f.away_name },
        homeScore: f.home_score, awayScore: f.away_score, appearances: byFixture.get(f.id) ?? [] }));
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  private async latest(action: "get_events" | "get_statistics", validate = true): Promise<ArchivedResponse[]> {
    const documents = await this.db.collection<StoredArchive>("raw_archives").aggregate<StoredArchive>([
      { $match: { "params.provider": "highlightly", action } },
      { $lookup: { from: "import_metadata", localField: "_id", foreignField: "_id", as: "metadata" } },
      { $match: { "metadata.state": "imported" } },
      { $unset: "metadata" },
      { $sort: { retrievedAt: -1, _id: -1 } },
      { $group: { _id: "$resourceKey", value: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$value" } },
    ]).toArray();
    return documents.map(({ _id, ...value }) => {
      if (validate) {
        validateArchive(value);
        if (archiveId(value) !== _id) throw new Error("Supplementary archive identity mismatch");
      }
      return { ...value, id: _id };
    });
  }

  private async apply(archive: ArchivedResponse, fixtures: EnrichmentFixture[]): Promise<number> {
    const coverage = CURRENT_SOURCE.coverage.find((c) => c.id === archive.params.league_id);
    if (!coverage) throw new Error("Unsupported supplementary coverage");
    if (archive.action === "get_events") {
      scheduleFixtures(archive, coverage);
      const result = await this.store.recordSchedule(archive);
      await this.archives.mark(archive.id, "imported", [], result);
      return 0;
    }
    const bundle: HighlightlyBox = JSON.parse(archive.text);
    const matches = fixtures.filter((f) => f.leagueId === coverage.id && object(bundle.fixture) && sameFixture(bundle.fixture, f));
    if (matches.length !== 1) throw new Error("Supplementary fixture identity unresolved");
    const batch = normalizeHighlightly(archive, matches[0]);
    const result = await this.store.import(archive, batch);
    await this.archives.mark(archive.id, "imported", [], result);
    return result.appearances;
  }

  private async recover(fixtures: EnrichmentFixture[]): Promise<void> {
    for (const archive of await this.archives.pending(1000, "highlightly")) {
      try { await this.apply(archive, fixtures); }
      catch (error) {
        // Validation failures must not be mistaken for a recoverable SQL outage.
        if (error instanceof Error && /scope|identity|evidence|supplementary|Supplementary|supplement|Supplement|Incomplete|Invalid|Unsupported/.test(error.message)) {
          await this.archives.mark(archive.id, "invalid", [{ code: "supplement_evidence_unresolved", resource: archive.params.match_id ?? archive.params.league_id }]);
        } else throw error;
      }
    }
  }

  private async reconcileSchedules(fixtures: EnrichmentFixture[], schedules: Map<string, ArchivedResponse>, cache: Map<string, ArchivedResponse>): Promise<void> {
    for (const coverage of CURRENT_SOURCE.coverage) {
      const schedule = schedules.get(coverage.id);
      if (!schedule) continue;
      const headers = scheduleFixtures(schedule, coverage);
      for (const fixture of fixtures.filter((candidate) => candidate.leagueId === coverage.id)) {
        const matches = headers.filter((row) => sameFixture(row, fixture));
        for (const [key, previous] of cache) {
          if (previous.params.league_id !== fixture.leagueId || Date.parse(schedule.retrievedAt) <= Date.parse(previous.retrievedAt)) continue;
          let old: HighlightlyBox;
          try { old = JSON.parse(previous.text); }
          catch { continue; } // Cached reprocessing counts malformed historical boxes separately.
          const knownHeader = headers.find((row) => String(row.id) === previous.params.match_id);
          const changed = matches.length > 1 || (matches.length === 1 && String(matches[0].id) !== previous.params.match_id)
            || (knownHeader !== undefined && !sameFixture(knownHeader, fixture));
          if (object(old) && object(old.fixture) && sameFixture(old.fixture, fixture) && changed) {
            await this.store.invalidateFixture(schedule, fixture.id, previous.params.match_id);
            await this.archives.mark(previous.id, "invalid", [{ code: "supplement_source_header_changed", resource: previous.params.match_id }]);
            cache.delete(key);
          }
        }
      }
    }
  }

  /** Re-evaluate accepted cached boxes without discovery, HTTP or new observation times. */
  async reprocessCached(): Promise<EnrichmentReprocessProgress> {
    const progress: EnrichmentReprocessProgress = { captures: 0, appearances: 0, skipped: 0, duplicates: 0 };
    const lock = await this.pool.connect();
    let locked = false;
    try {
      locked = (await lock.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('lsp:highlightly-run',0)) AS locked")).rows[0].locked;
      if (!locked) return progress;
      const fixtures = await this.fixtures();
      const cache = new Map((await this.latest("get_statistics", false)).map((a) => [`${a.params.league_id}:${a.params.match_id}`, a]));
      await this.reconcileSchedules(fixtures, new Map((await this.latest("get_events")).map((a) => [a.params.league_id, a])), cache);
      for (const archive of cache.values()) {
        progress.captures++;
        let batch: ReturnType<typeof normalizeHighlightly>;
        try {
          validateArchive(archive);
          if (archiveId(archive) !== archive.id) throw new Error("Supplementary archive identity mismatch");
          const bundle: unknown = JSON.parse(archive.text);
          if (!object(bundle) || !object(bundle.fixture)) throw new Error("Invalid supplementary box");
          const header = bundle.fixture;
          const matches = fixtures.filter((fixture) => fixture.leagueId === archive.params.league_id
            && sameFixture(header, fixture));
          if (matches.length !== 1 || bundle.primaryFingerprint !== primaryFingerprint(matches[0])) {
            progress.skipped++;
            continue;
          }
          batch = normalizeHighlightly(archive, matches[0]);
        } catch {
          progress.skipped++;
          continue;
        }
        const result = await this.store.reprocess(archive, batch);
        progress.appearances += result.appearances;
        if (result.duplicate) progress.duplicates++;
      }
      return progress;
    } finally {
      if (locked) await lock.query("SELECT pg_advisory_unlock(hashtextextended('lsp:highlightly-run',0))").catch(() => undefined);
      lock.release();
    }
  }

  /** Caches complete schedules for a UTC day; completed box scores for seven days. */
  async run(limit = 2): Promise<EnrichmentProgress> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid supplementary batch size");
    const lock = await this.pool.connect();
    let locked = false;
    try {
      locked = (await lock.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('lsp:highlightly-run',0)) AS locked")).rows[0].locked;
      if (!locked) return { fixtures: 0, appearances: 0, pending: 0, unmapped: 0 };
      const fixtures = await this.fixtures();
      await this.recover(fixtures);
      const schedules = new Map((await this.latest("get_events")).map((a) => [a.params.league_id, a]));
      const cache = new Map((await this.latest("get_statistics")).map((a) => [`${a.params.league_id}:${a.params.match_id}`, a]));
      // Finish accepted corrections before any unrelated provider request can fail.
      await this.reconcileSchedules(fixtures, schedules, cache);
      const today = new Date().toISOString().slice(0, 10);
      for (const coverage of CURRENT_SOURCE.coverage) {
        const current = schedules.get(coverage.id);
        if (!current || current.retrievedAt.slice(0, 10) !== today) {
          try {
            const archive = await this.archives.save(await this.provider.schedule(coverage));
            await this.apply(archive, fixtures); schedules.set(coverage.id, archive);
            await this.reconcileSchedules(fixtures, new Map([[coverage.id, archive]]), cache);
          } catch (error) {
            if (error instanceof HighlightlyScheduleError) {
              const partial = await this.archives.save(error.response);
              await this.archives.mark(partial.id, "invalid", [{ code: "incomplete_supplement_schedule", resource: coverage.id }]);
              throw error.cause;
            }
            throw error;
          }
        }
      }
      const headers = new Map<string, { row: Record<string, unknown>; schedule: ArchivedResponse }[]>();
      for (const coverage of CURRENT_SOURCE.coverage) {
        const schedule = schedules.get(coverage.id)!;
        headers.set(coverage.id, scheduleFixtures(schedule, coverage).map((row) => ({ row, schedule })));
      }
      const pending: { fixture: EnrichmentFixture; row: Record<string, unknown>; schedule: ArchivedResponse }[] = [];
      const completed = new Set<string>();
      let unmapped = 0;
      for (const fixture of fixtures) {
        const matches = (headers.get(fixture.leagueId) ?? []).filter((h) => sameFixture(h.row, fixture));
        const schedule = schedules.get(fixture.leagueId)!;
        if (matches.length !== 1) { unmapped++; continue; }
        const { row } = matches[0];
        const prior = cache.get(`${fixture.leagueId}:${row.id}`);
        let valid = false;
        if (prior) {
          try {
            const box: HighlightlyBox = JSON.parse(prior.text);
            valid = box.primaryFingerprint === primaryFingerprint(fixture) && Date.now() - Date.parse(prior.retrievedAt) < 7 * 86_400_000;
          } catch { /* Invalid caches never establish data availability. */ }
        }
        if (valid) completed.add(fixture.id); else pending.push({ fixture, row, schedule });
      }
      const progress: EnrichmentProgress = { fixtures: 0, appearances: 0, pending: pending.length, unmapped };
      // Priority affects fetching only. Forecast eligibility still uses the full
      // exact-five validation, including uncertainty, in the forecast engine.
      const windows = new Map<string, string[]>();
      for (const f of fixtures) for (const a of f.appearances) if (a.participation === "played" && a.minutes !== null && a.minutes >= 60) {
        const window = windows.get(a.playerId) ?? [];
        if (window.length < 5) window.push(f.id);
        windows.set(a.playerId, window);
      }
      const leagueDone = new Map<string, number>();
      for (let index = 0; index < limit && pending.length; index++) {
        const scores = new Map<string, number>();
        for (const window of windows.values()) if (window.length === 5) {
          const remaining = window.filter((f) => !completed.has(f));
          for (const f of remaining) scores.set(f, (scores.get(f) ?? 0) + 1 / (remaining.length * remaining.length));
        }
        pending.sort((a, b) => (scores.get(b.fixture.id) ?? 0) / (1 + (leagueDone.get(b.fixture.leagueId) ?? 0) / 5)
          - (scores.get(a.fixture.id) ?? 0) / (1 + (leagueDone.get(a.fixture.leagueId) ?? 0) / 5)
          || b.fixture.kickoffAt.localeCompare(a.fixture.kickoffAt) || a.fixture.nativeId.localeCompare(b.fixture.nativeId));
        const target = pending.shift()!;
        const capture = await this.provider.get("get_statistics", `/box-score/${target.row.id}`);
        const archive = await this.archives.save(highlightlyResponse("get_statistics", target.fixture.leagueId, {
          format: "highlightly-box-v1", fixture: target.row, scheduleArchiveId: target.schedule.id,
          primaryFingerprint: primaryFingerprint(target.fixture), capture,
        }));
        progress.appearances += await this.apply(archive, fixtures);
        progress.fixtures++; progress.pending--;
        completed.add(target.fixture.id);
        leagueDone.set(target.fixture.leagueId, (leagueDone.get(target.fixture.leagueId) ?? 0) + 1);
      }
      return progress;
    } finally {
      if (locked) await lock.query("SELECT pg_advisory_unlock(hashtextextended('lsp:highlightly-run',0))").catch(() => undefined);
      lock.release();
    }
  }
}
