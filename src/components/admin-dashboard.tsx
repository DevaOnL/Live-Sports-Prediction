"use client";

import { useState, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { AdminStatusData, AuditData, ImportsData, JobsData } from "@/lib/contracts";
import { useApi } from "@/lib/use-api";
import { formatDate } from "@/lib/presentation";
import type { QueuedAdminCommand, RetriedAdminCommand } from "@/server/api/admin";
import { PageHeading, Pager, PanelState, StatusBadge } from "./ui";
import { CommandFeedback, useAdminCommand } from "./admin-command";
import { AdminCorrection } from "./admin-correction";

const kindLabels: Record<string, string> = { "source.sync": "Source import", "fixture.statistics": "Fixture statistics", "standings.rebuild": "Standings rebuild", "forecast.refresh": "Forecast refresh" };
const actionLabels: Record<string, string> = { get_events: "Fixtures and appearances", get_teams: "Clubs and rosters", get_statistics: "Fixture statistics", get_standings: "Standings reference", unknown: "Unavailable source action" };

function EmptyAdminPage({ page, total, noun, onPage }: { page: number; total: number; noun: string; onPage: (page: number) => void }) {
  return <section className="state-panel"><h3>No entries on this page.</h3><p>{total > 0 ? `${total} ${noun} match this view. Choose another page to see them.` : `There are no ${noun} in this view.`}</p>{page > 1 && <button type="button" className="button button-secondary" onClick={() => onPage(1)}>Return to first page</button>}</section>;
}

function QueueAction({ kind, onAccepted }: { kind: "import" | "forecast"; onAccepted: () => void }) {
  const forecast = kind === "forecast";
  const command = useAdminCommand<QueuedAdminCommand>(onAccepted);
  return <div className="metric-card"><h3>{forecast ? "Refresh saved forecasts" : "Import covered source data"}</h3>
    <p className="muted">{forecast ? "Queue a local evaluation using existing canonical data. Forecast requests may be coalesced into shared work." : "Queue a worker synchronization for approved competitions and season. Provider requests use the shared application budget."}</p>
    <button className="button button-secondary" disabled={command.pending} onClick={() => command.send(forecast ? "admin/forecasts/refresh" : "admin/imports")}>{command.pending ? "Submitting…" : command.uncertain ? `Retry same ${kind} request` : forecast ? "Queue forecast refresh" : "Queue source import"}</button>
    <CommandFeedback {...command}>{command.result && <><p>Accepted for processing. This confirms queue acceptance; it does not confirm completion.</p><p className="form-note">Request ID <span className="code-value">{command.result.requestId}</span></p><p className="form-note">Event ID <span className="code-value">{command.result.eventId}</span></p>{forecast && <p className="form-note">Several refresh events can share one forecast job.</p>}</>}</CommandFeedback>
  </div>;
}

function StatisticsRequest({ onAccepted }: { onAccepted: () => void }) {
  const [leagueId, setLeagueId] = useState("153");
  const [fixtureId, setFixtureId] = useState("");
  const command = useAdminCommand<QueuedAdminCommand>(onAccepted);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await command.send("admin/statistics", { leagueId, fixtureId });
  }
  return <form className="metric-card" onSubmit={submit}><h3>Request fixture statistics</h3><p className="muted">For an existing covered live or finalized fixture. The worker performs the provider request.</p>
    <div className="field-grid"><label className="field" htmlFor="statistics-league"><span className="field-label">Statistics competition</span><select id="statistics-league" className="field-select" value={leagueId} disabled={command.locked} onChange={(event) => setLeagueId(event.target.value)}><option value="153">Championship · 2026/27</option><option value="164">Ligue 2 · 2026/27</option></select></label>
      <label className="field" htmlFor="statistics-fixture"><span className="field-label">Statistics fixture ID</span><input id="statistics-fixture" className="field-input" inputMode="numeric" pattern="[1-9][0-9]{0,17}" required value={fixtureId} disabled={command.locked} onChange={(event) => setFixtureId(event.target.value)} /></label></div>
    <button className="button button-secondary" disabled={command.pending}>{command.pending ? "Submitting…" : command.uncertain ? "Retry same statistics request" : "Queue fixture statistics"}</button>
    <CommandFeedback {...command}>{command.result && <><p>Accepted for processing. Inspect the job status for completion.</p><p className="form-note">Request ID <span className="code-value">{command.result.requestId}</span> · Event ID <span className="code-value">{command.result.eventId}</span></p></>}</CommandFeedback>
  </form>;
}

