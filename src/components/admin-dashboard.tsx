"use client";

import { useState, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { AdminStatusData, AuditData, CompetitionsData, ImportsData, JobsData } from "@/lib/contracts";
import { useApi } from "@/lib/use-api";
import { formatDate, presentationText } from "@/lib/presentation";
import type { QueuedAdminCommand, RetriedAdminCommand } from "@/server/api/admin";
import { PageHeading, Pager, PanelState, StatusBadge } from "./ui";
import { CommandFeedback, useAdminCommand } from "./admin-command";
import { AdminCorrection } from "./admin-correction";

const kindLabels: Record<string, string> = { "source.sync": "Source import", "fixture.statistics": "Fixture statistics", "standings.rebuild": "Standings rebuild", "forecast.refresh": "Forecast refresh" };
const actionLabels: Record<string, string> = { get_events: "Fixtures and appearances", get_teams: "Clubs and rosters", get_statistics: "Fixture statistics", get_standings: "Standings reference", unknown: "Source action not recorded" };

function EmptyAdminPage({ page, total, noun, onPage }: { page: number; total: number; noun: string; onPage: (page: number) => void }) {
  return <section className="state-panel"><h3>No entries here.</h3><p>{total > 0 ? `${total} ${noun} on other pages.` : `No ${noun} in this view.`}</p>{page > 1 && <button type="button" className="button button-secondary" onClick={() => onPage(1)}>First page</button>}</section>;
}

function RequestReceipt({ result, forecast = false }: { result: QueuedAdminCommand; forecast?: boolean }) {
  return <details><summary>Request details</summary><p className="form-note">Request ID <span className="code-value">{result.requestId}</span></p><p className="form-note">Event ID <span className="code-value">{result.eventId}</span></p>{forecast && <p className="form-note">Refresh events may share a forecast job.</p>}</details>;
}

function QueueAction({ kind, onAccepted }: { kind: "import" | "forecast"; onAccepted: () => void }) {
  const forecast = kind === "forecast";
  const command = useAdminCommand<QueuedAdminCommand>(onAccepted);
  return <div className="metric-card"><h3>{forecast ? "Forecast refresh" : "Source import"}</h3>
    <p className="muted">{forecast ? "Saved data · Local evaluation" : "Approved coverage · Shared app budget"}</p>
    <button className="button button-secondary" disabled={command.pending} onClick={() => command.send(forecast ? "admin/forecasts/refresh" : "admin/imports")}>{command.pending ? "Submitting…" : command.uncertain ? `Retry same ${kind} request` : forecast ? "Queue forecast refresh" : "Queue source import"}</button>
    <CommandFeedback {...command}>{command.result && <><p>Accepted for processing. This confirms queue acceptance; it does not confirm completion.</p><RequestReceipt result={command.result} forecast={forecast} /></>}</CommandFeedback>
  </div>;
}

function StatisticsRequest({ onAccepted }: { onAccepted: () => void }) {
  const [leagueId, setLeagueId] = useState("");
  const [fixtureId, setFixtureId] = useState("");
  const competitions = useApi<CompetitionsData>("competitions");
  const selectedLeague = leagueId || competitions.data?.items[0]?.id || "";
  const command = useAdminCommand<QueuedAdminCommand>(onAccepted);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await command.send("admin/statistics", { leagueId: selectedLeague, fixtureId });
  }
  return <details className="metric-card"><summary>Fixture statistics</summary><form className="page-stack" onSubmit={submit}><h3>Request statistics</h3><p className="muted">Existing covered fixture · Live or final · Worker request</p>
    <PanelState loading={competitions.loading} error={competitions.error} />
    <div className="field-grid"><label className="field" htmlFor="statistics-league"><span className="field-label">Statistics competition</span><select id="statistics-league" className="field-select" required value={selectedLeague} disabled={command.locked || competitions.loading} onChange={(event) => setLeagueId(event.target.value)}>{!selectedLeague && <option value="">No competition available</option>}{competitions.data?.items.map((competition) => <option key={competition.id} value={competition.id}>{competition.name} · {competition.season}</option>)}</select></label>
      <label className="field" htmlFor="statistics-fixture"><span className="field-label">Statistics fixture ID</span><input id="statistics-fixture" className="field-input" maxLength={100} required value={fixtureId} disabled={command.locked} onChange={(event) => setFixtureId(event.target.value)} /></label></div>
    <button className="button button-secondary" disabled={command.pending || !selectedLeague || Boolean(competitions.error)}>{command.pending ? "Submitting…" : command.uncertain ? "Retry same statistics request" : "Queue fixture statistics"}</button>
    <CommandFeedback {...command}>{command.result && <><p>Queued. Check job status for completion.</p><RequestReceipt result={command.result} /></>}</CommandFeedback>
  </form></details>;
}

