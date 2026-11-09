"use client";

import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/lib/use-api";
import type { CompetitionsData, OverviewData } from "@/lib/contracts";
import { formatNumber } from "@/lib/presentation";
import { PageHeading, PanelState, SourceNote, StatusBadge } from "./ui";

export function Overview() {
  const [revision, setRevision] = useState(0);
  const overview = useApi<OverviewData>("overview", revision);
  const competitions = useApi<CompetitionsData>("competitions", revision);
  const refresh = () => setRevision((value) => value + 1);
  return <div className="page-stack"><PageHeading eyebrow="Your matchday perspective" title="The game, in context." description="Explore player form, understand the opposition, and see the evidence behind every estimate."><button className="button button-secondary" onClick={refresh}>Refresh view <span aria-hidden="true">↻</span></button></PageHeading>
    <PanelState loading={overview.loading} error={overview.error} onRetry={refresh}>{overview.data && <>
      <section className="overview-banner"><div><p className="eyebrow">A little more perspective</p><h2>Five appearances.<br />A clearer next match.</h2><p>Start with a player. Follow their qualifying appearances, the opponent context, and the forecast for their next confirmed fixture.</p><Link className="button button-lime" href="/players">Explore players <span aria-hidden="true">↗</span></Link></div><div className="pitch-illustration" aria-hidden="true"><div className="pitch-center" /><span className="pitch-point point-one" /><span className="pitch-point point-two" /><span className="pitch-point point-three" /><span className="pitch-point point-four" /><span className="pitch-point point-five" /><span className="pitch-label">Every match adds context.</span></div></section>
      <section className="metric-grid overview-metrics" aria-label="Coverage summary">{[["Covered players", overview.data.counts.players], ["Registered clubs", overview.data.counts.clubs], ["Covered competitions", overview.data.counts.competitions]].map(([label, value]) => <article className="metric-card" key={String(label)}><p>{label}</p><strong className="metric-value">{formatNumber(Number(value), 0)}</strong><span className="muted">Current imported coverage</span></article>)}</section>
      {overview.data.counts.players === 0 ? <PanelState empty="No players have been imported yet. An administrator can request an import; forecasts need covered match history before they can be evaluated." /> : <section className="panel"><div className="panel-header"><div><p className="eyebrow">Forecast coverage</p><h2>What the saved evidence supports.</h2></div><Link className="text-link" href="/players">View all players <span aria-hidden="true">↗</span></Link></div><p className="muted">Counts reflect the last stored evaluation. Histories may be incomplete, and changes may be waiting for the worker to refresh.</p><div className="availability-grid">{Object.entries(overview.data.counts.forecasts).map(([status, count]) => <Link href={`/players?availability=${status}`} className="availability-card" key={status}><StatusBadge status={status} /><strong>{formatNumber(count, 0)}</strong><span>Explore players <span aria-hidden="true">→</span></span></Link>)}</div></section>}
      <SourceNote source={overview.data.source} />
    </>}</PanelState>
    <section><div className="section-heading"><div><p className="eyebrow">The leagues in view</p><h2>Follow the competition.</h2></div></div><PanelState loading={competitions.loading} error={competitions.error} onRetry={refresh} empty={competitions.data?.items.length === 0 && "No competitions have been imported yet. An administrator can request an import."}><div className="competition-grid">{competitions.data?.items.map((league) => <Link href={`/players?leagueId=${league.id}`} className="league-card" key={league.id}><div className="competition-top"><span>{league.country}</span><span>{league.season}</span></div><h3>{league.name}</h3><p>{league.expectedClubs} clubs · Regular season</p><span className="text-link">Browse players <span aria-hidden="true">↗</span></span></Link>)}</div></PanelState></section>
    <section className="principle-cards"><article><span>01</span><h3>Observed performance</h3><p>The minutes, ratings, and statistics recorded in completed appearances.</p></article><article><span>02</span><h3>Adjusted form</h3><p>A 0–100 summary of past performance with opponent and league context. It is not an accuracy percentage.</p></article><article><span>03</span><h3>Next-match forecast</h3><p>An estimate for a confirmed future fixture. Missing evidence remains visible.</p></article></section>
  </div>;
}
