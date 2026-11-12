import type { EnrichmentProgress } from "../server/ingestion/enrichment";
import { HighlightlyError, type HighlightlyFailureReason } from "../server/ingestion/highlightly-client";
import { ProviderError } from "../server/ingestion/provider";
import { RateLimitError } from "../server/ingestion/store";

export type SupplementStatus = {
  state: string;
  retryAt: string;
  error: { code: ProviderError["code"] | "processing_failed"; reason?: HighlightlyFailureReason; status?: number } | null;
};

export function supplementProgress(progress: EnrichmentProgress, now = Date.now()): SupplementStatus {
  const waiting = progress.pending > 0 && (progress.deferred ?? 0) >= progress.pending;
  const retry = waiting && progress.retryAt ? Date.parse(progress.retryAt) : now + 60_000;
  return {
    state: progress.busy ? "busy" : waiting ? "waiting-for-data" : progress.pending ? "backfilling" : progress.unmapped ? "partial" : "synced",
    retryAt: new Date(progress.busy || progress.pending ? Math.max(now + 1000, retry) : now + 3_600_000).toISOString(),
    error: null,
  };
}

/** Fixed diagnostics only: never serialize an upstream message, cause or body. */
export function supplementFailure(error: unknown, failures: number, now = Date.now()): SupplementStatus {
  if (error instanceof RateLimitError) return {
    state: "budget-deferred", retryAt: new Date(Math.max(now + 1000, error.retryAt.getTime())).toISOString(), error: null,
  };
  if (error instanceof ProviderError) {
    const resource = error instanceof HighlightlyError && error.scope === "resource";
    const delay = resource ? 60_000 : Math.min(3_600_000, 900_000 * 2 ** Math.min(2, Math.max(0, failures - 1)));
    return {
      state: resource ? "waiting-for-data" : error.code,
      retryAt: new Date(Math.max(now + delay, error.retryAt?.getTime() ?? 0)).toISOString(),
      error: {
        code: error.code,
        ...(error instanceof HighlightlyError ? { reason: error.reason, ...(error.status !== undefined ? { status: error.status } : {}) } : {}),
      },
    };
  }
  return { state: "processing-failed", retryAt: new Date(now + 60_000).toISOString(), error: { code: "processing_failed" } };
}
