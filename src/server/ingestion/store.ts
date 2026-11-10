import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { archiveId, validateArchive } from "./archive";
import { LEGACY_SOURCE, sourceCoverage, sourceEntityKey, type SourceProfile } from "./sources";
import { cutoffUtc, localDate, POINTS_ADJUSTMENTS, reconstructStandings } from "./standings";
import type { Appearance, ArchivedResponse, Batch, Club, Coverage, Fixture, ImportResult, Issue, Player, ProviderAction } from "./types";

const IMPORT_LOCK = "lsp:ingestion";
type Data = Record<string, unknown>;
type Revision = { id: string; changed: boolean };

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function header(fixture: Fixture): Data {
  return {
    leagueId: fixture.leagueId, season: fixture.season, home: fixture.home.id,
    away: fixture.away.id, kickoffAt: fixture.kickoffAt, status: fixture.status,
    homeScore: fixture.homeScore, awayScore: fixture.awayScore,
  };
}

function assertCoverage(coverage: Coverage, profile: SourceProfile): void {
  const approved = sourceCoverage(profile, coverage.id);
  if (Object.entries(approved).some(([key, value]) => coverage[key as keyof Coverage] !== value)) {
    throw new Error("Import coverage differs from the approved allowlist");
  }
}

export class RateLimitError extends Error {
  constructor(readonly retryAt: Date) {
    super("Shared provider request budget exhausted");
    this.name = "RateLimitError";
  }
}

/** SQL owns the commit marker; MongoDB import state is updated only after this returns. */
export class IngestionStore {
  constructor(private readonly pool: Pool, readonly profile: SourceProfile = LEGACY_SOURCE) {
    if (!["apifootball", "sorare"].includes(profile.provider)) throw new Error("Unsupported source");
  }

  private key(type: string, ...parts: string[]): string { return sourceEntityKey(this.profile, type, ...parts); }