function RetryJob({ id, onAccepted }: { id: string; onAccepted: (result: RetriedAdminCommand) => void }) {
  const command = useAdminCommand<RetriedAdminCommand>(onAccepted);
  return <div><button type="button" className="button button-secondary button-small" disabled={command.pending} aria-label={`Retry job ${id}`} onClick={() => command.send(`admin/jobs/${id}/retry`)}>{command.pending ? "Submitting…" : command.uncertain ? "Retry same request" : "Retry failed job"}</button><CommandFeedback {...command} /></div>;
}

function OperationalStatus({ revision, onRetry }: { revision: number; onRetry: () => void }) {
  const status = useApi<AdminStatusData>("admin/status", revision);
  return <section aria-labelledby="operations-status"><h2 id="operations-status">At a glance</h2><PanelState loading={status.loading} error={status.error} onRetry={onRetry}>{status.data && <>
    <div className="metric-grid"><article className="metric-card"><p className="eyebrow">App request budget</p><strong className="metric-value">{status.data.providerBudget.remaining}<small> / {status.data.providerBudget.limit}</small></strong><p>Attempts left · Rolling {status.data.providerBudget.windowSeconds === 60 ? "minute" : "hour"}</p><p className="form-note">App cap; provider plan limits are separate.</p>{status.data.providerBudget.retryAt && <p className="form-note">Next opportunity: {formatDate(status.data.providerBudget.retryAt)}</p>}</article>
      <article className="metric-card"><p className="eyebrow">Committed imports</p><strong className="metric-value">{status.data.imports.batches}</strong><p>{status.data.imports.validationIssues} validation issues</p><p className="form-note">Latest: {formatDate(status.data.imports.lastCommittedAt)}</p></article>
      <article className="metric-card"><p className="eyebrow">Worker jobs</p><strong className="metric-value">{status.data.jobs.reduce((sum, job) => sum + (job.status === "ready" || job.status === "running" ? job.count : 0), 0)}</strong><p>Ready or running</p><p className="form-note">{status.data.jobs.reduce((sum, job) => sum + (job.status === "failed" ? job.count : 0), 0)} failed · Review required</p></article></div>
    <details className="provenance-details"><summary>Coverage details</summary><div className="table-wrap"><table className="data-table"><caption>Approved coverage in canonical storage</caption><thead><tr><th scope="col">Competition</th><th scope="col">Season</th><th scope="col">Fixtures</th><th scope="col">Final</th><th scope="col">Live/final stats incomplete</th></tr></thead><tbody>{status.data.coverage.map((item) => <tr key={item.leagueId}><th scope="row">{item.leagueName}</th><td>{item.season}</td><td>{item.fixtures}</td><td>{item.finalFixtures}</td><td>{item.incompleteStatistics}</td></tr>)}</tbody></table>{!status.data.coverage.length && <p className="muted">No approved coverage imported yet.</p>}</div></details>
  </>}</PanelState></section>;
}

