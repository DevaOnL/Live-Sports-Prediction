import { createHash } from "node:crypto";
import { coverageFor } from "./coverage";
import { RateLimitError, type IngestionStore } from "./store";
import type { ProviderAction, ProviderResponse } from "./types";

const ENDPOINT = "https://apiv3.apifootball.com/";
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const PARAMS: Record<ProviderAction, readonly string[]> = {
  get_teams: ["league_id"], get_standings: ["league_id"],
  get_statistics: ["league_id", "match_id"],
  get_events: ["league_id", "from", "to", "timezone", "match_id"],
};
const MESSAGES = {
  configuration_invalid: "Provider credentials are not configured correctly",
  request_invalid: "Provider request is outside approved coverage",
  request_budget_unavailable: "Provider request budget is unavailable",
  transport_failed: "Provider connection failed",
  request_timeout: "Provider request timed out",
  http_rate_limit: "Provider request limit reached",
  http_unavailable: "Provider service is unavailable",
  http_rejected: "Provider rejected the request",
  redirect_rejected: "Provider redirect was rejected",
  response_too_large: "Provider response exceeds the size limit",
  credential_echo: "Provider response contains restricted credentials",
  provider_rate_limit: "Provider request limit reached",
  provider_unavailable: "Provider service is unavailable",
  provider_rejected: "Provider rejected the request",
} as const;
type ErrorCode = keyof typeof MESSAGES;

export class ProviderError extends Error {
  constructor(readonly code: ErrorCode, readonly retryable: boolean, readonly retryAt?: Date) {
    super(MESSAGES[code]);
    this.name = "ProviderError";
  }
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validId(value: string | undefined): boolean {
  return typeof value === "string" && /^[1-9]\d{0,17}$/.test(value) && Number.isSafeInteger(Number(value));
}

function parameters(action: ProviderAction, input: Record<string, string>): Record<string, string> {
  try {
    if (!Object.hasOwn(PARAMS, action) || !input || typeof input !== "object" || Array.isArray(input)) throw new Error();
    const entries = Object.entries(input);
    if (entries.some(([key, value]) => !PARAMS[action].includes(key) || typeof value !== "string")) throw new Error();
    const result = Object.fromEntries(entries.sort(([first], [second]) => first.localeCompare(second)));
    const coverage = coverageFor(result.league_id);
    if (action === "get_statistics" && !validId(result.match_id)) throw new Error();
    if (action === "get_events") {
      if (result.timezone !== "UTC") throw new Error();
      if (result.match_id !== undefined) {
        if (!validId(result.match_id) || result.from !== undefined || result.to !== undefined) throw new Error();
      } else if (!validDate(result.from ?? "") || !validDate(result.to ?? "")
        || result.from < coverage.startsOn || result.to > coverage.endsOn || result.from > result.to) throw new Error();
    }
    return result;
  } catch {
    throw new ProviderError("request_invalid", false);
  }
}

function retryAfter(value: string | null, fallbackSeconds = 60): Date {
  const now = Date.now();
  const seconds = value !== null && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const date = value !== null && !Number.isFinite(seconds) ? Date.parse(value) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - now : fallbackSeconds * 1000;
  return new Date(now + Math.max(1000, Math.min(3_600_000, Number.isFinite(delay) ? delay : 3_600_000)));
}

function providerFailure(text: string): ProviderError | null {
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return null; }
  if (Array.isArray(payload) && payload.length === 1) payload = payload[0];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)
    || (!Object.hasOwn(payload, "error") && !Object.hasOwn(payload, "errors"))) return null;
  const error = payload as Record<string, unknown>;
  const details = JSON.stringify([error.error, error.errors, error.code, error.message]).toLowerCase();
  if (/(?:\b429\b|rate.?limit|too many|request limit|requests? (?:per|limit)|maximum.*requests?|exceeded.*(?:requests?|quota)|quota.*exceeded)/.test(details)) {
    return new ProviderError("provider_rate_limit", true, retryAfter(null));
  }
  if (/(?:\b5\d\d\b|server error|temporarily unavailable|service unavailable|try again)/.test(details)) {
    return new ProviderError("provider_unavailable", true);
  }
  return new ProviderError("provider_rejected", false);
}

function cancel(body: ReadableStream<Uint8Array> | null): void {
  try { void body?.cancel().catch(() => undefined); } catch { /* Keep transport details private. */ }
}

export class ProviderClient {
  #apiKey: string;

  constructor(
    private readonly budget: Pick<IngestionStore, "reserveRequest">,
    apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (typeof apiKey !== "string" || !apiKey || apiKey.trim() !== apiKey || apiKey.length > 512 || /[\u0000-\u001f\u007f]/.test(apiKey)) {
      throw new ProviderError("configuration_invalid", false);
    }
    this.#apiKey = apiKey;
  }

  async request(action: ProviderAction, params: Record<string, string>): Promise<ProviderResponse> {
    const approved = parameters(action, params);
    const resourceKey = JSON.stringify({ action, params: approved });
    try { await this.budget.reserveRequest(action, resourceKey); }
    catch (error) {
      if (error instanceof RateLimitError) throw error;
      throw new ProviderError("request_budget_unavailable", true);
    }
    const url = new URL(ENDPOINT);
    url.searchParams.set("action", action);
    for (const [key, value] of Object.entries(approved)) url.searchParams.set(key, value);
    url.searchParams.set("APIkey", this.#apiKey);
    const controller = new AbortController();
    let rejectAbort: ((error: ProviderError) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort?.(new ProviderError("request_timeout", true));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const result = await Promise.race([this.fetcher(url, {
        method: "GET", headers: { Accept: "application/json" }, redirect: "error",
        credentials: "omit", cache: "no-store", signal: controller.signal,
      }), aborted]);
      if (result.redirected || (result.status >= 300 && result.status < 400)) {
        cancel(result.body);
        throw new ProviderError("redirect_rejected", false);
      }
      if (!result.ok) {
        cancel(result.body);
        const retryable = result.status === 429 || result.status >= 500;
        const retryAt = retryable && (result.status === 429 || result.headers.has("retry-after"))
          ? retryAfter(result.headers.get("retry-after")) : undefined;
        throw new ProviderError(result.status === 429 ? "http_rate_limit" : retryable ? "http_unavailable" : "http_rejected", retryable, retryAt);
      }
      const contentLength = result.headers.get("content-length");
      if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BYTES) {
        cancel(result.body);
        throw new ProviderError("response_too_large", false);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      reader = result.body?.getReader();
      if (reader) {
        for (;;) {
          const next = await Promise.race([reader.read(), aborted]);
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_BYTES) {
            try { void reader.cancel().catch(() => undefined); } catch { /* Keep the fixed size-limit error. */ }
            throw new ProviderError("response_too_large", false);
          }
          chunks.push(next.value);
        }
      }
      const text = Buffer.concat(chunks, size).toString("utf8");
      if (text.includes(this.#apiKey)) throw new ProviderError("credential_echo", false);
      const failure = providerFailure(text);
      if (failure) throw failure;
      return {
        action, resourceKey, params: approved, text, retrievedAt: new Date().toISOString(),
        contentSha256: createHash("sha256").update(text).digest("hex"),
      };
    } catch (error) {
      if (reader) {
        try { void reader.cancel().catch(() => undefined); } catch { /* Keep transport details private. */ }
      }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(controller.signal.aborted ? "request_timeout" : "transport_failed", true);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      try { reader?.releaseLock(); } catch { /* Never replace a sanitized result with stream details. */ }
    }
  }
}
