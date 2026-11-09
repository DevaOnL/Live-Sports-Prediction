"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ApiFailure } from "@/lib/api";
import { formatDate } from "@/lib/presentation";
import type { SourceFreshness } from "@/server/api/read";

export function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description?: string; children?: ReactNode }) {
  return <header className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{children && <div className="action-row">{children}</div>}</header>;
}
export function PanelState({ loading, error, onRetry, empty, children }: { loading?: boolean; error?: unknown; onRetry?: () => void; empty?: string | boolean; children?: ReactNode }) {
  if (loading) return <div className="state-panel" role="status" aria-live="polite"><div className="loading-line" /><p>Loading the latest saved evidence…</p></div>;
  if (error) {
    const status = error instanceof ApiFailure ? error.status : 503;
    const title = status === 401 ? "Your session has ended." : status === 403 ? "Administrator access required." : status === 404 ? "This record is unavailable." : status === 400 ? "Check your selection." : "We could not load this view.";
    return <section className="state-panel" role="alert"><h2>{title}</h2><p>{error instanceof Error ? error.message : "Please try again shortly."}</p><div className="action-row">{status === 401 ? <Link className="button" href="/login">Sign in again</Link> : onRetry && <button className="button button-secondary" onClick={onRetry}>Try again</button>}<Link className="text-link" href="/overview">Back to overview</Link></div></section>;
  }
  if (empty) return <section className="state-panel"><h2>Nothing here yet.</h2><p>{typeof empty === "string" ? empty : "Try changing your filters or check again after an import."}</p></section>;
  return children;
}
const labels: Record<string, string> = { available: "Available", partial: "Partly available", unavailable: "Unavailable", uncomputed: "Not evaluated", ready: "Ready", running: "Running", succeeded: "Completed", failed: "Failed", incomplete_history: "Incomplete history", insufficient_history: "Not enough history" };
export function StatusBadge({ status }: { status: string }) { return <span className={`badge badge-${status.replace(/[^a-z_]/g, "")}`}>{labels[status] ?? status.replaceAll("_", " ")}</span>; }
export function SourceNote({ source }: { source: SourceFreshness }) { return <div className="source-note"><span>View snapshot: {formatDate(source.cutoffAt)}</span><span>Latest normalized provider observation: {formatDate(source.latestRetrievedAt)}</span><span>Source revision {source.sourceOrdinal}. Saved evaluations can lag behind new data or fixture changes.</span></div>; }
export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (value: number) => void }) { return <nav className="pagination" aria-label="Pagination"><button className="button button-secondary button-small" onClick={() => onPage(page - 1)} disabled={page <= 1}>Previous page</button><span>Page {page} of {Math.max(1, pages)}</span><button className="button button-secondary button-small" onClick={() => onPage(page + 1)} disabled={page >= pages}>Next page</button></nav>; }
