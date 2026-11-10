import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { ProviderError } from "./provider";
import { CURRENT_SOURCE, sourceCoverage } from "./sources";
import { RateLimitError, type IngestionStore } from "./store";
import type { Coverage, ProviderAction, ProviderResponse } from "./types";

const ENDPOINT = "https://api.sorare.com/graphql";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 100;
const TIMEOUT_MS = 30_000;
export const SORARE_FORMAT = "sorare-capture-v1";
export type SorareCapture = { query: string; variables: Record<string, string | number | null>; retrievedAt: string; text: string };
export type SorareBundle = { format: typeof SORARE_FORMAT; complete: boolean; captures: SorareCapture[] };
type Row = Record<string, unknown>;
const row = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const TEAM = "id slug name";
const PLAYER = "id slug displayName position";
const PAGE = "pageInfo { hasNextPage endCursor }";
const HEADER = `id date competition { slug } homeTeam { ${TEAM} } awayTeam { ${TEAM} } homeGoals awayGoals statusTyped coverageStatus lowCoverage scored`;
export const SORARE_QUERIES = {
  teams: `query SorareTeams($slug:String!,$after:String) { football { competition(slug:$slug) { slug teams(first:50,after:$after) { nodes { ${TEAM} } ${PAGE} } } } }`,
  players: `query SorarePlayers($slug:String!,$after:String) { football { club(slug:$slug) { ${TEAM} activePlayers(first:50,after:$after) { nodes { ${PLAYER} } ${PAGE} } } } }`,
  past: `query SorarePast($slug:String!,$after:String) { football { competition(slug:$slug) { slug pastGames(first:50,after:$after) { nodes { ${HEADER} } ${PAGE} } } } }`,
  future: `query SorareFuture($slug:String!,$after:String) { football { competition(slug:$slug) { slug futureGames(first:50,after:$after) { nodes { ${HEADER} } ${PAGE} } } } }`,
  standings: `query SorareStandings($slug:String!,$year:Int!) { football { competition(slug:$slug) { slug contestants(seasonStartYear:$year) { anyTeam { ${TEAM} } matchesPlayed matchesWon matchesDrawn matchesLost goalsFor goalsAgainst points rank } } } }`,
  statistics: `query SorareStatistics($id:ID!) { football { game(id:$id) { ${HEADER} homeFormation { startingLineupAvailable startingLineup { ${PLAYER} } bench { ${PLAYER} } } awayFormation { startingLineupAvailable startingLineup { ${PLAYER} } bench { ${PLAYER} } } playerGameScores { anyPlayer { slug displayName ... on Player { id position } } anyPlayerGameStats { ... on PlayerGameStats { id minsPlayed goals goalAssist ontargetScoringAtt totalTackle wonTackle interceptionWon saves goalsConceded reviewed live playedInGame onGameSheet fieldStatus anyTeam { ${TEAM} } } } scoreStatus scoringVersion detailedScore { stat statValue } } } } }`,
} as const;
export type SorareOperation = keyof typeof SORARE_QUERIES;

export function sorareOperation(query: string): SorareOperation | null {
  return (Object.keys(SORARE_QUERIES) as SorareOperation[]).find((kind) => SORARE_QUERIES[kind] === query) ?? null;
}

function retryAfter(value: string | null): Date {
  const seconds = value !== null && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const parsed = value !== null ? Date.parse(value) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(parsed) ? parsed - Date.now() : 60_000;
  return new Date(Date.now() + Math.min(3_600_000, Math.max(1000, delay)));
}

function graphFailure(payload: unknown): ProviderError | null {
  if (!row(payload)) return new ProviderError("provider_rejected", false);
  if (Array.isArray(payload.errors) && payload.errors.length) {
    // Classify privately; provider messages never enter errors, logs or archives.
    const details = JSON.stringify(payload.errors).toLowerCase();
    if (/rate.?limit|too many|quota|\b429\b/.test(details)) return new ProviderError("provider_rate_limit", true, retryAfter(null));
    if (/temporarily|unavailable|internal.server|\b5\d\d\b/.test(details)) return new ProviderError("provider_unavailable", true);
    return new ProviderError("provider_rejected", false);
  }
  return row(payload.data) ? null : new ProviderError("provider_rejected", false);
}

