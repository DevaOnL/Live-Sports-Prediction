"use client";

import Link from "next/link";
import { useState } from "react";
import type { ClubsData, PlayerData } from "@/lib/contracts";
import { forecastNotices } from "@/lib/forecast-presentation";
import { formatDate, formatNumber, metricLabel, positionLabel, reasonText } from "@/lib/presentation";
import { useApi } from "@/lib/use-api";
import { useObservationTime } from "@/lib/use-observation-time";
import type { Metric } from "@/server/forecast/types";
import { EvidenceProvenance, ForecastView } from "./forecast-view";
import { useSelection } from "./selection";
import { PageHeading, PanelState, SourceNote, StatusBadge } from "./ui";
import { useIdentity } from "./workspace-shell";

export function PlayerDetail({ id }: { id: string }) {
  const [revision, setRevision] = useState(0);
  const detail = useApi<PlayerData>(`players/${encodeURIComponent(id)}`, revision);
  const clubs = useApi<ClubsData>("clubs", revision);
  const { selected, toggle } = useSelection();
  const identity = useIdentity();
  const data = detail.data;
  const now = useObservationTime(data?.source.cutoffAt);
  const inComparison = selected.some((player) => player.id === id);
  const forecast = data?.forecast;
  const notices = data && forecast ? forecastNotices(forecast, data.source, now ?? data.source.cutoffAt) : [];
  const metrics: Metric[] = ["goals", "assists", "shotsOnTarget", "keyPasses", "tackles", "interceptions", "saves", "goalsConceded"];
  return <>
    <Link href="/players" className="text-link">← All players</Link>
    <PageHeading eyebrow="Player profile" title={data?.player.name ?? "Player detail"} description={data ? `${positionLabel[data.player.position]} · ${data.player.currentClub?.name ?? "Current club unavailable"}` : "Observed performance and explainable forecasts."}>
      <button className="button button-secondary" onClick={() => setRevision((value) => value + 1)}>Refresh player data</button>
      {data && <button className="button" onClick={() => toggle(data.player)} disabled={!inComparison && selected.length >= 4} aria-label={`${inComparison ? "Remove" : "Add"} ${data.player.name} ${inComparison ? "from" : "to"} comparison`}>{inComparison ? "Remove from comparison" : "Add to comparison"}</button>}
    </PageHeading>
    <PanelState loading={detail.loading} error={detail.error} onRetry={() => setRevision((value) => value + 1)}>
      {data && <div className="stack">
        <div className="profile-meta"><StatusBadge status={data.player.forecast.status} /><span className="muted">Last stored evaluation</span><Link className="text-link" href="/compare">Open comparison ({selected.length}/4) →</Link></div>
        {!inComparison && selected.length >= 4 && <p className="notice">Your comparison already has four players. Remove one on the comparison page to add another.</p>}
        {!data.player.currentClub && <div className="notice"><p>Current club could not be established.</p><ul className="reason-list">{data.player.currentClubReasons.map((code) => <li key={code}>{reasonText({ code })}</li>)}</ul></div>}
        <SourceNote source={data.source} />
        {clubs.error !== undefined && <div className="notice" role="status">Club names could not be loaded. Club identifiers remain visible. <button className="text-button" onClick={() => setRevision((value) => value + 1)}>Retry club names</button></div>}
        {forecast ? <>
          <section className="panel forecast-evaluation" aria-label="Forecast evaluation">
            <div className="section-heading"><div><p className="eyebrow">Saved model result</p><h2>Form & forecast</h2></div><StatusBadge status={forecast.result.status} /></div>
            <dl className="data-list"><div><dt>Evaluated as of</dt><dd>{formatDate(forecast.evaluation.cutoffAt)}</dd></div><div><dt>Last checked</dt><dd>{formatDate(forecast.evaluation.checkedAt)}</dd></div><div><dt>Saved revision created</dt><dd>{formatDate(forecast.createdAt)}</dd></div><div><dt>Model</dt><dd>{forecast.modelVersion}</dd></div></dl>
            <p className="muted">These are stored results. Forecasts refresh asynchronously after source or clock changes; matching source watermarks alone do not establish freshness.</p>
            {notices.map((notice) => <p className="notice notice-warning" key={notice}>{notice}</p>)}
            {forecast.input.player.position !== data.player.position && <p className="notice notice-warning">This saved evaluation used position {positionLabel[forecast.input.player.position]}. The current player position is {positionLabel[data.player.position]}.</p>}
          </section>
          <ForecastView input={forecast.input} result={forecast.result} clubs={clubs.data?.items ?? []} />
          <details className="panel provenance-details"><summary>Revision and source evidence</summary>
            <dl className="data-list"><div><dt>Saved revision</dt><dd className="identifier">{forecast.id}</dd></div><div><dt>Revision cutoff</dt><dd>{formatDate(forecast.cutoffAt)}</dd></div><div><dt>Revision source watermark</dt><dd>{forecast.sourceOrdinal}</dd></div><div><dt>Evaluation source watermark</dt><dd>{forecast.evaluation.sourceOrdinal}</dd></div><div><dt>Current read watermark</dt><dd>{data.source.sourceOrdinal}</dd></div><div><dt>Canonical input hash</dt><dd className="identifier">{forecast.inputHash}</dd></div></dl>
            <p className="muted">A later check can retain the same immutable revision when the model inputs have the same meaning. Historical context is reconstructed from corrected canonical results.</p>
            <h3>Saved revision evidence</h3><EvidenceProvenance provenance={forecast.provenance} />
            <h3>Latest evaluation evidence</h3><EvidenceProvenance provenance={forecast.evaluation.provenance} />
          </details>
        </> : <section className="panel"><p className="eyebrow">Forecast not computed</p><h2>No saved evaluation yet</h2><p className="muted">Observed performance is available below. A worker forecast refresh must complete before a saved five-match window and model outputs can be shown.</p></section>}
        <section className="detail-section" aria-labelledby="observed-title">
          <div className="section-heading"><div><p className="eyebrow">Reported performance</p><h2 id="observed-title">Observed appearances</h2></div><span className="muted">Latest {data.observedLimit} at most</span></div>
          <p className="muted">Current reported observations, separate from the model input above. Ratings use 0–10; statistics are match counts. A dash means missing data. Reported minutes may exceed 90.</p>
          {data.observedAppearances.length ? <div className="table-wrap"><table className="data-table"><caption className="sr-only">Recent observed appearances and reported match statistics</caption><thead><tr><th scope="col">Fixture</th><th scope="col">Participation</th><th scope="col">Minutes</th><th scope="col">Rating / 10</th>{metrics.map((metric) => <th scope="col" key={metric}>{metricLabel[metric]}</th>)}{identity?.role === "admin" && <th scope="col">Correction</th>}</tr></thead><tbody>{data.observedAppearances.map((appearance) => <tr key={appearance.fixtureId}>
            <th scope="row"><strong>{appearance.homeClub.name} vs {appearance.awayClub.name}</strong><span>{formatDate(appearance.kickoffAt)}</span><span>Fixture {appearance.fixtureId} · {appearance.status} · statistics {appearance.statisticsStatus}</span></th>
            <td>{appearance.participation === "dnp" ? "Did not play" : appearance.participation === "played" ? "Played" : "Unknown"}</td><td>{formatNumber(appearance.minutes, 0)}</td><td>{formatNumber(appearance.rating)}</td>{metrics.map((metric) => <td key={metric}>{formatNumber(appearance.metrics[metric], 0)}</td>)}{identity?.role === "admin" && <td><Link className="text-link" href={`/admin?playerId=${encodeURIComponent(data.player.id)}&fixtureId=${encodeURIComponent(appearance.fixtureId)}`} aria-label={`Review correction for fixture ${appearance.fixtureId}`}>Review correction</Link></td>}
          </tr>)}</tbody></table></div> : <div className="notice">No observed appearances are stored for this player in enabled coverage.</div>}
        </section>
      </div>}
    </PanelState>
  </>;
}