function Jobs({ path, revision, onRetry, onPage, onFilter, status, kind }: { path: string; revision: number; onRetry: () => void; onPage: (page: number) => void; onFilter: (key: string, value: string) => void; status: string; kind: string }) {
  const jobs = useApi<JobsData>(path, revision);
  const [retryReceipt, setRetryReceipt] = useState<string | null>(null);
  const retryAccepted = (result: RetriedAdminCommand) => { setRetryReceipt(result.requestId); onRetry(); };
  return <><div className="field-grid"><label className="field" htmlFor="job-status"><span className="field-label">Job status</span><select id="job-status" className="field-select" value={status} onChange={(event) => onFilter("status", event.target.value)}><option value="">All statuses</option>{["ready", "running", "succeeded", "failed"].map((value) => <option key={value} value={value}>{value === "succeeded" ? "Completed" : value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
    <label className="field" htmlFor="job-kind"><span className="field-label">Job kind</span><select id="job-kind" className="field-select" value={kind} onChange={(event) => onFilter("kind", event.target.value)}><option value="">All jobs</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <CommandFeedback pending={false} uncertain={false}>{retryReceipt && <p key={retryReceipt}>Retry queued. Check job status for completion.</p>}</CommandFeedback>
    <PanelState loading={jobs.loading} error={jobs.error} onRetry={onRetry}>{jobs.data && <>{jobs.data.items.length === 0 && <EmptyAdminPage page={jobs.data.page} total={jobs.data.total} noun="jobs" onPage={onPage} />}<div className="table-wrap"><table className="data-table"><caption>Worker queue · {jobs.data.total} jobs</caption><thead><tr><th scope="col">Job</th><th scope="col">Status</th><th scope="col">Timing</th><th scope="col">Outcome / recovery</th></tr></thead><tbody>{jobs.data.items.map((job) => <tr key={job.id}><th scope="row">{kindLabels[job.kind]}<details><summary>Job details</summary><p className="form-note code-value">Job ID {job.id}</p>{job.outboxId && <p className="form-note code-value">Event ID {job.outboxId}</p>}{Object.keys(job.payload).length > 0 && <p className="form-note">Competition {job.payload.leagueId}{job.payload.fixtureId ? ` · Fixture ${job.payload.fixtureId}` : ""}</p>}</details></th><td><StatusBadge status={job.status} /><p className="form-note">Attempt {job.attempts} / {job.maxAttempts}</p></td><td><p className="form-note">Created {formatDate(job.createdAt)}</p><p className="form-note">{job.completedAt ? `Finished ${formatDate(job.completedAt)}` : `Next attempt ${formatDate(job.runAfter)}`}</p></td><td>{job.lastError && <p>{presentationText(job.lastError.replaceAll("_", " "))}</p>}{job.status === "failed" && <RetryJob id={job.id} onAccepted={retryAccepted} />}{job.status === "succeeded" && <span>Worker completed</span>}</td></tr>)}</tbody></table></div><Pager page={jobs.data.page} pages={Math.ceil(jobs.data.total / jobs.data.pageSize)} onPage={onPage} /></>}</PanelState></>;
}

function Imports({ path, revision, onRetry, onPage }: { path: string; revision: number; onRetry: () => void; onPage: (page: number) => void }) {
  const imports = useApi<ImportsData>(path, revision);
  return <PanelState loading={imports.loading} error={imports.error} onRetry={onRetry}>{imports.data && <>{imports.data.items.length === 0 && <EmptyAdminPage page={imports.data.page} total={imports.data.total} noun="committed import batches" onPage={onPage} />}<p className="muted">Committed batches · Validation issues retain uncertainty</p><details><summary>Import help</summary><p>Only committed canonical data appears here. Queued requests await worker completion.</p></details><div className="page-stack">{imports.data.items.map((item) => <article className="metric-card" key={item.id}><h3>{actionLabels[item.action]}</h3><p>{item.counts.fixtures} fixtures · {item.counts.appearances} appearances · {item.issueTotal} issues</p><details><summary>Source details</summary><p className="form-note">Retrieved {formatDate(item.retrievedAt)} · Committed {formatDate(item.committedAt)}</p><p className="form-note code-value">Source revision {item.id}</p></details>{item.issueTotal > 0 && <details><summary>Inspect validation issues</summary><ul className="compact-list">{item.issues.map((issue, index) => <li key={index}><span>{presentationText(issue.code.replaceAll("_", " "))}</span> · <span className="code-value">{presentationText(issue.resource)}</span></li>)}</ul>{item.issuesTruncated && <p className="form-note">Showing {item.issues.length} of {item.issueTotal} issues · Preview capped</p>}</details>}</article>)}</div><Pager page={imports.data.page} pages={Math.ceil(imports.data.total / imports.data.pageSize)} onPage={onPage} /></>}</PanelState>;
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
  return <details><summary>View audit evidence</summary>{typeof detail.reason === "string" && <p>Reason: {presentationText(detail.reason)}</p>}{states.map(({ label, metrics, status }) => <div key={label}><h4>{label === "before" ? "Before" : "After"}</h4>{status && <p>{presentationText(status)}</p>}{metrics && <dl className="compact-list">{Object.entries(metrics).map(([key, value]) => <div key={key}><dt>{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt><dd>{value === null ? "Missing (null)" : presentationText(String(value))}</dd></div>)}</dl>}</div>)}</details>;
}

function Audit({ path, revision, onRetry, onPage }: { path: string; revision: number; onRetry: () => void; onPage: (page: number) => void }) {
  const audit = useApi<AuditData>(path, revision);
  return <PanelState loading={audit.loading} error={audit.error} onRetry={onRetry}>{audit.data && <>{audit.data.items.length === 0 && <EmptyAdminPage page={audit.data.page} total={audit.data.total} noun="audit records" onPage={onPage} />}<div className="table-wrap"><table className="data-table"><caption>Committed audit trail · {audit.data.total} records</caption><thead><tr><th scope="col">Action</th><th scope="col">Actor</th><th scope="col">When</th><th scope="col">Evidence</th></tr></thead><tbody>{audit.data.items.map((entry) => <tr key={entry.id}><th scope="row">{entry.action}<details><summary>Record details</summary><p className="form-note">{entry.entityType} · <span className="code-value">{entry.entityKey}</span></p><p className="form-note code-value">Audit ID {entry.id}</p>{entry.revisionId && <p className="form-note code-value">Revision {entry.revisionId}</p>}</details></th><td>{entry.actorType}{entry.actorId ? <details><summary>Actor ID</summary><p className="form-note code-value">{entry.actorId}</p></details> : <p className="form-note">System</p>}</td><td>{formatDate(entry.occurredAt)}</td><td><Evidence detail={entry.detail} /></td></tr>)}</tbody></table></div><Pager page={audit.data.page} pages={Math.ceil(audit.data.total / audit.data.pageSize)} onPage={onPage} /></>}</PanelState>;
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
  return <div className="page-stack"><PageHeading eyebrow="Administrator" title="Operations"><button className="button button-secondary" aria-label="Refresh operational views" onClick={refresh}>Refresh</button></PageHeading>
    <OperationalStatus revision={revision} onRetry={refresh} />
    <section aria-labelledby="queue-title"><h2 id="queue-title">Queue work</h2><div className="admin-grid"><QueueAction kind="import" onAccepted={refresh} /><QueueAction kind="forecast" onAccepted={refresh} /><StatisticsRequest onAccepted={refresh} /></div></section>
    <section className="panel" aria-labelledby="operations-history"><div className="panel-header"><h2 id="operations-history">History</h2></div><div className="panel-body page-stack"><nav className="admin-tabs" aria-label="Operational history">{[["jobs", "Jobs"], ["imports", "Committed imports"], ["audit", "Audit trail"]].map(([key, label]) => <button key={key} type="button" className={`button button-small ${view === key ? "" : "button-secondary"}`} aria-current={view === key ? "page" : undefined} onClick={() => update("view", key)}>{label}</button>)}</nav>
      {view === "jobs" ? <Jobs {...listProps} status={status} kind={kind} onFilter={update} /> : view === "imports" ? <Imports {...listProps} /> : view === "audit" ? <Audit {...listProps} /> : <p role="alert">Unknown operational view. Choose Jobs, Committed imports, or Audit trail.</p>}
    </div></section>
    <AdminCorrection playerId={initialPlayerId} fixtureId={initialFixtureId} onSaved={refresh} />
  </div>;
}