function RetryJob({ id, onAccepted }: { id: string; onAccepted: () => void }) {
  const command = useAdminCommand<RetriedAdminCommand>(onAccepted);
  return <div><button type="button" className="button button-secondary button-small" disabled={command.pending} aria-label={`Retry job ${id}`} onClick={() => command.send(`admin/jobs/${id}/retry`)}>{command.pending ? "Submitting…" : command.uncertain ? "Retry same request" : "Retry failed job"}</button><CommandFeedback {...command}>{command.result && <p>Accepted for another attempt.</p>}</CommandFeedback></div>;
}

function OperationalStatus({ revision, onRetry }: { revision: number; onRetry: () => void }) {
  const status = useApi<AdminStatusData>("admin/status", revision);
  return <section aria-labelledby="operations-status"><h2 id="operations-status">At a glance</h2><PanelState loading={status.loading} error={status.error} onRetry={onRetry}>{status.data && <>
    <div className="metric-grid"><article className="metric-card"><p className="eyebrow">Application request budget</p><strong className="metric-value">{status.data.providerBudget.remaining}<small> / {status.data.providerBudget.limit}</small></strong><p>Attempts remaining in the rolling hour</p><p className="form-note">This application cap is separate from provider plan limits. {status.data.providerBudget.retryAt && `Next budget opportunity: ${formatDate(status.data.providerBudget.retryAt)}.`}</p></article>
      <article className="metric-card"><p className="eyebrow">Committed imports</p><strong className="metric-value">{status.data.imports.batches}</strong><p>{status.data.imports.validationIssues} recorded validation issues</p><p className="form-note">Latest commit: {formatDate(status.data.imports.lastCommittedAt)}</p></article>
      <article className="metric-card"><p className="eyebrow">Worker jobs</p><strong className="metric-value">{status.data.jobs.reduce((sum, job) => sum + (job.status === "ready" || job.status === "running" ? job.count : 0), 0)}</strong><p>Ready or running</p><p className="form-note">{status.data.jobs.reduce((sum, job) => sum + (job.status === "failed" ? job.count : 0), 0)} failed jobs need review.</p></article></div>
    <div className="table-wrap"><table className="data-table"><caption>Approved coverage in canonical storage</caption><thead><tr><th scope="col">Competition</th><th scope="col">Season</th><th scope="col">Fixtures</th><th scope="col">Finalized</th><th scope="col">Incomplete statistics</th></tr></thead><tbody>{status.data.coverage.map((item) => <tr key={item.leagueId}><th scope="row">{item.leagueId === "153" ? "Championship" : "Ligue 2"}</th><td>{item.season}</td><td>{item.fixtures}</td><td>{item.finalFixtures}</td><td>{item.incompleteStatistics}</td></tr>)}</tbody></table>{!status.data.coverage.length && <p className="muted">No approved competition has been imported yet.</p>}</div>
  </>}</PanelState></section>;
}