/** A partial immutable capture may be saved for recovery diagnosis, never imported. */
export class SorareCaptureError extends ProviderError {
  constructor(readonly cause: ProviderError | RateLimitError, readonly capture: ProviderResponse) {
    super(cause instanceof RateLimitError ? "request_budget_unavailable" : cause.code,
      cause instanceof RateLimitError || cause.retryable, cause.retryAt);
  }
}

export class SorareClient {
  #apiKey: string;
  constructor(private readonly budget: Pick<IngestionStore, "reserveRequest">, apiKey: string, private readonly fetcher: typeof fetch = fetch) {
    if (typeof apiKey !== "string" || !apiKey || apiKey.trim() !== apiKey || apiKey.length > 512 || /[\u0000-\u001f\u007f]/.test(apiKey)) {
      throw new ProviderError("configuration_invalid", false);
    }
    this.#apiKey = apiKey;
  }

  private async reserve(action: ProviderAction, resourceKey: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try { await this.budget.reserveRequest(action, resourceKey); return; }
      catch (error) {
        if (error instanceof RateLimitError) {
          const delay = error.retryAt.getTime() - Date.now();
          // The deadline can pass while the SQL transaction returns. Recheck
          // the shared budget instead of treating an expired local wait as a
          // provider rejection; every HTTP attempt still requires reservation.
          if (attempt < 10 && delay <= 1100) { await pause(Math.max(1, delay)); continue; }
          throw error;
        }
        throw new ProviderError("request_budget_unavailable", true);
      }
    }
  }

  private async execute(action: ProviderAction, resourceKey: string, query: string, variables: SorareCapture["variables"]): Promise<{ capture: SorareCapture; football: Row }> {
    await this.reserve(action, resourceKey);
    const controller = new AbortController();
    let rejectAbort: ((error: ProviderError) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort?.(new ProviderError("request_timeout", true));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const result = await Promise.race([this.fetcher(ENDPOINT, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", APIKEY: this.#apiKey },
        body: JSON.stringify({ query, variables }), redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
      }), aborted]);
      if (result.redirected || (result.status >= 300 && result.status < 400)) {
        void result.body?.cancel().catch(() => undefined);
        throw new ProviderError("redirect_rejected", false);
      }
      if (!result.ok) {
        void result.body?.cancel().catch(() => undefined);
        const retryable = result.status === 429 || result.status >= 500;
        throw new ProviderError(result.status === 429 ? "http_rate_limit" : retryable ? "http_unavailable" : "http_rejected", retryable,
          retryable && (result.status === 429 || result.headers.has("retry-after")) ? retryAfter(result.headers.get("retry-after")) : undefined);
      }
      const length = result.headers.get("content-length");
      if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_BYTES) {
        void result.body?.cancel().catch(() => undefined);
        throw new ProviderError("response_too_large", false);
      }
      reader = result.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) for (;;) {
        const next = await Promise.race([reader.read(), aborted]);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BYTES) throw new ProviderError("response_too_large", false);
        chunks.push(next.value);
      }
      const text = Buffer.concat(chunks, size).toString("utf8");
      if (text.includes(this.#apiKey)) throw new ProviderError("credential_echo", false);
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { throw new ProviderError("provider_rejected", false); }
      // JSON escaping must not hide an echoed header credential from the raw
      // substring check (for example a quoted key or unicode-escaped response).
      if (JSON.stringify(payload).includes(JSON.stringify(this.#apiKey).slice(1, -1))) throw new ProviderError("credential_echo", false);
      const failure = graphFailure(payload);
      if (failure) throw failure;
      const data = (payload as { data: Row }).data;
      if (!row(data.football)) throw new ProviderError("provider_rejected", false);
      return { capture: { query, variables, text, retrievedAt: new Date().toISOString() }, football: data.football };
    } catch (error) {
      if (reader) { try { void reader.cancel().catch(() => undefined); } catch { /* Keep details private. */ } }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(controller.signal.aborted ? "request_timeout" : "transport_failed", true);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      try { reader?.releaseLock(); } catch { /* Keep details private. */ }
    }
  }

  async request(action: ProviderAction, input: Record<string, string>): Promise<ProviderResponse> {
    let coverage: Readonly<Coverage>;
    try {
      coverage = sourceCoverage(CURRENT_SOURCE, input.league_id);
      if (Object.keys(input).some((key) => !["league_id", ...(action === "get_statistics" ? ["match_id"] : [])].includes(key))
        || !["get_teams", "get_events", "get_statistics", "get_standings"].includes(action)
        || (action === "get_statistics" && !/^Game:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.match_id ?? ""))) throw new Error();
    } catch { throw new ProviderError("request_invalid", false); }
    const params = { ...input, provider: "sorare", format: SORARE_FORMAT };
    const resourceKey = `sorare:${JSON.stringify({ action, league: coverage.id, ...(input.match_id ? { game: input.match_id } : {}) })}`;
    const captures: SorareCapture[] = [];
    const response = (complete: boolean): ProviderResponse => {
      const text = JSON.stringify({ format: SORARE_FORMAT, complete, captures } satisfies SorareBundle);
      if (Buffer.byteLength(text) > 15 * 1024 * 1024) throw new ProviderError("response_too_large", false);
      return { action, resourceKey, params, text, retrievedAt: captures.at(-1)?.retrievedAt ?? new Date().toISOString(),
        contentSha256: createHash("sha256").update(text).digest("hex") };
    };
    const page = async (kind: SorareOperation, variables: SorareCapture["variables"]): Promise<Row> => {
      const result = await this.execute(action, `${resourceKey}:${kind}`, SORARE_QUERIES[kind], variables);
      captures.push(result.capture);
      if (captures.reduce((total, capture) => total + Buffer.byteLength(capture.text), 0) > 12 * 1024 * 1024) throw new ProviderError("response_too_large", false);
      return result.football;
    };
    const pages = async (kind: "teams" | "players" | "past" | "future", slug: string, expectedClubId?: string): Promise<Row[]> => {
      let after: string | null = null;
      const cursors = new Set<string>();
      const nodes: Row[] = [];
      let previousDate: number | undefined;
      for (let count = 0; count < MAX_PAGES; count++) {
        const data = await page(kind, { slug, after });
        const parent = kind === "players" ? data.club : data.competition;
        const field = { teams: "teams", players: "activePlayers", past: "pastGames", future: "futureGames" }[kind];
        if (!row(parent) || parent.slug !== slug || (kind === "players" && parent.id !== expectedClubId) || !row(parent[field])) throw new ProviderError("provider_rejected", false);
        const connection = parent[field] as Row;
        if (!Array.isArray(connection.nodes) || !connection.nodes.every(row) || !row(connection.pageInfo)
          || typeof connection.pageInfo.hasNextPage !== "boolean") throw new ProviderError("provider_rejected", false);
        const current = connection.nodes as Row[];
        if (kind === "past" || kind === "future") for (const game of current) {
          const date = typeof game.date === "string" ? Date.parse(game.date) : NaN;
          if (!Number.isFinite(date) || (previousDate !== undefined && (kind === "past" ? date > previousDate : date < previousDate))) {
            throw new ProviderError("provider_rejected", false);
          }
          previousDate = date;
        }
        nodes.push(...current);
        if (!connection.pageInfo.hasNextPage) return nodes;
        // Sorare pastGames is newest-first; futureGames is oldest-first. A page
        // wholly beyond the season boundary completes this season's capture.
        if ((kind === "past" || kind === "future") && current.length && current.every((game) => typeof game.date === "string"
          && (kind === "past" ? game.date.slice(0, 10) < coverage.startsOn : game.date.slice(0, 10) > coverage.endsOn))) return nodes;
        const cursor = connection.pageInfo.endCursor;
        if (!current.length || typeof cursor !== "string" || !cursor || cursors.has(cursor)) throw new ProviderError("provider_rejected", false);
        cursors.add(cursor);
        after = cursor;
      }
      throw new ProviderError("provider_rejected", false);
    };
    try {
      if (action === "get_teams") {
        const teams = await pages("teams", coverage.id);
        const unique = new Map<string, Row>();
        for (const club of teams) {
          if (typeof club.id !== "string" || typeof club.slug !== "string" || unique.has(club.id)) throw new ProviderError("provider_rejected", false);
          unique.set(club.id, club);
        }
        if (unique.size !== coverage.expectedClubs) throw new ProviderError("provider_rejected", false);
        for (const club of unique.values()) await pages("players", club.slug as string, club.id as string);
      } else if (action === "get_events") {
        await pages("past", coverage.id);
        await pages("future", coverage.id);
      } else if (action === "get_standings") await page("standings", { slug: coverage.id, year: Number(coverage.season.slice(0, 4)) });
      else await page("statistics", { id: input.match_id.slice(5) });
      return response(true);
    } catch (error) {
      if ((error instanceof RateLimitError || error instanceof ProviderError) && captures.length) throw new SorareCaptureError(error, response(false));
      throw error;
    }
  }
}
