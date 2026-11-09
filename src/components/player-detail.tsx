"use client";

import Link from "next/link";
import { useState } from "react";
import type { ClubsData, PlayerData } from "@/lib/contracts";
import { forecastNotices } from "@/lib/forecast-presentation";
import { formatDate, formatNumber, metricLabel, positionLabel, reasonText } from "@/lib/presentation";
import { useApi } from "@/lib/use-api";
import { useObservationTime } from "@/lib/use-observation-time";
import type { Metric } from "@/server/forecast/types";
import { PlayerArtwork } from "./football-art";
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
    {data ? <header className="profile-hero">
      <PlayerArtwork position={data.player.position} className="profile-art" />
      <div className="profile-copy"><p className="eyebrow">Player profile · {positionLabel[data.player.position]}</p><h1>{data.player.name}</h1><p>{data.player.currentClub?.name ?? "Current club unavailable"}</p><div className="profile-meta"><StatusBadge status={data.player.forecast.status} /><span className="compact-note">Saved evaluation</span></div>
        <div className="action-row profile-actions"><button className="button" onClick={() => toggle(data.player)} disabled={!inComparison && selected.length >= 4} aria-label={`${inComparison ? "Remove" : "Add"} ${data.player.name} ${inComparison ? "from" : "to"} comparison`}>{inComparison ? "Remove from comparison" : "Add to comparison"}</button><button className="button button-secondary" onClick={() => setRevision((value) => value + 1)}>Refresh player data</button><Link className="text-link" href="/compare">Comparison ({selected.length}/4) →</Link></div>
      </div>
    </header> : <PageHeading eyebrow="Player profile" title="Player detail" />}
    <PanelState loading={detail.loading} error={detail.error} onRetry={() => setRevision((value) => value + 1)}>
      {data && <div className="stack">
        {!inComparison && selected.length >= 4 && <p className="notice">Comparison full · remove a player to add this one.</p>}
        {!data.player.currentClub && <div className="notice notice-warning"><strong>{data.player.currentClubReasons.includes("ambiguous_current_club") ? "Club conflict" : "Current club unconfirmed"}</strong><details className="provenance-details"><summary>Club evidence</summary><ul className="reason-list">{data.player.currentClubReasons.map((code) => <li key={code}>{reasonText({ code })}</li>)}</ul></details></div>}
        {clubs.error !== undefined && <div className="notice" role="status">Club names unavailable · IDs shown. <button className="text-button" onClick={() => setRevision((value) => value + 1)}>Retry club names</button></div>}
        {forecast ? <>
          <section className="panel forecast-evaluation" aria-label="Forecast evaluation">
            <div className="section-heading"><div><p className="eyebrow">Saved model result</p><h2>Form & forecast</h2></div><StatusBadge status={forecast.result.status} /></div>
            <p className="compact-note">Evaluated {formatDate(forecast.evaluation.cutoffAt)}</p>
            {notices.length > 0 && <div className="notice notice-warning" role="status"><div className="profile-meta">{notices.map((notice) => <span className="badge badge-partial" key={notice}>{notice.startsWith("Source data") ? "Source changed" : notice.startsWith("The saved target") ? "Target passed" : "Evaluation over 15 min old"}</span>)}</div><details className="provenance-details"><summary>Freshness details</summary>{notices.map((notice) => <p key={notice}>{notice}</p>)}</details></div>}
            {forecast.input.player.position !== data.player.position && <p className="notice notice-warning">Position changed · saved {positionLabel[forecast.input.player.position]}, current {positionLabel[data.player.position]}</p>}
          </section>
          <ForecastView input={forecast.input} result={forecast.result} clubs={clubs.data?.items ?? []} />
          <details className="panel provenance-details"><summary>Revision and source evidence</summary>
            <SourceNote source={data.source} />
            <dl className="data-list"><div><dt>Saved revision</dt><dd className="identifier">{forecast.id}</dd></div><div><dt>Model</dt><dd>{forecast.modelVersion}</dd></div><div><dt>Last checked</dt><dd>{formatDate(forecast.evaluation.checkedAt)}</dd></div><div><dt>Revision created</dt><dd>{formatDate(forecast.createdAt)}</dd></div><div><dt>Revision cutoff</dt><dd>{formatDate(forecast.cutoffAt)}</dd></div><div><dt>Revision source watermark</dt><dd>{forecast.sourceOrdinal}</dd></div><div><dt>Evaluation source watermark</dt><dd>{forecast.evaluation.sourceOrdinal}</dd></div><div><dt>Current read watermark</dt><dd>{data.source.sourceOrdinal}</dd></div><div><dt>Canonical input hash</dt><dd className="identifier">{forecast.inputHash}</dd></div></dl>
            <p>Refresh is asynchronous. Equal source watermarks do not prove freshness. A later check can retain an immutable revision when inputs have the same meaning; historical context uses corrected canonical results.</p>
            <h3>Saved revision evidence</h3><EvidenceProvenance provenance={forecast.provenance} />
            <h3>Latest evaluation evidence</h3><EvidenceProvenance provenance={forecast.evaluation.provenance} />
          </details>
        </> : <section className="panel"><p className="eyebrow">Forecast not computed</p><h2>No saved evaluation yet</h2><p className="compact-note">Current observations below.</p><details className="provenance-details"><summary>Source evidence</summary><SourceNote source={data.source} /></details></section>}
        <details className="panel provenance-details observed-details">
          <summary>Observed appearances</summary>
          <section className="detail-section" aria-labelledby="observed-title">
            <div className="section-heading"><div><p className="eyebrow">Current reported data</p><h2 id="observed-title">Observed appearances</h2></div><span className="muted">Up to {data.observedLimit}</span></div>
            <p className="compact-note">Separate from model input · rating / 10 · match counts · — missing · minutes may exceed 90</p>
            {data.observedAppearances.length ? <div className="table-wrap"><table className="data-table"><caption className="sr-only">Recent observed appearances and reported match statistics</caption><thead><tr><th scope="col">Fixture</th><th scope="col">Participation</th><th scope="col">Minutes</th><th scope="col">Rating / 10</th>{metrics.map((metric) => <th scope="col" key={metric}>{metricLabel[metric]}</th>)}{identity?.role === "admin" && <th scope="col">Correction</th>}</tr></thead><tbody>{data.observedAppearances.map((appearance) => <tr key={appearance.fixtureId}>
              <th scope="row"><strong>{appearance.homeClub.name} vs {appearance.awayClub.name}</strong><span>{formatDate(appearance.kickoffAt)}</span><span>Fixture {appearance.fixtureId} · {appearance.status} · statistics {appearance.statisticsStatus}</span></th>
              <td>{appearance.participation === "dnp" ? "Did not play" : appearance.participation === "played" ? "Played" : "Unknown"}</td><td>{formatNumber(appearance.minutes, 0)}</td><td>{formatNumber(appearance.rating)}</td>{metrics.map((metric) => <td key={metric}>{formatNumber(appearance.metrics[metric], 0)}</td>)}{identity?.role === "admin" && <td><Link className="text-link" href={`/admin?playerId=${encodeURIComponent(data.player.id)}&fixtureId=${encodeURIComponent(appearance.fixtureId)}`} aria-label={`Review correction for fixture ${appearance.fixtureId}`}>Review correction</Link></td>}
            </tr>)}</tbody></table></div> : <div className="notice">No observed appearances stored in enabled coverage.</div>}
          </section>
        </details>
      </div>}
    </PanelState>
  </>;
}