function Jobs({ path, revision, onRetry, onPage, onFilter, status, kind }: { path: string; revision: number; onRetry: () => void; onPage: (page: number) => void; onFilter: (key: string, value: string) => void; status: string; kind: string }) {
  const jobs = useApi<JobsData>(path, revision);
  return <><div className="field-grid"><label className="field" htmlFor="job-status"><span className="field-label">Job status</span><select id="job-status" className="field-select" value={status} onChange={(event) => onFilter("status", event.target.value)}><option value="">All statuses</option>{["ready", "running", "succeeded", "failed"].map((value) => <option key={value} value={value}>{value === "succeeded" ? "Completed" : value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
    <label className="field" htmlFor="job-kind"><span className="field-label">Job kind</span><select id="job-kind" className="field-select" value={kind} onChange={(event) => onFilter("kind", event.target.value)}><option value="">All jobs</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <PanelState loading={jobs.loading} error={jobs.error} onRetry={onRetry}>{jobs.data && <>{jobs.data.items.length === 0 && <EmptyAdminPage page={jobs.data.page} total={jobs.data.total} noun="jobs" onPage={onPage} />}<div className="table-wrap"><table className="data-table"><caption>Worker queue · {jobs.data.total} matching jobs</caption><thead><tr><th scope="col">Job</th><th scope="col">Status</th><th scope="col">Timing</th><th scope="col">Outcome / recovery</th></tr></thead><tbody>{jobs.data.items.map((job) => <tr key={job.id}><th scope="row">{kindLabels[job.kind]}<span className="form-note code-value">{job.id}</span>{job.outboxId && <span className="form-note code-value">Event: {job.outboxId}</span>}{Object.keys(job.payload).length > 0 && <span className="form-note">Competition {job.payload.leagueId}{job.payload.fixtureId ? ` · Fixture ${job.payload.fixtureId}` : ""}</span>}</th><td><StatusBadge status={job.status} /><p className="form-note">Attempt {job.attempts} / {job.maxAttempts}</p></td><td><p className="form-note">Created {formatDate(job.createdAt)}</p><p className="form-note">{job.completedAt ? `Finished ${formatDate(job.completedAt)}` : `Next attempt ${formatDate(job.runAfter)}`}</p></td><td>{job.lastError && <p>{job.lastError.replaceAll("_", " ")}</p>}{job.status === "failed" && <RetryJob id={job.id} onAccepted={onRetry} />}{job.status === "succeeded" && <span>Completed by worker</span>}</td></tr>)}</tbody></table></div><Pager page={jobs.data.page} pages={Math.ceil(jobs.data.total / jobs.data.pageSize)} onPage={onPage} /></>}</PanelState></>;
}

function Imports({ path, revision, onRetry, onPage }: { path: string; revision: number; onRetry: () => void; onPage: (page: number) => void }) {
  const imports = useApi<ImportsData>(path, revision);
  return <PanelState loading={imports.loading} error={imports.error} onRetry={onRetry}>{imports.data && <>{imports.data.items.length === 0 && <EmptyAdminPage page={imports.data.page} total={imports.data.total} noun="committed import batches" onPage={onPage} />}<p className="muted">These batches committed to canonical storage. Validation issues describe retained uncertainty; queue acceptance alone does not create an entry here.</p><div className="page-stack">{imports.data.items.map((item) => <article className="metric-card" key={item.id}><h3>{actionLabels[item.action]}</h3><p className="form-note">Retrieved {formatDate(item.retrievedAt)} · Committed {formatDate(item.committedAt)}</p><p>{item.counts.fixtures} fixtures · {item.counts.appearances} appearances · {item.issueTotal} validation issues</p><p className="form-note code-value">Source revision {item.id}</p>{item.issueTotal > 0 && <details><summary>Inspect validation issues</summary><ul className="compact-list">{item.issues.map((issue, index) => <li key={index}><span>{issue.code.replaceAll("_", " ")}</span> · <span className="code-value">{issue.resource}</span></li>)}</ul>{item.issuesTruncated && <p className="form-note">Showing the first {item.issues.length} of {item.issueTotal} issues. The preview is bounded.</p>}</details>}</article>)}</div><Pager page={imports.data.page} pages={Math.ceil(imports.data.total / imports.data.pageSize)} onPage={onPage} /></>}</PanelState>;
}

function Evidence({ detail }: { detail: Record<string, unknown> }) {
  const states = ["before", "after"].flatMap((label) => {
    const value = detail[label];
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const state = value as Record<string, unknown>;
    const metrics = state.metrics;
    return [{ label, metrics: metrics && typeof metrics === "object" && !Array.isArray(metrics) ? metrics as Record<string, unknown> : null,
      status: typeof state.status === "string" ? state.status : null }];
  });
  if (!states.length && typeof detail.reason !== "string") return null;
  return <details><summary>View audit evidence</summary>{typeof detail.reason === "string" && <p>Reason: {detail.reason}</p>}{states.map(({ label, metrics, status }) => <div key={label}><h4>{label === "before" ? "Before" : "After"}</h4>{status && <p>{status}</p>}{metrics && <dl className="compact-list">{Object.entries(metrics).map(([key, value]) => <div key={key}><dt>{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt><dd>{value === null ? "Missing (null)" : String(value)}</dd></div>)}</dl>}</div>)}</details>;
}

function Audit({ path, revision, onRetry, onPage }: { path: string; revision: number; onRetry: () => void; onPage: (page: number) => void }) {
  const audit = useApi<AuditData>(path, revision);
  return <PanelState loading={audit.loading} error={audit.error} onRetry={onRetry}>{audit.data && <>{audit.data.items.length === 0 && <EmptyAdminPage page={audit.data.page} total={audit.data.total} noun="audit records" onPage={onPage} />}<div className="table-wrap"><table className="data-table"><caption>Committed audit trail · {audit.data.total} records</caption><thead><tr><th scope="col">Action</th><th scope="col">Actor</th><th scope="col">When</th><th scope="col">Evidence</th></tr></thead><tbody>{audit.data.items.map((entry) => <tr key={entry.id}><th scope="row">{entry.action}<p className="form-note">{entry.entityType} · {entry.entityKey}</p><p className="form-note code-value">{entry.id}</p></th><td>{entry.actorType}<p className="form-note code-value">{entry.actorId ?? "System"}</p></td><td>{formatDate(entry.occurredAt)}</td><td><Evidence detail={entry.detail} />{entry.revisionId && <p className="form-note code-value">Revision {entry.revisionId}</p>}</td></tr>)}</tbody></table></div><Pager page={audit.data.page} pages={Math.ceil(audit.data.total / audit.data.pageSize)} onPage={onPage} /></>}</PanelState>;
}

export function AdminDashboard({ initialPlayerId, initialFixtureId }: { initialPlayerId?: string; initialFixtureId?: string }) {
  const [revision, setRevision] = useState(0);
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const view = params.get("view") ?? "jobs";
  const page = params.get("page") ?? "1";
  const status = params.get("status") ?? "";
  const kind = params.get("kind") ?? "";
  const refresh = () => setRevision((current) => current + 1);
  function update(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "page") next.delete("page");
    if (key === "view") { next.delete("status"); next.delete("kind"); }
    router.replace(`${pathname}?${next}`, { scroll: false });
  }
  const listQuery = new URLSearchParams({ page, pageSize: "10" });
  if (view === "jobs") { if (status) listQuery.set("status", status); if (kind) listQuery.set("kind", kind); }
  const listProps = { path: `admin/${view}?${listQuery}`, revision, onRetry: refresh, onPage: (next: number) => update("page", String(next)) };
  return <div className="page-stack"><PageHeading eyebrow="Administrator" title="Operations" description="Review committed evidence, queue worker tasks, and make traceable corrections."><button className="button button-secondary" onClick={refresh}>Refresh operational views</button></PageHeading>
    <OperationalStatus revision={revision} onRetry={refresh} />
    <section aria-labelledby="queue-title"><h2 id="queue-title">Queue work</h2><div className="admin-grid"><QueueAction kind="import" onAccepted={refresh} /><QueueAction kind="forecast" onAccepted={refresh} /><StatisticsRequest onAccepted={refresh} /></div></section>
    <section className="panel" aria-labelledby="operations-history"><div className="panel-header"><h2 id="operations-history">Operational history</h2></div><div className="panel-body page-stack"><nav className="admin-tabs" aria-label="Operational history">{[["jobs", "Jobs"], ["imports", "Committed imports"], ["audit", "Audit trail"]].map(([key, label]) => <button key={key} type="button" className={`button button-small ${view === key ? "" : "button-secondary"}`} aria-current={view === key ? "page" : undefined} onClick={() => update("view", key)}>{label}</button>)}</nav>
      {view === "jobs" ? <Jobs {...listProps} status={status} kind={kind} onFilter={update} /> : view === "imports" ? <Imports {...listProps} /> : view === "audit" ? <Audit {...listProps} /> : <p role="alert">Unknown operational view. Choose Jobs, Committed imports, or Audit trail.</p>}
    </div></section>
    <AdminCorrection playerId={initialPlayerId} fixtureId={initialFixtureId} onSaved={refresh} />
  </div>;
}
