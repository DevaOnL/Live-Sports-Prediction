"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ClubsData, ComparisonData } from "@/lib/contracts";
import { formatDate, formatNumber, metricLabel, positionLabel } from "@/lib/presentation";
import { comparisonNotices } from "@/lib/forecast-presentation";
import { useApi } from "@/lib/use-api";
import { useObservationTime } from "@/lib/use-observation-time";
import type { Output } from "@/server/forecast/types";
import { MetricIcon, PlayerArtwork } from "./football-art";
import { EvidenceProvenance, ForecastView, ReasonList } from "./forecast-view";
import { useSelection } from "./selection";
import { PageHeading, PanelState, SourceNote, StatusBadge } from "./ui";

function ComparisonValue({ output, unit }: { output: Output; unit: string }) {
  return <><strong className="comparison-value">{output.status === "available" ? formatNumber(output.value) : "—"}</strong><span className="metric-unit">{unit}</span><StatusBadge status={output.status} />{output.reasons.length > 0 && <details className="provenance-details"><summary>Why unavailable</summary><ReasonList reasons={output.reasons} /></details>}</>;
}

export function Comparison({ initialIds = [], initialCrossPosition = false }: { initialIds?: string[]; initialCrossPosition?: boolean }) {
  const router = useRouter();
  const { selected, replace } = useSelection();
  const hydrated = useRef(false);
  const [allowCrossPosition, setAllowCrossPosition] = useState(initialCrossPosition);
  const [revision, setRevision] = useState(0);
  const params = new URLSearchParams();
  initialIds.forEach((id) => params.append("playerId", id));
  if (allowCrossPosition) params.set("allowCrossPosition", "true");
  const comparison = useApi<ComparisonData>(initialIds.length ? `compare?${params}` : null, revision);
  const clubs = useApi<ClubsData>("clubs", revision);
  const data = comparison.data;
  const now = useObservationTime(data?.cutoffAt);
  const notices = data ? comparisonNotices(data, now ?? data.cutoffAt) : [];
  useEffect(() => {
    if (data && !hydrated.current) {
      hydrated.current = true;
      replace(data.players.map(({ player }) => player));
    }
  }, [data, replace]);
  const differentSelection = initialIds.join(",") !== selected.map((player) => player.id).join(",");
  function compareSelected() {
    const query = new URLSearchParams();
    selected.forEach((player) => query.append("playerId", player.id));
    if (allowCrossPosition) query.set("allowCrossPosition", "true");
    router.push(`/compare?${query}`);
    setRevision((value) => value + 1);
  }
  return <>
    <PageHeading eyebrow="Side by side · 2–4 players" title="Compare the evidence.">
      <Link className="button button-secondary" href="/players">Choose players</Link>
      {initialIds.length > 0 && <button className="button button-secondary" onClick={() => setRevision((value) => value + 1)}>Refresh comparison</button>}
    </PageHeading>
    <section className="panel comparison-options" aria-label="Comparison options">
      <div><h2>Your comparison</h2><span className="compact-note">{selected.length} of 4 selected</span></div>
      <label className="checkbox-field"><input type="checkbox" checked={allowCrossPosition} onChange={(event) => {
        const next = event.target.checked;
        setAllowCrossPosition(next);
        if (initialIds.length) {
          const query = new URLSearchParams();
          initialIds.forEach((id) => query.append("playerId", id));
          if (next) query.set("allowCrossPosition", "true");
          router.replace(`/compare?${query}`);
        }
      }} />Allow cross-position comparison</label>
      <button className="button" onClick={compareSelected} disabled={selected.length < 2}>Compare selected players</button>
      <details className="provenance-details"><summary>Comparison rules</summary><p>Same position by default. Cross-position opt-in shows shared count statistics with matching per-90 units. Rating and adjusted form stay separate. Select two to four players from the catalogue or profiles.</p></details>
      {initialIds.length > 0 && differentSelection && <p className="notice">Selection changed · use “Compare selected players” to update these results.</p>}
    </section>
    {!initialIds.length && <section className="state-panel"><p className="eyebrow">Start with two players</p><h2>Build your comparison</h2><Link className="button" href="/players">Choose players →</Link></section>}
    <PanelState loading={comparison.loading} error={comparison.error} onRetry={() => setRevision((value) => value + 1)}>
      {data && <div className="stack">
        <div className="comparison-summary"><span className="badge badge-available">One aligned snapshot</span><span className="compact-note">{formatDate(data.cutoffAt)} · source {data.sourceOrdinal}</span><details className="provenance-details"><summary>Snapshot evidence</summary><SourceNote source={data.source} /><p>Calculated together from this read snapshot. These results do not create saved forecast revisions.</p></details></div>
        {notices.length > 0 && <div className="notice notice-warning" role="status" aria-live="polite"><div className="profile-meta">{notices.map((notice) => <span className="badge badge-partial" key={notice}>{notice.startsWith("A target") ? "Target passed · refresh" : "Snapshot over 15 min old"}</span>)}</div><details className="provenance-details"><summary>Freshness details</summary>{notices.map((notice) => <p key={notice}>{notice}</p>)}</details></div>}
        {data.notice && <div className="notice notice-warning" role="status"><strong>Cross-position · shared metrics only</strong><details className="provenance-details"><summary>Cross-position details</summary><p>{data.notice}</p></details></div>}
        {data.sharedMetrics.length === 0 && <p className="notice">No shared count statistics · rating & form shown separately.</p>}
        {clubs.error !== undefined && <div className="notice" role="status">Club names unavailable · IDs shown. <button className="text-button" onClick={() => setRevision((value) => value + 1)}>Retry club names</button></div>}
        <section aria-label="Aligned comparison results">
          <div className="table-wrap"><table className="data-table comparison-table"><caption className="sr-only">Aligned player forecasts and adjusted form indexes, with explicit units and availability</caption><thead><tr><th scope="col">Measure</th>{data.players.map(({ player }) => <th scope="col" key={player.id}><PlayerArtwork position={player.position} className="comparison-art" /><Link className="text-link" href={`/players/${player.id}`}>{player.name}</Link><span>{positionLabel[player.position]}</span></th>)}</tr></thead><tbody>
            <tr><th scope="row"><MetricIcon metric="rating" />Forecast rating <span>0–10</span></th>{data.players.map((item) => <td key={item.player.id}><ComparisonValue output={item.result.forecastRating} unit="/ 10" /></td>)}</tr>
            <tr><th scope="row"><MetricIcon metric="form" />Adjusted form index <span>0–100 model index</span></th>{data.players.map((item) => <td key={item.player.id}><ComparisonValue output={item.result.adjustedFormIndex} unit="/ 100" /></td>)}</tr>
            {data.sharedMetrics.map((metric) => <tr key={metric}><th scope="row"><MetricIcon metric={metric} />{metricLabel[metric]}<span>Projected per 90 minutes</span></th>{data.players.map((item) => <td key={item.player.id}><ComparisonValue output={item.result.projected90[metric]!} unit="per 90 minutes" /></td>)}</tr>)}
          </tbody></table></div>
          <p className="compact-note">Per 90 minutes assumed · — unavailable · 0 is zero</p>
          <details className="provenance-details"><summary>Units & model limits</summary><p>Per-90 projections are decimal estimates, not guaranteed counts or predicted playing time. Rating uses 0–10; form is a separate 0–100 model index. This heuristic has no established predictive accuracy.</p></details>
        </section>
        <div className="comparison-grid">{data.players.map((item) => <article className="panel comparison-card" key={item.player.id} aria-label={`Evidence for ${item.player.name}`}>
          <header className="comparison-player"><p className="eyebrow">{positionLabel[item.player.position]}</p><h2><Link href={`/players/${item.player.id}`}>{item.player.name}</Link></h2><p className="compact-note">{item.player.currentClub?.name ?? "Current club unavailable"}</p></header>
          <div className="profile-meta"><StatusBadge status={item.result.status} /><StatusBadge status={item.result.historyStatus} /><span className="minutes-tag">{item.result.selected.length} of 5 selected</span></div>
          {!item.result.target && <p className="notice notice-warning">No future target</p>}
          {item.input.rosterReasons.some((reason) => reason.code === "ambiguous_current_club") && <p className="notice notice-warning">Club conflict</p>}
          {item.result.target && <p className="compact-note">Target {formatDate(item.result.target.kickoffAt)}</p>}
          {item.canonicalStatus !== item.result.status && <div className="notice"><span>Shown metrics: <StatusBadge status={item.result.status} /></span><span>Full position model: <StatusBadge status={item.canonicalStatus} /></span></div>}
          <details className="provenance-details"><summary>Selected matches & forecast evidence</summary><ForecastView input={item.input} result={item.result} clubs={clubs.data?.items ?? []} compact /></details>
          <details className="provenance-details"><summary>Comparison and revision evidence</summary><dl className="data-list"><div><dt>Shared cutoff</dt><dd>{formatDate(data.cutoffAt)}</dd></div><div><dt>Source revision</dt><dd>{data.sourceOrdinal}</dd></div><div><dt>Canonical input hash</dt><dd className="identifier">{item.canonicalInputHash}</dd></div><div><dt>Full model availability</dt><dd><StatusBadge status={item.canonicalStatus} /></dd></div><div><dt>Prior saved revision</dt><dd className="identifier">{item.storedRevision?.id ?? "No saved revision"}</dd></div>{item.storedRevision && <div><dt>Saved revision cutoff</dt><dd>{formatDate(item.storedRevision.cutoffAt)}</dd></div>}</dl><EvidenceProvenance provenance={item.provenance} /><p>The comparison uses current canonical inputs at the shared cutoff. Full-model availability and hash also cover statistics outside this comparison. Prior saved revisions are historical evidence.</p></details>
        </article>)}</div>
      </div>}
    </PanelState>
  </>;
}
