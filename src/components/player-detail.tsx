"use client";

import Link from "next/link";
import { useState } from "react";
import type { ClubsData, PlayerData } from "@/lib/contracts";
import { forecastNotices, hasForecastOutputs, hasRecordedValue } from "@/lib/forecast-presentation";
import { formatDate, formatNumber, metricLabel, positionLabel, reasonText } from "@/lib/presentation";
import { useApi } from "@/lib/use-api";
import { useObservationTime } from "@/lib/use-observation-time";
import type { Metric } from "@/server/forecast/types";
import { PlayerArtwork } from "./football-art";
import { BestStatisticView } from "./best-statistic";
import { EvidenceProvenance, ForecastView } from "./forecast-view";
import { useSelection } from "./selection";
import { PageHeading, PanelState, SourceNote, StatusBadge } from "./ui";
import { useIdentity } from "./workspace-shell";
import { HiddenDataButton, useDataVisibility } from "./data-visibility";

export function PlayerDetail({ id }: { id: string }) {
  const [revision, setRevision] = useState(0);
  const detail = useApi<PlayerData>(`players/${encodeURIComponent(id)}`, revision);
  const clubs = useApi<ClubsData>("clubs", revision);
  const { selected, toggle } = useSelection();
  const identity = useIdentity();
  const { showHidden } = useDataVisibility();
  const data = detail.data;
  const now = useObservationTime(data?.source.cutoffAt);
  const inComparison = selected.some((player) => player.id === id);
  const forecast = data?.forecast;
  const notices = data && forecast ? forecastNotices(forecast, data.source, now ?? data.source.cutoffAt) : [];
  const metrics: Metric[] = ["goals", "assists", "shotsOnTarget", "keyPasses", "tackles", "interceptions", "saves", "goalsConceded"];
  const observedMetrics = metrics.filter((metric) => showHidden || data?.observedAppearances.some((appearance) => hasRecordedValue(appearance.metrics[metric])));
  const showRatings = showHidden || data?.observedAppearances.some((appearance) => hasRecordedValue(appearance.rating));
  const showMinutes = showHidden || data?.observedAppearances.some((appearance) => hasRecordedValue(appearance.minutes));
  const observedValue = (value: number | null | undefined, decimals = 2) => hasRecordedValue(value) ? formatNumber(value, decimals) : showHidden ? "Not recorded" : "";
  return <>
    <Link href="/players" className="text-link">← All players</Link>
    {data ? <header className="profile-hero">
      <PlayerArtwork position={data.player.position} className="profile-art" />
      <div className="profile-copy"><p className="eyebrow">Player profile · {positionLabel[data.player.position]}</p><h1>{data.player.name}</h1>{(data.player.currentClub || showHidden) && <p>{data.player.currentClub?.name ?? "Current club not recorded"}</p>}{(forecast && hasForecastOutputs(forecast.result) || showHidden) && <StatusBadge status={data.player.forecast.status} />}
        <BestStatisticView statistic={data.player.bestStatistic} leagueName={data.player.currentClub?.leagueName} />
        {data.player.sourceUrl && <p className="compact-note"><a className="text-link" href={data.player.sourceUrl} target="_blank" rel="noopener noreferrer">Player source · Sorare ↗</a></p>}
        <div className="action-row profile-actions"><button className="button" onClick={() => toggle(data.player)} disabled={!inComparison && selected.length >= 4} aria-label={`${inComparison ? "Remove" : "Add"} ${data.player.name} ${inComparison ? "from" : "to"} comparison`}>{inComparison ? "Remove from comparison" : "Add to comparison"}</button><HiddenDataButton /><button className="button button-secondary" onClick={() => setRevision((value) => value + 1)}>Refresh player data</button><Link className="text-link" href="/compare">Comparison ({selected.length}/4) →</Link></div>
      </div>
    </header> : <PageHeading eyebrow="Player profile" title="Player detail" />}
    <PanelState loading={detail.loading} error={detail.error} onRetry={() => setRevision((value) => value + 1)}>
      {data && <div className="stack">
        {!inComparison && selected.length >= 4 && <p className="notice">Comparison full · remove a player to add this one.</p>}
        {showHidden && !data.player.currentClub && <div className="notice notice-warning"><strong>{data.player.currentClubReasons.includes("ambiguous_current_club") ? "Club conflict" : "Current club unconfirmed"}</strong><details className="provenance-details"><summary>Club evidence</summary><ul className="reason-list">{data.player.currentClubReasons.map((code) => <li key={code}>{reasonText({ code })}</li>)}</ul></details></div>}
        {clubs.error !== undefined && <div className="notice" role="status">Club names could not load · IDs shown. <button className="text-button" onClick={() => setRevision((value) => value + 1)}>Retry club names</button></div>}
        {forecast ? <>
          {(hasForecastOutputs(forecast.result) || showHidden) && <section className="panel forecast-evaluation" aria-label="Forecast evaluation">
            <div className="section-heading"><div><p className="eyebrow">Saved model result</p><h2>Form & forecast</h2></div><StatusBadge status={forecast.result.status} /></div>
            <p className="compact-note">Evaluated {formatDate(forecast.evaluation.cutoffAt)}</p>
            {notices.length > 0 && <div className="notice notice-warning" role="status"><div className="profile-meta">{notices.map((notice) => <span className="badge badge-partial" key={notice}>{notice.startsWith("Source data") ? "Source changed" : notice.startsWith("The saved target") ? "Target passed" : "Evaluation over 15 min old"}</span>)}</div><details className="provenance-details"><summary>Freshness details</summary>{notices.map((notice) => <p key={notice}>{notice}</p>)}</details></div>}
            {forecast.input.player.position !== data.player.position && <p className="notice notice-warning">Position changed · saved {positionLabel[forecast.input.player.position]}, current {positionLabel[data.player.position]}</p>}
          </section>}
          <ForecastView input={forecast.input} result={forecast.result} clubs={clubs.data?.items ?? []} />
          <details className="panel provenance-details"><summary>Revision and source evidence</summary>
            <SourceNote source={data.source} />
            <dl className="data-list"><div><dt>Saved revision</dt><dd className="identifier">{forecast.id}</dd></div><div><dt>Model</dt><dd>{forecast.modelVersion}</dd></div><div><dt>Last checked</dt><dd>{formatDate(forecast.evaluation.checkedAt)}</dd></div><div><dt>Revision created</dt><dd>{formatDate(forecast.createdAt)}</dd></div><div><dt>Revision cutoff</dt><dd>{formatDate(forecast.cutoffAt)}</dd></div><div><dt>Revision source watermark</dt><dd>{forecast.sourceOrdinal}</dd></div><div><dt>Evaluation source watermark</dt><dd>{forecast.evaluation.sourceOrdinal}</dd></div><div><dt>Current read watermark</dt><dd>{data.source.sourceOrdinal}</dd></div><div><dt>Canonical input hash</dt><dd className="identifier">{forecast.inputHash}</dd></div></dl>
            <p>Refresh is asynchronous. Equal source watermarks do not prove freshness. A later check can retain an immutable revision when inputs have the same meaning; historical context uses corrected canonical results.</p>
            <h3>Saved revision evidence</h3><EvidenceProvenance provenance={forecast.provenance} />
            <h3>Latest evaluation evidence</h3><EvidenceProvenance provenance={forecast.evaluation.provenance} />
          </details>
        </> : <section className="panel"><h2>No model results to show.</h2>{showHidden && <p className="compact-note">A saved evaluation is not recorded.</p>}<details className="provenance-details"><summary>Source evidence</summary><SourceNote source={data.source} /></details></section>}
        <details className="panel provenance-details observed-details">
          <summary>Observed appearances</summary>
          <section className="detail-section" aria-labelledby="observed-title">
            <div className="section-heading"><div><p className="eyebrow">Current reported data</p><h2 id="observed-title">Observed appearances</h2></div><span className="muted">Up to {data.observedLimit}</span></div>
            <p className="compact-note">Separate from model input · match counts · minutes may exceed 90</p>
            {data.observedAppearances.length ? <div className="table-wrap"><table className="data-table"><caption className="sr-only">Recent observed appearances and reported match statistics</caption><thead><tr><th scope="col">Fixture</th><th scope="col">Participation</th>{showMinutes && <th scope="col">Minutes</th>}{showRatings && <th scope="col">Rating / 10</th>}{observedMetrics.map((metric) => <th scope="col" key={metric}>{metricLabel[metric]}</th>)}{identity?.role === "admin" && <th scope="col">Correction</th>}</tr></thead><tbody>{data.observedAppearances.map((appearance) => <tr key={appearance.fixtureId}>
              <th scope="row"><strong>{appearance.homeClub.name} vs {appearance.awayClub.name}</strong>{(appearance.kickoffAt || showHidden) && <span>{formatDate(appearance.kickoffAt)}</span>}<span>Fixture {appearance.fixtureId} · {appearance.status}{showHidden && ` · statistics ${appearance.statisticsStatus}`}</span></th>
              <td>{appearance.participation === "dnp" ? "Did not play" : appearance.participation === "played" ? "Played" : showHidden ? "Not recorded" : ""}</td>{showMinutes && <td>{observedValue(appearance.minutes, 0)}</td>}{showRatings && <td>{observedValue(appearance.rating)}</td>}{observedMetrics.map((metric) => <td key={metric}>{observedValue(appearance.metrics[metric], 0)}</td>)}{identity?.role === "admin" && <td><Link className="text-link" href={`/admin?playerId=${encodeURIComponent(data.player.id)}&fixtureId=${encodeURIComponent(appearance.fixtureId)}`} aria-label={`Review correction for fixture ${appearance.fixtureId}`}>Review correction</Link></td>}
            </tr>)}</tbody></table></div> : <div className="notice">No observed appearances stored in enabled coverage.</div>}
          </section>
        </details>
      </div>}
    </PanelState>
  </>;
}
