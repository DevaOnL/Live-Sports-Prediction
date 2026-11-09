"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/lib/use-api";
import type { CompetitionsData, OverviewData } from "@/lib/contracts";
import { formatNumber } from "@/lib/presentation";
import { PageHeading, PanelState, SourceNote, StatusBadge } from "./ui";
import { MetricIcon } from "./football-art";

export function Overview() {
  const [revision, setRevision] = useState(0);
  const overview = useApi<OverviewData>("overview", revision);
  const competitions = useApi<CompetitionsData>("competitions", revision);
  const refresh = () => setRevision((value) => value + 1);
  return <div className="page-stack"><PageHeading title="The game, in context."><button className="button button-secondary" onClick={refresh}>Refresh view <span aria-hidden="true">↻</span></button></PageHeading>
    <PanelState loading={overview.loading} error={overview.error} onRetry={refresh}>{overview.data && <>
      <section className="overview-banner"><Image src="/images/stadium-editorial.jpg" alt="" fill priority sizes="(max-width: 700px) 90vw, 1200px" /><div><h2><span>YOUR NEXT</span><span>MATCHDAY.</span></h2><Link className="button" href="/players">Explore players <span aria-hidden="true">↗</span></Link></div></section>
      <section className="metric-grid overview-metrics" aria-label="Coverage summary">{[["Covered players", overview.data.counts.players, "players"], ["Registered clubs", overview.data.counts.clubs, "clubs"], ["Covered competitions", overview.data.counts.competitions, "competitions"]].map(([label, value, icon]) => <article className="metric-card" key={String(label)}><MetricIcon metric={String(icon)} /><p>{label}</p><strong className="metric-value">{formatNumber(Number(value), 0)}</strong></article>)}</section>
      {overview.data.counts.players === 0 ? <PanelState empty="No players imported yet. An administrator can request an import." /> : <section className="panel"><div className="panel-header"><h2>Forecast availability</h2><Link className="text-link" href="/players">All players ↗</Link></div><div className="availability-grid">{Object.entries(overview.data.counts.forecasts).map(([status, count]) => <Link href={`/players?availability=${status}`} className="availability-card" key={status}><StatusBadge status={status} /><strong>{formatNumber(count, 0)}</strong><span aria-hidden="true">↗</span></Link>)}</div><p className="compact-note">Last saved evaluations; updates may be pending.</p></section>}
      <SourceNote source={overview.data.source} />
    </>}</PanelState>
    <section><div className="section-heading"><h2>The leagues</h2></div><PanelState loading={competitions.loading} error={competitions.error} onRetry={refresh} empty={competitions.data?.items.length === 0 && "No competitions imported yet."}><div className="competition-grid">{competitions.data?.items.map((league) => <Link href={`/players?leagueId=${league.id}`} className="league-card" key={league.id}><MetricIcon metric="league" size={48} /><div><div className="competition-top"><span>{league.country}</span><span>{league.season}</span></div><h3>{league.name}</h3><p>{league.expectedClubs} clubs · Regular season</p></div><span aria-hidden="true">↗</span></Link>)}</div></PanelState></section>
  </div>;
}