  /** Source names are fixed internal constants, never provider/request input. */
  private providerSql(alias = ""): string {
    return `${alias ? `${alias}.` : ""}provider=${this.profile.provider === "sorare" ? "'sorare'" : "'apifootball'"}`;
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code !== "40P01" || attempt >= 2) throw error;
      } finally {
        client.release();
      }
    }
  }

  async reserveRequest(action: ProviderAction, resourceKey: string, now = new Date()): Promise<void> {
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid request time");
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lsp:provider-budget', 0))");
      if (this.profile.provider === "sorare") {
        if (!resourceKey.startsWith("sorare:")) throw new Error("Missing source request namespace");
        const budget = await client.query<{ count: string; oldest: Date | null; latest: Date | null }>(
          `SELECT count(*)::text AS count,min(attempted_at) AS oldest,max(attempted_at) AS latest
           FROM sports.provider_requests WHERE resource_key LIKE 'sorare:%'
             AND attempted_at > $1::timestamptz - interval '1 minute'`, [now],
        );
        const row = budget.rows[0];
        if (Number(row.count) >= 60) throw new RateLimitError(new Date(row.oldest!.getTime() + 60_000));
        if (row.latest && now.getTime() - row.latest.getTime() < 1000) {
          throw new RateLimitError(new Date(row.latest.getTime() + 1000));
        }
        await client.query("INSERT INTO sports.provider_requests(action,resource_key,attempted_at) VALUES ($1,$2,$3)", [action, resourceKey, now]);
        return;
      }
      const budget = await client.query<{ count: string; oldest: Date | null }>(
        `SELECT count(*)::text AS count, min(attempted_at) AS oldest FROM sports.provider_requests
         WHERE attempted_at > $1::timestamptz - interval '1 hour'`, [now],
      );
      if (Number(budget.rows[0].count) >= 120) {
        throw new RateLimitError(new Date(budget.rows[0].oldest!.getTime() + 3_600_000));
      }
      await client.query("INSERT INTO sports.provider_requests(action, resource_key, attempted_at) VALUES ($1,$2,$3)", [action, resourceKey, now]);
    });
  }

  private async revision(client: PoolClient, source: string, type: string, key: string, content: unknown): Promise<Revision> {
    const digest = hash(content);
    const previous = await client.query<{ id: string; content_sha256: string }>(
      `SELECT id, content_sha256 FROM sports.normalized_revisions
       WHERE entity_type=$1 AND entity_key=$2 ORDER BY ordinal DESC LIMIT 1`, [type, key],
    );
    if (previous.rows[0]?.content_sha256 === digest) return { id: previous.rows[0].id, changed: false };
    const result = await client.query<{ id: string }>(
      `INSERT INTO sports.normalized_revisions(source_revision_id,entity_type,entity_key,content_sha256,parent_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`, [source, type, key, digest, previous.rows[0]?.id ?? null],
    );
    const id = result.rows[0].id;
    await client.query(
      `INSERT INTO sports.audit_log(normalized_revision_id,actor_type,action,entity_type,entity_key,detail)
       VALUES ($1,'worker','normalize',$2,$3,$4)`, [id, type, key, JSON.stringify({ contentSha256: digest })],
    );
    return { id, changed: true };
  }

  /** Table and column names are internal constants; all provider values are parameters. */
  private async upsert(client: PoolClient, source: string, table: string, identity: Data, values: Data, type: string, key: string): Promise<{ id: string; revision: Revision }> {
    const columns = Object.keys(identity);
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM sports.${table} WHERE ${columns.map((column, i) => `${column}=$${i + 1}`).join(" AND ")}`,
      Object.values(identity),
    );
    const revision = await this.revision(client, source, type, key, { ...identity, ...values });
    if (existing.rows[0] && !revision.changed) return { id: existing.rows[0].id, revision };
    const data = { ...identity, ...values, normalized_revision_id: revision.id };
    const fields = Object.keys(data);
    const result = await client.query<{ id: string }>(
      `INSERT INTO sports.${table} (${fields.join(",")}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")})
       ON CONFLICT (${columns.join(",")}) DO UPDATE SET ${fields.filter((field) => !columns.includes(field)).map((field) => `${field}=EXCLUDED.${field}`).join(",")}
       RETURNING id`, Object.values(data),
    );
    return { id: result.rows[0].id, revision };
  }

  private async seasonClub(client: PoolClient, source: string, seasonId: string, clubId: string, key: string): Promise<boolean> {
    const revision = await this.revision(client, source, "season_club", key, { seasonId, clubId });
    if (!revision.changed) return false;
    await client.query(
      `INSERT INTO sports.season_clubs(season_id,club_id,normalized_revision_id) VALUES ($1,$2,$3)
       ON CONFLICT (season_id,club_id) DO UPDATE SET normalized_revision_id=EXCLUDED.normalized_revision_id`, [seasonId, clubId, revision.id],
    );
    return true;
  }

  private async player(client: PoolClient, source: string, player: Player): Promise<string> {
    const existing = await client.query<{ position: Player["position"] }>(`SELECT position FROM sports.players WHERE ${this.providerSql()} AND provider_id=$1`, [player.id]);
    const position = player.position === "UNKNOWN" ? existing.rows[0]?.position ?? "UNKNOWN" : player.position;
    const canonical = await this.upsert(client, source, "players", { provider: this.profile.provider, provider_id: player.id }, { name: player.name, position, ...(this.profile.provider === "sorare" ? { provider_slug: player.slug ?? null } : {}) }, "player", this.key("player", player.id));
    if (canonical.revision.changed) {
      await this.outbox(client, "canonical.changed", "player", canonical.id, `player:${canonical.revision.id}`, {
        playerId: player.id, revisionId: canonical.revision.id,
      });
    }
    return canonical.id;
  }

  private async membership(client: PoolClient, source: string, playerId: string, clubId: string, seasonId: string, kickoffAt: string, key: string): Promise<string> {
    const revision = await this.revision(client, source, "membership", key, { playerId, clubId, seasonId, kickoffAt, spanMicroseconds: 1 });
    if (!revision.changed) {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM sports.player_memberships WHERE player_id=$1 AND club_id=$2 AND season_id=$3 AND valid_from=$4`,
        [playerId, clubId, seasonId, kickoffAt],
      );
      if (existing.rows[0]) return existing.rows[0].id;
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO sports.player_memberships(player_id,club_id,season_id,valid_from,valid_until,normalized_revision_id)
       VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '1 microsecond',$5)
       ON CONFLICT (player_id,club_id,season_id,valid_from) DO UPDATE SET
         valid_until=EXCLUDED.valid_until, normalized_revision_id=EXCLUDED.normalized_revision_id RETURNING id`,
      [playerId, clubId, seasonId, kickoffAt, revision.id],
    );
    return result.rows[0].id;
  }

  private async outbox(client: PoolClient, event: string, aggregateType: string, aggregateId: string, dedupe: string, payload: Data): Promise<void> {
    await client.query(
      `INSERT INTO sports.outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (deduplication_key) DO NOTHING`, [event, aggregateType, aggregateId, dedupe, JSON.stringify(this.profile.provider === "sorare" ? { ...payload, provider: "sorare" } : payload)],
    );
  }

  private async rosterSnapshot(client: PoolClient, source: string, seasonId: string, archive: ArchivedResponse, batch: Batch, clubs: Map<string, string>, players: Map<string, string>): Promise<void> {
    if (!batch.roster || (await client.query("SELECT id FROM sports.roster_snapshots WHERE source_revision_id=$1", [source])).rows.length) return;
    const entries = [...batch.roster.entries].sort((a, b) => a.playerId.localeCompare(b.playerId) || a.clubId.localeCompare(b.clubId));
    if (entries.some((entry) => !clubs.has(entry.clubId) || !players.has(entry.playerId))) throw new Error("Roster entry lacks canonical context");
    const newer = await client.query(
      "SELECT id FROM sports.roster_snapshots WHERE season_id=$1 AND observed_at>$2::timestamptz LIMIT 1", [seasonId, archive.retrievedAt],
    );
    // An older replay may add historical evidence, but cannot revise the latest
    // effective roster or enqueue a regression to that older observation.
    const revision = newer.rows.length ? null : await this.revision(client, source, "roster", this.key("roster", batch.coverage.id, batch.coverage.season), {
      complete: batch.roster.complete, entries,
    });
    const snapshot = await client.query<{ id: string }>(
      `INSERT INTO sports.roster_snapshots(season_id,source_revision_id,observed_at,complete,normalized_revision_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`, [seasonId, source, archive.retrievedAt, batch.roster.complete, revision?.id ?? null],
    );
    for (const entry of entries) {
      await client.query(
        `INSERT INTO sports.roster_entries(snapshot_id,season_id,player_id,club_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (snapshot_id,player_id,club_id) DO NOTHING`, [snapshot.rows[0].id, seasonId, players.get(entry.playerId)!, clubs.get(entry.clubId)!],
      );
    }
    if (revision?.changed) {
      await this.outbox(client, "roster.changed", "roster", snapshot.rows[0].id, `roster:${revision.id}`, {
        leagueId: batch.coverage.id, season: batch.coverage.season, snapshotId: snapshot.rows[0].id, revisionId: revision.id,
      });
    }
  }

  /** Backfill a roster projection only from an already committed real archive. */
  async replayRoster(archive: ArchivedResponse, batch: Batch): Promise<void> {
    assertCoverage(batch.coverage, this.profile);
    validateArchive(archive);
    if (archive.id !== archiveId(archive)) throw new Error("Archive identity mismatch");
    if ((archive.params.provider ?? "apifootball") !== this.profile.provider) throw new Error("Archive source mismatch");
    if (archive.action !== "get_teams" || archive.params.league_id !== batch.coverage.id || !batch.roster || !batch.clubs.length) return;
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [IMPORT_LOCK]);
      const committed = await client.query<{ id: string }>(
        `SELECT s.id FROM sports.source_revisions s JOIN sports.ingestion_batches b ON b.source_revision_id=s.id
         WHERE b.archive_id=$1 AND s.archive_ref=$1 AND s.action='get_teams' AND s.resource_key=$2
           AND s.content_sha256=$3 AND s.retrieved_at=$4::timestamptz AND ${this.providerSql("s")}`,
        [archive.id, archive.resourceKey, archive.contentSha256, archive.retrievedAt],
      );
      if (!committed.rows[0]) return;
      const source = committed.rows[0].id;
      if ((await client.query("SELECT id FROM sports.roster_snapshots WHERE source_revision_id=$1", [source])).rows.length) return;
      const season = await client.query<{ id: string }>(
        `SELECT s.id FROM sports.competition_seasons s JOIN sports.competitions c ON c.id=s.competition_id
         WHERE ${this.providerSql("c")} AND c.provider_id=$1 AND s.label=$2`, [batch.coverage.id, batch.coverage.season],
      );
      if (!season.rows[0]) return;
      const clubRows = await client.query<{ id: string; provider_id: string }>(
        `SELECT c.id,c.provider_id FROM sports.season_clubs sc JOIN sports.clubs c ON c.id=sc.club_id
         WHERE sc.season_id=$1 AND ${this.providerSql("c")}`, [season.rows[0].id],
      );
      const clubs = new Map(clubRows.rows.map((club) => [club.provider_id, club.id]));
      const playerRows = await client.query<{ id: string; provider_id: string }>(
        `SELECT id,provider_id FROM sports.players WHERE ${this.providerSql()} AND provider_id=ANY($1::text[])`, [batch.players.map((player) => player.id)],
      );
      const players = new Map(playerRows.rows.map((player) => [player.provider_id, player.id]));
      // Preserve current names/positions. Only players previously omitted by an
      // older parser need a canonical identity before their roster can be saved.
      for (const player of batch.players) {
        if (!players.has(player.id)) players.set(player.id, await this.player(client, source, player));
      }
      await this.rosterSnapshot(client, source, season.rows[0].id, archive, batch, clubs, players);
    });
  }

  async import(archive: ArchivedResponse, batch: Batch): Promise<ImportResult> {
    assertCoverage(batch.coverage, this.profile);
    validateArchive(archive);
    if (archive.id !== archiveId(archive)) throw new Error("Archive identity mismatch");
    if ((archive.params.provider ?? "apifootball") !== this.profile.provider) throw new Error("Archive source mismatch");
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [IMPORT_LOCK]);
      const committed = await client.query<{ fixture_count: number; appearance_count: number; issues_json: Issue[] }>(
        "SELECT fixture_count,appearance_count,issues_json FROM sports.ingestion_batches WHERE archive_id=$1", [archive.id],
      );
      if (committed.rows[0]) return {
        archiveId: archive.id, duplicate: true, fixtures: committed.rows[0].fixture_count,
        appearances: committed.rows[0].appearance_count, issues: committed.rows[0].issues_json.length,
      };
      const sourceResult = await client.query<{ id: string }>(
        `INSERT INTO sports.source_revisions(provider,action,resource_key,archive_ref,content_sha256,retrieved_at)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (archive_ref) DO NOTHING RETURNING id`,
        [this.profile.provider, archive.action, archive.resourceKey, archive.id, archive.contentSha256, archive.retrievedAt],
      );
      const source = sourceResult.rows[0]?.id ?? (await client.query<{ id: string }>("SELECT id FROM sports.source_revisions WHERE archive_ref=$1", [archive.id])).rows[0].id;
      const newer = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM sports.source_revisions s
         JOIN sports.ingestion_batches b ON b.source_revision_id=s.id
         WHERE ${this.providerSql("s")} AND s.action=$1 AND s.resource_key=$2 AND s.retrieved_at > $3::timestamptz) AS exists`,
        [archive.action, archive.resourceKey, archive.retrievedAt],
      );
      if (newer.rows[0].exists) {
        const issues = [...batch.issues, { code: "superseded_archive", resource: archive.resourceKey }];
        await client.query(
          `INSERT INTO sports.ingestion_batches(archive_id,source_revision_id,fixture_count,appearance_count,issues_json)
           VALUES ($1,$2,0,0,$3)`, [archive.id, source, JSON.stringify(issues)],
        );
        return { archiveId: archive.id, duplicate: false, fixtures: 0, appearances: 0, issues: issues.length };
      }
      // Historical corrections protect the whole fixture from older observations,
      // including cross-endpoint replays after a newer provider revision is current.
      const corrected = this.profile.provider === "apifootball" ? await client.query<{ fixture_id: string }>(
        `SELECT DISTINCT split_part(n.entity_key,':',1) AS fixture_id
         FROM sports.normalized_revisions n JOIN sports.source_revisions s ON s.id=n.source_revision_id
         WHERE n.entity_type='appearance' AND s.provider='manual' AND s.retrieved_at >= $1::timestamptz
           AND n.entity_key ~ '^[1-9][0-9]{0,17}:[1-9][0-9]{0,17}$'
           AND split_part(n.entity_key,':',1)=ANY($2::text[])`,
        [archive.retrievedAt, batch.fixtures.map((fixture) => fixture.id)],
      ) : null;
      const protectedFixtures = new Set(corrected?.rows.map((row) => row.fixture_id) ?? []);
      if (this.profile.provider === "sorare" && batch.fixtures.length) {
        const existing = await client.query<{ fixture_id: string; player_id: string }>(
          `SELECT f.provider_id AS fixture_id,p.provider_id AS player_id FROM sports.appearances a
           JOIN sports.fixtures f ON f.id=a.fixture_id JOIN sports.players p ON p.id=a.player_id
           WHERE ${this.providerSql("f")} AND f.provider_id=ANY($1::text[])`, [batch.fixtures.map((fixture) => fixture.id)],
        );
        const identities = new Map(existing.rows.map((row) => [this.key("appearance", row.fixture_id, row.player_id), row.fixture_id]));
        const corrections = await client.query<{ entity_key: string }>(
          `SELECT n.entity_key FROM sports.normalized_revisions n JOIN sports.source_revisions s ON s.id=n.source_revision_id
           WHERE n.entity_type='appearance' AND s.provider='manual' AND s.retrieved_at >= $1::timestamptz
             AND n.entity_key=ANY($2::text[])`, [archive.retrievedAt, [...identities.keys()]],
        );
        for (const row of corrections.rows) protectedFixtures.add(identities.get(row.entity_key)!);
      }
      const coverage = batch.coverage;
      const competition = await this.upsert(client, source, "competitions", { provider: this.profile.provider, provider_id: coverage.id }, {
        name: coverage.name, country_name: coverage.country, timezone: coverage.timezone, coefficient: this.profile.coefficient, enabled: true,
      }, "competition", this.key("competition", coverage.id));
      const season = await this.upsert(client, source, "competition_seasons", { competition_id: competition.id, label: coverage.season }, {
        starts_on: coverage.startsOn, ends_on: coverage.endsOn, expected_clubs: coverage.expectedClubs, enabled: true,
      }, "season", this.key("season", coverage.id, coverage.season));
      const clubs = new Map<string, string>();
      let standingsChanged = false;
      const allClubs = new Map(batch.clubs.map((club) => [club.id, club]));
      for (const fixture of batch.fixtures) {
        allClubs.set(fixture.home.id, fixture.home);
        allClubs.set(fixture.away.id, fixture.away);
      }
      for (const club of [...allClubs.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        const canonical = await this.upsert(client, source, "clubs", { provider: this.profile.provider, provider_id: club.id }, { name: club.name, ...(this.profile.provider === "sorare" ? { provider_slug: club.slug ?? null } : {}) }, "club", this.key("club", club.id));
        clubs.set(club.id, canonical.id);
        standingsChanged = (await this.seasonClub(client, source, season.id, canonical.id, this.key("season_club", coverage.id, coverage.season, club.id))) || standingsChanged;
      }
      const allPlayers = new Map(batch.players.map((player) => [player.id, player]));
      for (const fixture of batch.fixtures) {
        for (const appearance of fixture.appearances) {
          const previous = allPlayers.get(appearance.player.id);
          allPlayers.set(appearance.player.id, {
            ...appearance.player,
            position: appearance.player.position === "UNKNOWN" ? previous?.position ?? "UNKNOWN" : appearance.player.position,
          });
        }
      }
      const playerIds = new Map<string, string>();
      for (const player of [...allPlayers.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        playerIds.set(player.id, await this.player(client, source, player));
      }
      if (archive.action === "get_teams") await this.rosterSnapshot(client, source, season.id, archive, batch, clubs, playerIds);
      let fixtures = 0;
      let appearances = 0;
      let lastRevision: string | null = season.revision.id;
      const issues = [...batch.issues];
      for (const fixture of [...batch.fixtures].sort((a, b) => a.id.localeCompare(b.id))) {
        if (fixture.leagueId !== coverage.id || fixture.season !== coverage.season) throw new Error("Fixture is outside import coverage");
        if (protectedFixtures.has(fixture.id)) {
          issues.push({ code: "superseded_by_manual_correction", resource: fixture.id });
          continue;
        }
        const previous = await this.readFixture(client, fixture.id);
        if (previous && (previous.leagueId !== coverage.id || previous.season !== coverage.season)) throw new Error("Fixture coverage cannot change during import");
        const old = await client.query<{ id: string; provider_id: string; player_id: string; club_provider_id: string | null }>(
          `SELECT a.id,p.provider_id,a.player_id,c.provider_id AS club_provider_id FROM sports.appearances a
           JOIN sports.players p ON p.id=a.player_id JOIN sports.fixtures f ON f.id=a.fixture_id
           LEFT JOIN sports.clubs c ON c.id=a.club_id
           WHERE ${this.providerSql("f")} AND f.provider_id=$1`, [fixture.id],
        );
        const existingPlayers = new Set(old.rows.map((appearance) => appearance.provider_id));
        const existingClubs = new Map(old.rows.map((appearance) => [appearance.provider_id, appearance.club_provider_id]));
        const changedHeader = Boolean(previous && hash(header(previous)) !== hash(header(fixture)));
        const changedSummaryMembership = (appearance: Appearance) => !fixture.detailed && !changedHeader
          && existingClubs.has(appearance.player.id) && existingClubs.get(appearance.player.id) !== appearance.clubId;
        standingsChanged = standingsChanged || !previous || changedHeader;
        let statisticsStatus = fixture.statisticsStatus;
        if (!fixture.detailed && previous && !changedHeader) statisticsStatus = previous.statisticsStatus;
        if (!fixture.detailed && changedHeader && previous?.detailed) statisticsStatus = "partial";
        if (!fixture.detailed && previous?.statisticsStatus === "complete"
          && fixture.appearances.some((appearance) => !existingPlayers.has(appearance.player.id))) statisticsStatus = "partial";
        if (fixture.appearances.some(changedSummaryMembership)) statisticsStatus = "partial";
        const canonical = await this.upsert(client, source, "fixtures", { provider: this.profile.provider, provider_id: fixture.id }, {
          season_id: season.id, home_club_id: clubs.get(fixture.home.id)!, away_club_id: clubs.get(fixture.away.id)!,
          kickoff_at: fixture.kickoffAt, status: fixture.status, statistics_status: statisticsStatus,
          home_score: fixture.homeScore, away_score: fixture.awayScore,
        }, "fixture", this.key("fixture", fixture.id));
        if (canonical.revision.changed) {
          fixtures++;
          lastRevision = canonical.revision.id;
          await this.outbox(client, "canonical.changed", "fixture", canonical.id, `fixture:${canonical.revision.id}`, { fixtureId: fixture.id, leagueId: coverage.id, revisionId: canonical.revision.id });
        }
        const activePlayers = new Set<string>();
        const summaryMembershipRevisions: string[] = [];
        for (const appearance of fixture.appearances) {
          activePlayers.add(appearance.player.id);
          const membershipChanged = changedSummaryMembership(appearance);
          // Same-club summaries preserve archived detail. A changed club is new
          // context, so its earlier metrics cannot confirm the new attribution.
          if (!fixture.detailed && !changedHeader && existingPlayers.has(appearance.player.id) && !membershipChanged) continue;
          const observation: Appearance = membershipChanged ? {
            ...appearance, participation: "unknown", minutes: null, rating: null,
            goals: null, assists: null, shotsOnTarget: null, keyPasses: null,
            tackles: null, interceptions: null, saves: null, goalsConceded: null,
          } : appearance;
          const revision = await this.appearance(client, source, canonical.id, fixture, observation, season.id, clubs, playerIds, issues);
          appearances += Number(revision.changed);
          if (membershipChanged && revision.changed) summaryMembershipRevisions.push(revision.id);
        }
        if (fixture.detailed || changedHeader) {
          for (const removed of old.rows) {
            if (activePlayers.has(removed.provider_id)) continue;
            const revision = await this.revision(client, source, "appearance", this.key("appearance", fixture.id, removed.provider_id), {
              fixture_id: canonical.id, player_id: removed.player_id, season_id: season.id,
              ...this.appearanceFields(null, null, null, "unknown"),
            });
            if (!revision.changed) continue;
            await client.query(
              `UPDATE sports.appearances SET season_id=$2,club_id=NULL,membership_id=NULL,participation='unknown',
               minutes=NULL,rating=NULL,goals=NULL,assists=NULL,shots_on_target=NULL,key_passes=NULL,tackles=NULL,
               interceptions=NULL,saves=NULL,goals_conceded=NULL,normalized_revision_id=$3 WHERE fixture_id=$1 AND player_id=$4`,
              [canonical.id, season.id, revision.id, removed.player_id],
            );
            await this.outbox(client, "canonical.changed", "appearance", removed.id, `appearance:${revision.id}`, {
              fixtureId: fixture.id, playerId: removed.provider_id, revisionId: revision.id,
            });
            appearances++;
          }
        }
        const currentIncomplete = this.profile.provider === "sorare" && statisticsStatus !== "complete";
        if (archive.action === "get_events" && fixture.status === "final"
          && (currentIncomplete || (canonical.revision.changed && (statisticsStatus !== "complete" || changedHeader)) || summaryMembershipRevisions.length > 0)) {
          // A fresh current-source observation can carry review corrections even
          // when its schedule header is unchanged. Archived legacy keys stay exact.
          const enrichmentRevision = currentIncomplete ? archive.id : summaryMembershipRevisions.at(-1) ?? canonical.revision.id;
          await this.outbox(client, "fixture.statistics", "fixture", canonical.id,
            `fixture.statistics:${fixture.id}:${enrichmentRevision}`, { fixtureId: fixture.id, leagueId: coverage.id });
        }
      }
      if (standingsChanged) {
        await this.outbox(client, "standings.rebuild", "season", season.id,
          `standings.rebuild:${archive.id}:${coverage.id}`, { leagueId: coverage.id });
      }
      if (archive.action === "get_standings") {
        lastRevision = await this.reconcileStandings(client, source, season.id, batch, issues);
      }
      const importedRevision = await client.query<{ id: string }>(
        "SELECT id FROM sports.normalized_revisions WHERE source_revision_id=$1 ORDER BY ordinal DESC LIMIT 1", [source],
      );
      lastRevision = importedRevision.rows[0]?.id ?? lastRevision;
      await client.query(
        `INSERT INTO sports.ingestion_batches(archive_id,source_revision_id,normalized_revision_id,fixture_count,appearance_count,issues_json)
         VALUES ($1,$2,$3,$4,$5,$6)`, [archive.id, source, lastRevision, fixtures, appearances, JSON.stringify(issues)],
      );
      return { archiveId: archive.id, duplicate: false, fixtures, appearances, issues: issues.length };
    });
  }

  private async reconcileStandings(client: PoolClient, source: string, seasonId: string, batch: Batch, issues: Issue[]): Promise<string> {
    const clubs = await client.query<{ id: string; name: string }>(
      `SELECT c.provider_id AS id,c.name FROM sports.season_clubs sc
       JOIN sports.clubs c ON c.id=sc.club_id WHERE sc.season_id=$1 ORDER BY c.provider_id`, [seasonId],
    );
    const schedule = await client.query(`${this.fixtureSelect()} WHERE f.season_id=$1 ORDER BY f.provider_id`, [seasonId]);
    const today = localDate(new Date().toISOString(), batch.coverage.timezone);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    const reconstructed = reconstructStandings(batch.coverage, clubs.rows, schedule.rows.map((row) => this.fixtureRow(row)), tomorrow);
    const reference = new Map(batch.standings.map((row) => [row.clubId, row]));
    const mismatches: Issue[] = [];
    const fields = ["played", "wins", "draws", "losses", "goalsFor", "goalsAgainst", "points"] as const;
    for (const row of reconstructed.rows) {
      const observed = reference.get(row.clubId);
      if (!observed) {
        mismatches.push({ code: "missing_standings_reference", resource: row.clubId });
        continue;
      }
      for (const field of fields) {
        if (observed[field] !== row[field]) mismatches.push({ code: "standings_reference_mismatch", resource: row.clubId, field });
      }
    }
    const known = new Set(reconstructed.rows.map((row) => row.clubId));
    for (const row of batch.standings) {
      if (!known.has(row.clubId)) mismatches.push({ code: "unknown_standings_reference_club", resource: row.clubId });
    }
    if (!reconstructed.complete) issues.push({ code: "standings_reference_incomplete", resource: batch.coverage.id });
    issues.push(...mismatches);
    const content = {
      reference: [...batch.standings].sort((a, b) => a.clubId.localeCompare(b.clubId)),
      computed: reconstructed.rows, complete: reconstructed.complete, mismatches,
    };
    const revision = await this.revision(client, source, "standings_reference", this.key("standings_reference", batch.coverage.id, batch.coverage.season), content);
    if (revision.changed) {
      await client.query(
        `INSERT INTO sports.audit_log(normalized_revision_id,actor_type,action,entity_type,entity_key,detail)
         VALUES ($1,'worker','reconcile','standings_reference',$2,$3)`,
        [revision.id, this.key("standings_reference", batch.coverage.id, batch.coverage.season), JSON.stringify({ ...content, reconstructionIssues: reconstructed.issues })],
      );
    }
    return revision.id;
  }

  private appearanceFields(appearance: Appearance | null, clubId: string | null, membershipId: string | null, participation: Appearance["participation"]): Data {
    return {
      club_id: clubId, membership_id: membershipId, participation,
      minutes: appearance?.minutes ?? null, rating: appearance?.rating ?? null,
      goals: appearance?.goals ?? null, assists: appearance?.assists ?? null,
      shots_on_target: appearance?.shotsOnTarget ?? null, key_passes: appearance?.keyPasses ?? null,
      tackles: appearance?.tackles ?? null, interceptions: appearance?.interceptions ?? null,
      saves: appearance?.saves ?? null, goals_conceded: appearance?.goalsConceded ?? null,
    };
  }

  private async appearance(client: PoolClient, source: string, fixtureId: string, fixture: Fixture, appearance: Appearance, seasonId: string, clubs: Map<string, string>, playerIds: Map<string, string>, issues: Issue[]): Promise<Revision> {
    const playerId = playerIds.get(appearance.player.id)!;
    const participant = appearance.clubId === fixture.home.id || appearance.clubId === fixture.away.id;
    const clubId = participant ? clubs.get(appearance.clubId) ?? null : null;
    let membershipId: string | null = null;
    let participation = appearance.participation;
    if (clubId && fixture.kickoffAt) {
      membershipId = await this.membership(client, source, playerId, clubId, seasonId, fixture.kickoffAt,
        this.key("membership", appearance.player.id, appearance.clubId, fixture.leagueId, fixture.season, fixture.kickoffAt));
    } else {
      participation = "unknown";
      issues.push({ code: "appearance_context_unknown", resource: `${fixture.id}:${appearance.player.id}` });
    }
    const canonical = await this.upsert(client, source, "appearances", { fixture_id: fixtureId, player_id: playerId }, {
      season_id: seasonId, ...this.appearanceFields(appearance, clubId, membershipId, participation),
    }, "appearance", this.key("appearance", fixture.id, appearance.player.id));
    if (canonical.revision.changed) {
      await this.outbox(client, "canonical.changed", "appearance", canonical.id, `appearance:${canonical.revision.id}`, { fixtureId: fixture.id, playerId: appearance.player.id, revisionId: canonical.revision.id });
    }
    return canonical.revision;
  }

  async fixture(providerId: string): Promise<Fixture | null> {
    const client = await this.pool.connect();
    try {
      const fixture = await this.readFixture(client, providerId);
      if (!fixture) return null;
      const result = await client.query(
        `SELECT a.*,p.provider_id AS player_provider_id,p.name AS player_name,p.position,
         ${this.profile.provider === "sorare" ? "p.provider_slug AS player_slug," : ""}
         c.provider_id AS club_provider_id FROM sports.appearances a
         JOIN sports.fixtures f ON f.id=a.fixture_id JOIN sports.players p ON p.id=a.player_id
         LEFT JOIN sports.clubs c ON c.id=a.club_id WHERE ${this.providerSql("f")} AND f.provider_id=$1
         ORDER BY p.provider_id`, [providerId],
      );
      fixture.appearances = result.rows.map((row) => ({
        player: { id: row.player_provider_id, name: row.player_name, position: row.position, ...(typeof row.player_slug === "string" ? { slug: row.player_slug } : {}) },
        clubId: row.club_provider_id ?? "", participation: row.participation,
        minutes: row.minutes, rating: row.rating === null ? null : Number(row.rating),
        goals: row.goals, assists: row.assists, shotsOnTarget: row.shots_on_target,
        keyPasses: row.key_passes, tackles: row.tackles, interceptions: row.interceptions,
        saves: row.saves, goalsConceded: row.goals_conceded,
      }));
      return fixture;
    } finally { client.release(); }
  }

  private fixtureRow(row: QueryResultRow): Fixture {
    return {
      id: row.provider_id, leagueId: row.league_id, season: row.season,
      home: { id: row.home_provider_id, name: row.home_name, ...(typeof row.home_slug === "string" ? { slug: row.home_slug } : {}) },
      away: { id: row.away_provider_id, name: row.away_name, ...(typeof row.away_slug === "string" ? { slug: row.away_slug } : {}) },
      kickoffAt: iso(row.kickoff_at), status: row.status, statisticsStatus: row.statistics_status,
      homeScore: row.home_score, awayScore: row.away_score,
      detailed: row.statistics_status === "partial" || row.statistics_status === "complete", appearances: [],
    };
  }

  private fixtureSelect(): string {
    return `SELECT f.*,c.provider_id AS league_id,cs.label AS season,
      h.provider_id AS home_provider_id,h.name AS home_name,a.provider_id AS away_provider_id,a.name AS away_name
      ${this.profile.provider === "sorare" ? ",h.provider_slug AS home_slug,a.provider_slug AS away_slug" : ""}
      FROM sports.fixtures f JOIN sports.competition_seasons cs ON cs.id=f.season_id
      JOIN sports.competitions c ON c.id=cs.competition_id
      JOIN sports.clubs h ON h.id=f.home_club_id JOIN sports.clubs a ON a.id=f.away_club_id`;
  }

  private async readFixture(client: PoolClient, providerId: string): Promise<Fixture | null> {
    const result = await client.query(`${this.fixtureSelect()} WHERE ${this.providerSql("f")} AND f.provider_id=$1`, [providerId]);
    return result.rows[0] ? this.fixtureRow(result.rows[0]) : null;
  }

  async rebuild(coverage: Coverage, cutoffDate?: string): Promise<{ snapshots: number; complete: boolean; issues: number }> {
    assertCoverage(coverage, this.profile);
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [IMPORT_LOCK]);
      const seasonResult = await client.query<{ id: string }>(
        `SELECT cs.id FROM sports.competition_seasons cs JOIN sports.competitions c ON c.id=cs.competition_id
         WHERE ${this.providerSql("c")} AND c.provider_id=$1 AND cs.label=$2 AND c.enabled AND cs.enabled`, [coverage.id, coverage.season],
      );
      if (!seasonResult.rows[0]) return { snapshots: 0, complete: false, issues: 1 };
      const seasonId = seasonResult.rows[0].id;
      const clubResult = await client.query<{ id: string; provider_id: string; name: string }>(
        `SELECT c.id,c.provider_id,c.name FROM sports.season_clubs sc JOIN sports.clubs c ON c.id=sc.club_id
         WHERE sc.season_id=$1 ORDER BY c.provider_id`, [seasonId],
      );
      const clubs: Club[] = clubResult.rows.map((row) => ({ id: row.provider_id, name: row.name }));
      const clubIds = new Map(clubResult.rows.map((row) => [row.provider_id, row.id]));
      const fixtureResult = await client.query(`${this.fixtureSelect()} WHERE f.season_id=$1 ORDER BY f.provider_id`, [seasonId]);
      const fixtures = fixtureResult.rows.map((row) => this.fixtureRow(row));
      const sources = await client.query<{ id: string; provider_id: string; content_sha256: string; source_revision_id: string }>(
        `SELECT n.id,f.provider_id,n.content_sha256,n.source_revision_id FROM sports.fixtures f
         JOIN sports.normalized_revisions n ON n.id=f.normalized_revision_id
         WHERE f.season_id=$1 ORDER BY n.ordinal DESC`, [seasonId],
      );
      // A derived snapshot must point to real archived fixture input, never synthetic provider data.
      if (!sources.rows[0]) return { snapshots: 0, complete: false, issues: 1 };
      const source = sources.rows[0].source_revision_id;
      for (const adjustment of POINTS_ADJUSTMENTS) {
        if (adjustment.leagueId !== coverage.id || coverage.season !== "2026/27") continue;
        const clubId = clubIds.get(adjustment.clubId);
        if (!clubId) continue;
        const revision = await this.revision(client, source, "points_adjustment", this.key("points_adjustment", coverage.id, coverage.season, adjustment.clubId, adjustment.effectiveAt), adjustment);
        await client.query(
          `INSERT INTO sports.points_adjustments(season_id,club_id,points,reason,effective_at,provenance_url,normalized_revision_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (season_id,club_id,effective_at,provenance_url) DO NOTHING`,
          [seasonId, clubId, adjustment.points, adjustment.reason, adjustment.effectiveAt, adjustment.provenanceUrl, revision.id],
        );
      }
      const today = localDate(new Date().toISOString(), coverage.timezone);
      const currentCutoff = today > coverage.endsOn ? coverage.endsOn : today;
      const dates = cutoffDate ? new Set([cutoffDate]) : new Set([
        ...fixtures.filter((fixture) => fixture.kickoffAt).map((fixture) => localDate(fixture.kickoffAt!, coverage.timezone)),
        currentCutoff,
      ]);
      let snapshots = 0;
      let complete = true;
      let issues = 0;
      for (const date of [...dates].sort()) {
        if (date > currentCutoff) {
          if (cutoffDate) throw new Error("Standings cutoff cannot be in the future");
          continue;
        }
        if (date < coverage.startsOn || date > coverage.endsOn) {
          if (cutoffDate) throw new Error("Standings cutoff is outside covered season");
          continue;
        }
        const reconstructed = reconstructStandings(coverage, clubs, fixtures, date);
        complete = complete && reconstructed.complete;
        issues += reconstructed.issues.length;
        const fixtureRevisions = sources.rows.filter((row) => {
          const fixture = fixtures.find((item) => item.id === row.provider_id)!;
          return fixture.kickoffAt === null || localDate(fixture.kickoffAt, coverage.timezone) < date;
        }).map((row) => ({ fixtureId: row.provider_id, revisionId: row.id, contentSha256: row.content_sha256, sourceRevisionId: row.source_revision_id }))
          .sort((a, b) => a.fixtureId.localeCompare(b.fixtureId));
        const revision = await this.revision(client, source, "standings", this.key("standings", coverage.id, coverage.season, date), {
          date, rows: reconstructed.rows, complete: reconstructed.complete, issues: reconstructed.issues,
          fixtureInputs: fixtures.filter((fixture) => fixture.kickoffAt === null || localDate(fixture.kickoffAt, coverage.timezone) < date)
            .map((fixture) => ({ id: fixture.id, ...header(fixture) })),
          schedule: fixtures.map((fixture) => ({ id: fixture.id, home: fixture.home.id, away: fixture.away.id })),
          adjustments: POINTS_ADJUSTMENTS.filter((item) => item.leagueId === coverage.id && coverage.season === "2026/27"),
        });
        if (!revision.changed) continue;
        const snapshot = await client.query<{ id: string }>(
          `INSERT INTO sports.standings_snapshots(season_id,cutoff_local_date,cutoff_at,normalized_revision_id,complete)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`, [seasonId, date, cutoffUtc(date, coverage.timezone), revision.id, reconstructed.complete],
        );
        for (const row of reconstructed.rows) {
          await client.query(
            `INSERT INTO sports.standings_rows(snapshot_id,season_id,club_id,position,rank_uncertain,played,wins,draws,losses,goals_for,goals_against,points)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [snapshot.rows[0].id, seasonId, clubIds.get(row.clubId)!, row.position, row.rankUncertain, row.played, row.wins, row.draws, row.losses, row.goalsFor, row.goalsAgainst, row.points],
          );
        }
        await client.query(
          `INSERT INTO sports.audit_log(normalized_revision_id,actor_type,action,entity_type,entity_key,detail)
           VALUES ($1,'worker','reconstruct','standings',$2,$3)`,
          [revision.id, this.key("standings", coverage.id, coverage.season, date), JSON.stringify({ fixtureRevisions, issues: reconstructed.issues })],
        );
        await this.outbox(client, "standings.changed", "standings", snapshot.rows[0].id, `standings:${revision.id}`, { leagueId: coverage.id, season: coverage.season, cutoffDate: date, revisionId: revision.id });
        snapshots++;
      }
      return { snapshots, complete, issues };
    });
  }
}
