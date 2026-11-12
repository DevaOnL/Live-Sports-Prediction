"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ApiFailure } from "@/lib/api";
import { formatDate, presentationText } from "@/lib/presentation";
import type { SourceFreshness } from "@/server/api/read";
import { useDataVisibility } from "./data-visibility";

export function PageHeading({ eyebrow, title, description, children }: { eyebrow?: string; title: string; description?: string; children?: ReactNode }) {
  return <header className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{children && <div className="action-row">{children}</div>}</header>;
}
export function PanelState({ loading, error, onRetry, empty, children }: { loading?: boolean; error?: unknown; onRetry?: () => void; empty?: string | boolean; children?: ReactNode }) {
  if (loading) return <div className="state-panel" role="status" aria-live="polite"><div className="loading-line" /><p>Loading…</p></div>;
  if (error) {
    const status = error instanceof ApiFailure ? error.status : 503;
    const title = status === 401 ? "Your session has ended." : status === 403 ? "Administrator access required." : status === 404 ? "This record could not be found." : status === 400 ? "Check your selection." : "We could not load this view.";
    return <section className="state-panel" role="alert"><h2>{title}</h2><p>{error instanceof Error ? presentationText(error.message) : "Please try again shortly."}</p><div className="action-row">{status === 401 ? <Link className="button" href="/login">Sign in again</Link> : onRetry && <button className="button button-secondary" onClick={onRetry}>Try again</button>}<Link className="text-link" href="/overview">Back to overview</Link></div></section>;
  }
  if (empty) return <section className="state-panel"><h2>Nothing here yet.</h2><p>{typeof empty === "string" ? empty : "Try changing your filters or check again after an import."}</p></section>;
  return children;
}
const labels: Record<string, string> = { available: "Complete results", partial: "Some results", unavailable: "Hidden", uncomputed: "Not recorded", ready: "Queued", running: "Running", succeeded: "Completed", failed: "Failed", incomplete_history: "Incomplete history", insufficient_history: "Not enough history" };
export function statusLabel(status: string): string {
  return labels[status] ?? presentationText(status.replaceAll("_", " "));
}
export function isStatusBadgeVisible(status: string, showHidden: boolean, kind: "result" | "job" = "result"): boolean {
  if (status === "available" || (status === "ready" && kind !== "job")) return false;
  return showHidden || !["unavailable", "uncomputed", "incomplete_history", "insufficient_history"].includes(status);
}
export function StatusBadge({ status, kind = "result" }: { status: string; kind?: "result" | "job" }) {
  const { showHidden } = useDataVisibility();
  if (!isStatusBadgeVisible(status, showHidden, kind)) return null;
  return <span className={`badge badge-${status.replace(/[^a-z_]/g, "")}`}>{statusLabel(status)}</span>;
}
export function SourceNote({ source }: { source: SourceFreshness }) {
  const { showHidden } = useDataVisibility();
  return <details className="source-note"><summary>Data &amp; freshness</summary><div>
    <span>View snapshot: {formatDate(source.cutoffAt)}</span>
    {(source.latestRetrievedAt || showHidden) && <span>Latest normalized provider observation: {formatDate(source.latestRetrievedAt)}</span>}
    {source.supplementLatestRetrievedAt && <span>Highlightly supplement: {formatDate(source.supplementLatestRetrievedAt)}</span>}
    <span>Source revision {source.sourceOrdinal}. Saved evaluations can lag behind new data or fixture changes.</span>
  </div></details>;
}
export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (value: number) => void }) { return <nav className="pagination" aria-label="Pagination"><button className="button button-secondary button-small" onClick={() => onPage(page - 1)} disabled={page <= 1}>Previous page</button><span>Page {page} of {Math.max(1, pages)}</span><button className="button button-secondary button-small" onClick={() => onPage(page + 1)} disabled={page >= pages}>Next page</button></nav>; }
