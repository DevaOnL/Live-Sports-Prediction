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
import { EvidenceProvenance, ForecastView, ReasonList } from "./forecast-view";
import { useSelection } from "./selection";
import { PageHeading, PanelState, SourceNote, StatusBadge } from "./ui";

function ComparisonValue({ output, unit }: { output: Output; unit: string }) {
  return <><strong className="comparison-value">{output.status === "available" ? formatNumber(output.value) : "—"}</strong><span className="metric-unit">{unit}</span><StatusBadge status={output.status} /><ReasonList reasons={output.reasons} /></>;
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
    <PageHeading eyebrow="Side by side" title="Compare the evidence." description="Choose two to four players. Every result is evaluated together at one cutoff and source snapshot.">
      <Link className="button button-secondary" href="/players">Choose players</Link>
      {initialIds.length > 0 && <button className="button button-secondary" onClick={() => setRevision((value) => value + 1)}>Refresh comparison</button>}
    </PageHeading>
    <section className="panel comparison-options" aria-label="Comparison options">
      <div><h2>Your comparison</h2><p className="muted">Add players from the catalogue or a player profile. The selection tray holds up to four players.</p></div>
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
      <p className="muted">Same-position comparison is the default. Opting in keeps rating and form separate and shows only shared projected statistics with matching units.</p>
      <div className="action-row"><button className="button" onClick={compareSelected} disabled={selected.length < 2}>Compare selected players</button><span className="muted">{selected.length} of 4 players selected</span></div>
      {initialIds.length > 0 && differentSelection && <p className="notice">The result below uses the player identifiers in this page URL. Use “Compare selected players” to apply the selection tray.</p>}
    </section>
    {!initialIds.length && <section className="state-panel"><p className="eyebrow">Start with two players</p><h2>Build your comparison</h2><p>Browse players and choose “Add to comparison”. You can compare up to four players at once.</p><Link className="text-link" href="/players">Explore players →</Link></section>}
    <PanelState loading={comparison.loading} error={comparison.error} onRetry={() => setRevision((value) => value + 1)}>
      {data && <div className="stack">
        <SourceNote source={data.source} />
        <div className="notice"><p><strong>One aligned evaluation.</strong> Cutoff {formatDate(data.cutoffAt)} · source revision {data.sourceOrdinal}. These results are calculated from this read snapshot and do not create saved forecast revisions.</p></div>
        {notices.length > 0 && <div role="status" aria-live="polite">{notices.map((notice) => <p className="notice notice-warning" key={notice}>{notice}</p>)}</div>}
        {data.notice && <div className="notice notice-warning" role="status">{data.notice}</div>}
        {data.sharedMetrics.length === 0 && <p className="notice">These positions have no shared projected count statistics. Forecast ratings and adjusted form indexes are shown separately.</p>}
        {clubs.error !== undefined && <div className="notice" role="status">Club names could not be loaded; club identifiers remain visible. <button className="text-button" onClick={() => setRevision((value) => value + 1)}>Retry club names</button></div>}
        <section aria-label="Aligned comparison results">
          <div className="table-wrap"><table className="data-table comparison-table"><caption className="sr-only">Aligned player forecasts and adjusted form indexes, with explicit units and availability</caption><thead><tr><th scope="col">Measure</th>{data.players.map(({ player }) => <th scope="col" key={player.id}><Link className="text-link" href={`/players/${player.id}`}>{player.name}</Link><span>{positionLabel[player.position]}</span></th>)}</tr></thead><tbody>
            <tr><th scope="row">Forecast rating <span>0–10</span></th>{data.players.map((item) => <td key={item.player.id}><ComparisonValue output={item.result.forecastRating} unit="/ 10" /></td>)}</tr>
            <tr><th scope="row">Adjusted form index <span>0–100 model index</span></th>{data.players.map((item) => <td key={item.player.id}><ComparisonValue output={item.result.adjustedFormIndex} unit="/ 100" /></td>)}</tr>
            {data.sharedMetrics.map((metric) => <tr key={metric}><th scope="row">{metricLabel[metric]}<span>Projected per 90 minutes</span></th>{data.players.map((item) => <td key={item.player.id}><ComparisonValue output={item.result.projected90[metric]!} unit="per 90 minutes" /></td>)}</tr>)}
          </tbody></table></div>
          <p className="muted">Decimal projections assume 90 minutes of play. They do not predict playing time or guaranteed counts. A dash represents an unavailable output, never zero.</p>
        </section>
        <div className="comparison-grid">{data.players.map((item) => <article className="panel comparison-card" key={item.player.id} aria-label={`Evidence for ${item.player.name}`}>
          <header className="comparison-player"><p className="eyebrow">{positionLabel[item.player.position]}</p><h2><Link href={`/players/${item.player.id}`}>{item.player.name}</Link></h2><p className="muted">{item.player.currentClub?.name ?? "Current club unavailable"}</p></header>
          {item.canonicalStatus !== item.result.status && <div className="notice"><p>Shown metrics: <StatusBadge status={item.result.status} /></p><p>Full position model: <StatusBadge status={item.canonicalStatus} /></p><p className="muted">The complete model includes statistics outside this comparison. Its availability and input hash describe that full evaluation.</p></div>}
          <ForecastView input={item.input} result={item.result} clubs={clubs.data?.items ?? []} compact />
          <details className="provenance-details"><summary>Comparison and revision evidence</summary><dl className="data-list"><div><dt>Shared cutoff</dt><dd>{formatDate(data.cutoffAt)}</dd></div><div><dt>Source revision</dt><dd>{data.sourceOrdinal}</dd></div><div><dt>Canonical input hash</dt><dd className="identifier">{item.canonicalInputHash}</dd></div><div><dt>Full model availability</dt><dd><StatusBadge status={item.canonicalStatus} /></dd></div><div><dt>Prior saved revision</dt><dd className="identifier">{item.storedRevision?.id ?? "No saved revision"}</dd></div>{item.storedRevision && <div><dt>Saved revision cutoff</dt><dd>{formatDate(item.storedRevision.cutoffAt)}</dd></div>}</dl><EvidenceProvenance provenance={item.provenance} /><p className="muted">The prior saved revision is historical evidence. The comparison above uses the current canonical input at the shared cutoff.</p></details>
        </article>)}</div>
      </div>}
    </PanelState>
  </>;
}
