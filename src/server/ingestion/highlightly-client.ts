import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import type { EnrichmentStore } from "./enrichment-store";
import { ProviderError } from "./provider";
import { RateLimitError } from "./store";
import type { Coverage, ProviderAction, ProviderResponse } from "./types";

export const HIGHLIGHTLY_LEAGUES: Readonly<Record<string, number>> = Object.freeze({
  "premier-league-gb-eng": 33973, "laliga-es": 119924,
});
export type HighlightlyCapture = { path: string; retrievedAt: string; text: string };
export type HighlightlySchedule = { format: "highlightly-schedule-v1"; captures: HighlightlyCapture[] };
export type HighlightlyBox = {
  format: "highlightly-box-v1"; scheduleArchiveId: string; fixture: Record<string, unknown>;
  primaryFingerprint: string; capture: HighlightlyCapture;
};
export class HighlightlyScheduleError extends Error {
  constructor(readonly cause: unknown, readonly response: ProviderResponse) { super("Supplementary schedule capture is incomplete"); }
}
export const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function highlightlyResponse(action: ProviderAction, leagueId: string, value: HighlightlySchedule | HighlightlyBox): ProviderResponse {
  const box = value.format === "highlightly-box-v1" ? value : null;
  const text = JSON.stringify(value);
  const retrievedAt = box ? box.capture.retrievedAt : (value as HighlightlySchedule).captures.at(-1)!.retrievedAt;
  const id = box ? String(box.fixture.id) : null;
  return { action, params: { provider: "highlightly", league_id: leagueId, format: value.format, ...(id ? { match_id: id } : {}) },
    resourceKey: id ? `highlightly:statistics:${leagueId}:${id}` : `highlightly:schedule:${leagueId}`,
    text, retrievedAt, contentSha256: createHash("sha256").update(text).digest("hex") };
}

/** One registered key, shared durable daily allowance, and no redirect forwarding. */
export class HighlightlyClient {
  #key: string;
  constructor(private readonly store: Pick<EnrichmentStore, "reserveRequest" | "observeQuota">, key: string, private readonly fetcher: typeof fetch = fetch) {
    if (!key || key.trim() !== key || key.length > 512 || /[\u0000-\u001f\u007f]/.test(key)) throw new ProviderError("configuration_invalid", false);
    this.#key = key;
  }

  async get(action: ProviderAction, path: string): Promise<HighlightlyCapture> {
    if (!/^\/(?:matches\?|box-score\/[1-9]\d*$)/.test(path) || path.length > 1024) throw new ProviderError("request_invalid", false);
    for (let attempt = 0; ; attempt++) {
      try { await this.store.reserveRequest(action, `highlightly:${path}`); break; }
      catch (error) {
        if (error instanceof RateLimitError && attempt < 10 && error.retryAt.getTime() - Date.now() <= 1100) {
          await pause(Math.max(1, error.retryAt.getTime() - Date.now())); continue;
        }
        throw error;
      }
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher(`https://soccer.highlightly.net${path}`, {
        headers: { Accept: "application/json", "x-rapidapi-key": this.#key },
        redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(30_000),
      });
      const remaining = response.headers.get("x-ratelimit-requests-remaining");
      if (remaining !== null && /^\d{1,3}$/.test(remaining) && Number(remaining) <= 100) await this.store.observeQuota(Number(remaining));
      if (!response.ok || response.redirected) {
        void response.body?.cancel().catch(() => undefined);
        throw new ProviderError(response.status === 429 ? "http_rate_limit" : response.status >= 500 ? "http_unavailable" : "http_rejected",
          response.status === 429 || response.status >= 500,
          response.status === 429 ? new Date(Date.now() + 3_600_000) : undefined);
      }
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new ProviderError("response_too_large", false);
        chunks.push(next.value);
      }
      const text = Buffer.concat(chunks, bytes).toString("utf8");
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new ProviderError("provider_rejected", false); }
      if (text.includes(this.#key) || JSON.stringify(value).includes(JSON.stringify(this.#key).slice(1, -1))) throw new ProviderError("credential_echo", false);
      return { path, text, retrievedAt: new Date().toISOString() };
    } catch (error) {
      if (reader) void reader.cancel().catch(() => undefined);
      if (error instanceof ProviderError || error instanceof RateLimitError) throw error;
      throw new ProviderError("transport_failed", true);
    } finally { try { reader?.releaseLock(); } catch { /* Safe error details only. */ } }
  }

  async schedule(coverage: Coverage): Promise<ProviderResponse> {
    const id = HIGHLIGHTLY_LEAGUES[coverage.id];
    if (!id || coverage.season !== "2026/27") throw new ProviderError("request_invalid", false);
    const captures: HighlightlyCapture[] = [];
    let total: number | undefined;
    try { for (let offset = 0; offset < (total ?? 1); offset += 100) {
      const query = new URLSearchParams({ leagueId: String(id), season: "2026", limit: "100", offset: String(offset) });
      const capture = await this.get("get_events", `/matches?${query}`);
      captures.push(capture);
      const page: unknown = JSON.parse(capture.text);
      if (!object(page) || !object(page.pagination) || !object(page.plan) || page.plan.tier !== "BASIC"
        || typeof page.pagination.totalCount !== "number" || !Number.isSafeInteger(page.pagination.totalCount)
        || page.pagination.totalCount < 0 || page.pagination.totalCount > 380
        || (total !== undefined && total !== page.pagination.totalCount)
        || page.pagination.offset !== offset || !Array.isArray(page.data)
        || page.data.length !== Math.min(100, page.pagination.totalCount - offset)) throw new ProviderError("provider_rejected", false);
      total = page.pagination.totalCount;
    } } catch (error) {
      if (captures.length) throw new HighlightlyScheduleError(error, highlightlyResponse("get_events", coverage.id, { format: "highlightly-schedule-v1", captures }));
      throw error;
    }
    return highlightlyResponse("get_events", coverage.id, { format: "highlightly-schedule-v1", captures });
  }
}
