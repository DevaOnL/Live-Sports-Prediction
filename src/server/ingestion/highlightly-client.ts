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

export type HighlightlyFailureReason = "missing_box" | "invalid_resource" | "authentication" | "rate_limit" | "unavailable"
  | "rejected" | "invalid_response" | "transport" | "redirect" | "credential_echo";
/** Diagnostics contain fixed classifications, never upstream messages or bodies. */
export class HighlightlyError extends ProviderError {
  constructor(code: ProviderError["code"], retryable: boolean, readonly scope: "resource" | "provider",
    readonly reason: HighlightlyFailureReason, readonly status?: number, retryAt?: Date) {
    super(code, retryable, retryAt);
    this.name = "HighlightlyError";
  }
}

const MAX_RETRY_MS = 86_400_000;
function retryAt(headers: Headers, rateLimited: boolean): Date | undefined {
  const now = Date.now();
  const after = headers.get("retry-after")?.trim();
  const reset = headers.get("x-ratelimit-requests-reset")?.trim();
  let delay: number | undefined;
  if (after !== undefined) {
    if (/^\d{1,10}$/.test(after)) delay = Number(after) * 1000;
    else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), /i.test(after)) {
      const parsed = Date.parse(after);
      if (Number.isFinite(parsed)) delay = parsed - now;
    }
  }
  // RapidAPI defines this optional header as seconds until reset, not an epoch.
  if (rateLimited && delay === undefined && reset !== undefined && /^\d{1,10}$/.test(reset)) {
    delay = Number(reset) * 1000;
  }
  if (delay === undefined && !rateLimited) return undefined;
  return new Date(now + Math.max(1000, Math.min(MAX_RETRY_MS, delay ?? 3_600_000)));
}

function cancel(body: ReadableStream<Uint8Array> | null): void {
  try { void body?.cancel().catch(() => undefined); } catch { /* Never expose transport details. */ }
}

function failure(status: number, path: string, headers: Headers, details = "", payloadStatus?: number): HighlightlyError {
  const classified = payloadStatus ?? status;
  if (classified === 401 || classified === 403 || /invalid request token|invalid (?:api[ -]?)?key|unauthenticated|unauthorized|forbidden|not subscribed/.test(details)) {
    return new HighlightlyError("http_rejected", false, "provider", "authentication", status);
  }
  if (classified === 429 || /rate.?limit|too many requests|requests? limit|quota.*(?:exceed|exhaust)|(?:exceed|exhaust).*quota/.test(details)) {
    return new HighlightlyError(status === 429 ? "http_rate_limit" : "provider_rate_limit", true, "provider", "rate_limit", status, retryAt(headers, true));
  }
  if (classified >= 500 || /internal server error|service unavailable|temporarily unavailable|try again/.test(details)) {
    return new HighlightlyError(status >= 500 ? "http_unavailable" : "provider_unavailable", true, "provider", "unavailable", status, retryAt(headers, false));
  }
  const box = path.startsWith("/box-score/");
  if (box && classified === 404) return new HighlightlyError("http_rejected", false, "resource", "missing_box", status);
  const explicitResource = /(?:box[ -]?score|match(?:[ _-]?id)?|resource|\bid\b).{0,60}(?:not found|not available|does not exist|invalid)|(?:not found|not available|does not exist|invalid).{0,60}(?:box[ -]?score|match(?:[ _-]?id)?|resource|\bid\b)/.test(details);
  if (box && (classified === 400 || status === 200) && explicitResource) {
    return new HighlightlyError(status === 200 ? "provider_rejected" : "http_rejected", false, "resource", "invalid_resource", status);
  }
  return new HighlightlyError(status === 200 ? "provider_rejected" : "http_rejected", false, "provider", "rejected", status);
}

function payloadFailure(value: unknown, status: number, path: string, headers: Headers): HighlightlyError | null {
  if (Array.isArray(value) && value.length === 1) value = value[0];
  if (!object(value)) return null;
  const statusValue = value.statusCode ?? value.status_code ?? value.status ?? value.code;
  const payloadStatus = typeof statusValue === "number" && Number.isInteger(statusValue) && statusValue >= 400 && statusValue <= 599
    ? statusValue : typeof statusValue === "string" && /^[45]\d\d$/.test(statusValue) ? Number(statusValue) : undefined;
  const populated = (entry: unknown) => entry !== undefined && entry !== null && entry !== false && entry !== ""
    && !(Array.isArray(entry) && entry.length === 0) && !(object(entry) && Object.keys(entry).length === 0);
  const expected = path.startsWith("/matches?") && Array.isArray(value.data);
  if (!populated(value.error) && !populated(value.errors) && value.success !== false && payloadStatus === undefined
    && (expected || typeof value.message !== "string")) return null;
  // Inspect only to classify; neither these details nor the payload enter errors.
  const details = JSON.stringify([value.error, value.errors, value.message, value.details, value.code]).toLowerCase();
  return failure(status, path, headers, details, payloadStatus);
}

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
    const signal = AbortSignal.timeout(30_000);
    let response: Response;
    try {
      response = await this.fetcher(`https://soccer.highlightly.net${path}`, {
        headers: { Accept: "application/json", "x-rapidapi-key": this.#key },
        redirect: "error", credentials: "omit", cache: "no-store", signal,
      });
    } catch {
      throw new HighlightlyError(signal.aborted ? "request_timeout" : "transport_failed", true, "provider", "transport");
    }
    // Persistence failures must reach the runner as persistence failures. Do not
    // turn a failed quota write into a retryable provider connection failure.
    try {
      const remaining = response.headers.get("x-ratelimit-requests-remaining");
      if (remaining !== null && /^\d{1,3}$/.test(remaining) && Number(remaining) <= 100) await this.store.observeQuota(Number(remaining));
    } catch (error) { cancel(response.body); throw error; }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      cancel(response.body);
      throw new HighlightlyError("redirect_rejected", false, "provider", "redirect", response.status);
    }
    // Only a 400 needs its bounded body to distinguish an explicit bad match id
    // from an unknown/global rejection. Other HTTP failures need no raw capture.
    if (!response.ok && response.status !== 400) {
      cancel(response.body);
      throw failure(response.status, path, response.headers);
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let text: string;
    try {
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new HighlightlyError("response_too_large", false, "provider", "invalid_response", response.status);
        chunks.push(next.value);
      }
      text = Buffer.concat(chunks, bytes).toString("utf8");
    } catch (error) {
      if (reader) void reader.cancel().catch(() => undefined);
      if (error instanceof ProviderError) throw error;
      throw new HighlightlyError(signal.aborted ? "request_timeout" : "transport_failed", true, "provider", "transport", response.status);
    } finally { try { reader?.releaseLock(); } catch { /* Safe error details only. */ } }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw response.ok ? new HighlightlyError("provider_rejected", false, "provider", "invalid_response", response.status) : failure(response.status, path, response.headers); }
    if (text.includes(this.#key) || JSON.stringify(value).includes(JSON.stringify(this.#key).slice(1, -1))) {
      throw new HighlightlyError("credential_echo", false, "provider", "credential_echo", response.status);
    }
    const error = payloadFailure(value, response.status, path, response.headers);
    if (error) throw error;
    if (!response.ok) throw failure(response.status, path, response.headers);
    if (path.startsWith("/box-score/") ? !Array.isArray(value) : !object(value)) {
      throw new HighlightlyError("provider_rejected", false, "provider", "invalid_response", response.status);
    }
    return { path, text, retrievedAt: new Date().toISOString() };
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
