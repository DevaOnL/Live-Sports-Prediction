"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useApi } from "@/lib/use-api";
import type { ClubsData, CompetitionsData, PlayersData } from "@/lib/contracts";
import { formatDate, positionLabel, reasonText } from "@/lib/presentation";
import { PageHeading, PanelState, Pager, SourceNote, StatusBadge } from "./ui";
import { useSelection } from "./selection";
import { PlayerArtwork } from "./football-art";

export function PlayerCatalogue() {
  const search = useSearchParams();
  return <CatalogueView key={search.toString()} />;
}

function CatalogueView() {
  const router = useRouter(); const search = useSearchParams();
  const [revision, setRevision] = useState(0);
  const [leagueId, setLeagueId] = useState(search.get("leagueId") ?? "");
  const [clubId, setClubId] = useState(search.get("clubId") ?? "");
  const query = new URLSearchParams();
  for (const key of ["q", "leagueId", "clubId", "position", "availability", "page", "pageSize"]) {
    for (const value of search.getAll(key)) query.append(key, value);
  }
  const players = useApi<PlayersData>(`players?${query}`, revision);
  const clubs = useApi<ClubsData>("clubs", revision);
  const competitions = useApi<CompetitionsData>("competitions", revision);
  const { selected, toggle } = useSelection();
  const refresh = () => setRevision((value) => value + 1);
  const navigate = (next: URLSearchParams) => router.push(`/players?${next}`, { scroll: false });
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();const fields = new FormData(event.currentTarget);const next = new URLSearchParams();
    for (const key of ["q", "leagueId", "clubId", "position", "availability", "pageSize"]) {
      const value = String(fields.get(key) ?? "").trim();if (value) next.set(key, value);
    }
    const club = clubs.data?.items.find((item) => item.id === next.get("clubId"));
    if (club && next.has("leagueId") && club.leagueId !== next.get("leagueId")) next.delete("clubId");
    navigate(next);
  }
  const pageSize = search.get("pageSize") ?? "20";
  const sizes = [...new Set([pageSize, "10", "20", "50"])].filter((value) => /^[1-9]\d?$/.test(value) && Number(value) <= 50).sort((a, b) => Number(a) - Number(b));
  return <div className="page-stack"><PageHeading title="Find your next player."><button className="button button-secondary" onClick={refresh}>Refresh view <span aria-hidden="true">↻</span></button></PageHeading>
    <details className="panel catalogue-filters"><summary>Filter players{["q", "leagueId", "clubId", "position", "availability"].some((key) => search.get(key)) && <span className="badge">Filters active</span>}</summary><form key={search.toString()} onSubmit={apply} className="filter-grid"><div className="field search-field"><label htmlFor="player-search">Search players</label><input id="player-search" name="q" type="search" placeholder="Player name" maxLength={80} defaultValue={search.get("q") ?? ""} /></div>
      <div className="field"><label htmlFor="competition-filter">Competition</label><select id="competition-filter" name="leagueId" value={leagueId} onChange={(event) => { const next = event.target.value;setLeagueId(next);if (next && clubs.data?.items.find((club) => club.id === clubId)?.leagueId !== next) setClubId(""); }}><option value="">All competitions</option>{leagueId && !competitions.data?.items.some((item) => item.id === leagueId) && <option value={leagueId}>Selected competition ({leagueId})</option>}{competitions.data?.items.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div>
      <div className="field"><label htmlFor="club-filter">Club</label><select id="club-filter" name="clubId" value={clubId} onChange={(event) => setClubId(event.target.value)}><option value="">All clubs</option>{clubId && !clubs.data?.items.some((item) => item.id === clubId) && <option value={clubId}>Selected club ({clubId})</option>}{clubs.data?.items.filter((item) => !leagueId || item.leagueId === leagueId).map((item) => <option value={item.id} key={`${item.leagueId}:${item.id}`}>{item.name} · {item.leagueName}</option>)}</select></div>
      <div className="field"><label htmlFor="position-filter">Position</label><select id="position-filter" name="position" defaultValue={search.get("position") ?? ""}><option value="">All positions</option>{Object.entries(positionLabel).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></div>
      <div className="field"><label htmlFor="availability-filter">Forecast availability</label><select id="availability-filter" name="availability" defaultValue={search.get("availability") ?? ""}><option value="">Any saved status</option><option value="available">Available</option><option value="partial">Partly available</option><option value="unavailable">Unavailable</option><option value="uncomputed">Not evaluated</option></select></div>
      <div className="field"><label htmlFor="size-filter">Results per page</label><select id="size-filter" name="pageSize" defaultValue={pageSize}>{sizes.map((size) => <option value={size} key={size}>{size}</option>)}</select></div><div className="filter-actions"><button className="button" type="submit">Apply filters <span aria-hidden="true">→</span></button><Link href="/players" className="button button-quiet">Clear filters</Link></div>
    </form><details className="provenance-details"><summary>Filter details</summary><p>Competition and club filters use confirmed current membership. Players with uncertain clubs remain in the unfiltered catalogue. Changing competition clears an incompatible club.</p></details>{Boolean(clubs.error || competitions.error) && <PanelState error={clubs.error ?? competitions.error} onRetry={refresh} />}</details>
    <PanelState loading={players.loading} error={players.error} onRetry={refresh}>{players.data && <>
      <div className="results-heading"><p><strong>{players.data.pagination.total.toLocaleString("en-GB")}</strong> players in view</p><p className="muted">Compare up to 4 players.</p></div>
      {players.data.pagination.total > 0 && players.data.pagination.page > players.data.pagination.pages ? <section className="state-panel"><h2>This page is beyond the current results.</h2><p>Your filters match players, but this page no longer exists.</p><button className="button" onClick={() => { const next = new URLSearchParams(query);next.delete("page");navigate(next); }}>Return to first page</button></section> : <PanelState empty={players.data.items.length === 0 && "No players match these filters. Clear them to explore all imported players."}><div className="player-grid">{players.data.items.map((player) => {
        const included = selected.some((item) => item.id === player.id);
        return <article className="player-card" key={player.id}><div className="player-card-top"><span className={`position-tag position-${player.position.toLowerCase()}`}>{positionLabel[player.position]}</span></div><Link className="player-art-link" href={`/players/${player.id}`} aria-label={`View ${player.name}`}><PlayerArtwork position={player.position} /></Link><h2><Link href={`/players/${player.id}`}>{player.name}</Link></h2><p className="player-club">{player.currentClub?.name ?? "Current club unconfirmed"}</p><p className="player-league">{player.currentClub ? `${player.currentClub.leagueName} · ${player.currentClub.season}` : "Covered match history"}</p><div className="player-evaluation"><StatusBadge status={player.forecast.status} /><details className="provenance-details"><summary>Evaluation details</summary><small>Player #{player.id} · Evaluated: {formatDate(player.forecast.evaluationCutoffAt)}</small></details></div>{player.currentClubReasons.length > 0 && <details className="club-reasons"><summary>Why is the club uncertain?</summary><ul>{player.currentClubReasons.map((reason) => <li key={reason}>{reasonText(reason)}</li>)}</ul></details>}<div className="player-card-actions"><Link className="text-link" href={`/players/${player.id}`}>View player <span aria-hidden="true">↗</span></Link><button className={`compare-toggle${included ? " selected" : ""}`} type="button" onClick={() => toggle(player)} disabled={!included && selected.length >= 4} aria-pressed={included} aria-label={`${included ? "Remove" : "Add"} ${player.name} ${included ? "from" : "to"} comparison`}>{included ? "✓ Selected" : "+ Compare"}</button></div></article>;
      })}</div></PanelState>}
      {players.data.pagination.page <= Math.max(1, players.data.pagination.pages) && <Pager page={players.data.pagination.page} pages={players.data.pagination.pages} onPage={(page) => { const next = new URLSearchParams(query);next.set("page", String(page));navigate(next); }} />}<SourceNote source={players.data.source} />
    </>}</PanelState>
  </div>;
}
