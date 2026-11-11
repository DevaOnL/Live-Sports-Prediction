"use client";

import type { ClubsData } from "@/lib/contracts";
import { hasForecastOutputs, hasOutput, hasRecordedValue, selectedEvidence, tierLabel } from "@/lib/forecast-presentation";
import { formatDate, formatNumber, metricLabel, reasonText } from "@/lib/presentation";
import type { Context, ForecastInput, ForecastResult, Metric, Output, Reason } from "@/server/forecast/types";
import { MetricIcon } from "./football-art";
import { StatusBadge } from "./ui";
import { useDataVisibility } from "./data-visibility";

type Props = { input: ForecastInput; result: ForecastResult; clubs: ClubsData["items"]; compact?: boolean };

export function clubName(id: string | null | undefined, clubs: ClubsData["items"]): string {
  return id ? clubs.find((club) => club.id === id)?.name ?? `Club ${id}` : "Unknown club";
}

export function ReasonList({ reasons }: { reasons: Reason[] }) {
  if (!reasons.length) return null;
  return <ul className="reason-list">{reasons.map((reason, index) => <li key={`${reason.code}:${reason.fixtureId ?? ""}:${reason.field ?? ""}:${index}`}>
    {reasonText(reason)}
  </li>)}</ul>;
}

export function MatchRatings({ result, playerName }: { result: ForecastResult; playerName: string }) {
  const { showHidden } = useDataVisibility();
  const rated = result.selected.filter((match) => hasRecordedValue(match.rating)).length;
  const matches = result.selected.filter((match) => showHidden || hasRecordedValue(match.rating));
  if (!showHidden && !rated) return null;
  return <div className="match-ratings" role="group" aria-label={`Observed match ratings for ${playerName}`}>
    <span className="compact-note">{rated} of 5 match ratings</span>
    {matches.length > 0 && <ol className="match-rating-list">{matches.map((match) => <li key={match.fixtureId}>
      <span className={`match-rating${match.rating === null ? " match-rating-missing" : ""}`} title={formatDate(match.kickoffAt)}>
        <time dateTime={match.kickoffAt}>{new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(match.kickoffAt))}</time>{hasRecordedValue(match.rating) ? formatNumber(match.rating) : "Not recorded"}<span className="sr-only">{hasRecordedValue(match.rating) ? " out of 10" : " rating"}</span>
      </span>
    </li>)}</ol>}
  </div>;
}

export function EvidenceProvenance({ provenance }: { provenance: Record<string, unknown> }) {
  const { showHidden } = useDataVisibility();
  const appearances = Array.isArray(provenance.appearanceRevisionIds) ? provenance.appearanceRevisionIds.length : null;
  const fixtures = Array.isArray(provenance.fixtureRevisionIds) ? provenance.fixtureRevisionIds.length : null;
  const rosterTimes = Array.isArray(provenance.rosterObservations) ? provenance.rosterObservations.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("observedAt" in item) || typeof item.observedAt !== "string") return [];
    return [item.observedAt];
  }).sort() : [];
  const supplementLabels = { rating: "Ratings", keyPasses: metricLabel.keyPasses, tackles: metricLabel.tackles, interceptions: metricLabel.interceptions };
  const supplementCounts = new Map<string, number>();
  if (Array.isArray(provenance.appearanceEnrichments)) for (const entry of provenance.appearanceEnrichments) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)
      || typeof entry.fields !== "object" || entry.fields === null || Array.isArray(entry.fields)) continue;
    for (const field of Object.keys(supplementLabels)) {
      const source: unknown = entry.fields[field];
      if (typeof source === "object" && source !== null && "provider" in source && source.provider === "highlightly") {
        supplementCounts.set(field, (supplementCounts.get(field) ?? 0) + 1);
      }
    }
  }
  const supplements = Object.entries(supplementLabels).flatMap(([field, label]) => {
    const count = supplementCounts.get(field) ?? 0;
    return count ? [`${label}: ${count}`] : [];
  });
  return <dl className="data-list">{(appearances !== null || showHidden) && <div><dt>Appearance revisions</dt><dd>{appearances ?? "Not recorded"}</dd></div>}{(fixtures !== null || showHidden) && <div><dt>Fixture revisions</dt><dd>{fixtures ?? "Not recorded"}</dd></div>}{(rosterTimes.length > 0 || showHidden) && <div><dt>Latest roster evidence</dt><dd>{formatDate(rosterTimes.at(-1))}</dd></div>}
    {supplements.length > 0 && <div><dt>Highlightly supplements</dt><dd>{supplements.join(" · ")}</dd></div>}
  </dl>;
}

function OutputCard({ label, metric, unit, output }: { label: string; metric: string; unit: string; output: Output }) {
  const { showHidden } = useDataVisibility();
  if (!hasOutput(output) && !showHidden) return null;
  return <article className="metric-card">
    <div className="metric-symbol"><MetricIcon metric={metric} size={38} /></div>
    <div className="metric-heading"><h3>{label}</h3><StatusBadge status={output.status} /></div>
    <p className={hasOutput(output) ? "metric-value" : "metric-empty"}>{hasOutput(output) ? <>{formatNumber(output.value)}<span className="metric-unit">{unit}</span></> : "Not recorded"}</p>
    {showHidden && output.reasons.length > 0 && <details className="output-reasons provenance-details"><summary>Recorded details</summary><ReasonList reasons={output.reasons} /></details>}
  </article>;
}

function MatchContext({ context, ownClub, opponent }: { context: Context | null; ownClub: string; opponent: string }) {
  const { showHidden } = useDataVisibility();
  if (!context) return showHidden ? <p className="muted">Standings context not recorded.</p> : null;
  const rank = (value: Context["own"]) => value ? `${value.rank}${value.tiedCount > 1 ? `–${value.rank + value.tiedCount - 1} (tied)` : ""} of ${context.clubs}` : "Unknown rank";
  return <div className="match-context">
    <div className="context-grid">
      {(context.own || showHidden) && <div><span className="muted">{ownClub}</span><strong>{rank(context.own)}</strong><span>{tierLabel(context.own, context.clubs)}</span></div>}
      {(context.opponent || showHidden) && <div><span className="muted">{opponent}</span><strong>{rank(context.opponent)}</strong><span>{tierLabel(context.opponent, context.clubs)}</span></div>}
    </div>
    <p className="compact-note">{formatDate(context.cutoffAt)} · {context.complete ? "Reconstructed final results" : "Incomplete context"}</p>
    {showHidden && <ReasonList reasons={context.reasons} />}
  </div>;
}

function ClubCrest({ name }: { name: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return <svg className="club-crest" viewBox="0 0 80 90" aria-hidden="true" focusable="false"><path d="M6 6h68v42c0 19-15 31-34 37C21 79 6 67 6 48Z" fill="currentColor" stroke="#111" strokeWidth="5" /><path d="M17 19h46M17 25h46" stroke="#111" strokeWidth="3" /><text x="40" y="56" textAnchor="middle" fill="#111" fontWeight="900" fontSize="21">{initials}</text></svg>;
}

export function ForecastView({ input, result, clubs, compact = false }: Props) {
  const { showHidden } = useDataVisibility();
  const target = result.target ? input.targets.find((fixture) => fixture.fixtureId === result.target!.fixtureId) : undefined;
  const metrics = Object.keys(result.projected90) as Metric[];
  const selected = selectedEvidence(input, result);
  return <div className="forecast-view stack">
    {(hasForecastOutputs(result) || showHidden) && <div className="forecast-summary"><StatusBadge status={result.status} /><StatusBadge status={result.historyStatus} /></div>}
    {!hasForecastOutputs(result) && !showHidden && <div className="notice">No model results to show.</div>}
    {(hasForecastOutputs(result) || showHidden) && <div className="metric-grid">
      <OutputCard label="Forecast rating" metric="rating" unit="/ 10" output={result.forecastRating} />
      <OutputCard label="Adjusted form index" metric="form" unit="/ 100" output={result.adjustedFormIndex} />
      {metrics.map((metric) => <OutputCard key={metric} metric={metric} label={metricLabel[metric]} unit="per 90 minutes" output={result.projected90[metric]!} />)}
    </div>}
    {(hasForecastOutputs(result) || showHidden) && <details className="provenance-details"><summary>How to read these values</summary><p>Forecast rating: 0–10 estimate. Adjusted form: a separate 0–100 model index. Per-90 statistics assume 90 minutes of play; they do not predict playing time or guarantee counts. This heuristic has no established predictive accuracy.</p></details>}
    {(result.target || showHidden) && <section className="detail-section" aria-label="Forecast target">
      <div className="section-heading"><h2>Forecast target</h2></div>
      {result.target ? <div className="panel target-card">
        {target ? <div className="target-scoreboard"><div className="target-team"><ClubCrest name={clubName(target.homeClubId, clubs)} /><h3>{clubName(target.homeClubId, clubs)}</h3><span className="eyebrow">Home</span></div><span className="target-versus" aria-label="versus">VS</span><div className="target-team"><ClubCrest name={clubName(target.awayClubId, clubs)} /><h3>{clubName(target.awayClubId, clubs)}</h3><span className="eyebrow">Away</span></div></div> : <h3>Fixture {result.target.fixtureId}</h3>}
        <p className="compact-note">{formatDate(result.target.kickoffAt)}</p>
        <details className="provenance-details"><summary>Opponent context & weighting</summary>
          <p className="compact-note">Fixture {result.target.fixtureId}{(hasRecordedValue(result.target.difficulty) || showHidden) && <> · difficulty {hasRecordedValue(result.target.difficulty) ? formatNumber(result.target.difficulty) : "Not recorded"}</>} · competition coefficient {formatNumber(result.target.coefficient, 1)}</p>
          {target ? <MatchContext context={target.context} ownClub={clubName(input.currentClub?.clubId, clubs)} opponent={clubName(target.homeClubId === input.currentClub?.clubId ? target.awayClubId : target.homeClubId, clubs)} /> : showHidden && <p className="muted">Fixture context not recorded.</p>}
        </details>
      </div> : <div className="notice notice-warning"><strong>Target not recorded</strong><details className="provenance-details"><summary>Recorded details</summary><ReasonList reasons={input.rosterReasons.length ? input.rosterReasons : [{ code: input.currentClub ? "no_future_fixture" : "unknown_current_club" }]} /></details></div>}
    </section>}
    {(selected.length > 0 || showHidden) && <section className="detail-section" aria-label="Selected five-match window">
      <div className="section-heading"><div><p className="eyebrow">Exact model window</p><h2>{compact ? "Selected matches" : "The selected five matches"}</h2></div><span className="minutes-tag">{result.selected.length} of 5 selected</span></div>
      <p className="compact-note">Observed match counts · ≥60 min</p>
      {showHidden && result.historyStatus !== "ready" && <div className="notice notice-warning"><strong>{result.historyStatus === "incomplete_history" ? "Unresolved gaps · affected outputs hidden" : "Five qualifying appearances required"}</strong></div>}
      {selected.length ? <ol className="evidence-list evidence-grid">{selected.map(({ selected, appearance }, index) => {
        const own = clubName(selected.clubId, clubs);
        const opponentId = appearance ? appearance.homeClubId === selected.clubId ? appearance.awayClubId : appearance.homeClubId : undefined;
        const opponent = clubName(opponentId, clubs);
        return <li key={selected.fixtureId} className="evidence-card">
          <div className="evidence-top"><span className="evidence-order" aria-label={`Match ${index + 1}`}>{String(index + 1).padStart(2, "0")}</span><span className="minutes-tag">{formatNumber(selected.minutes, 0)} min</span></div>
          <div className="evidence-matchup"><ClubCrest name={own} /><div><h3>{own}<span className="muted"> vs </span>{opponent}</h3><time dateTime={selected.kickoffAt}>{new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(selected.kickoffAt))}</time></div></div>
          <dl className="evidence-stats">{(hasRecordedValue(selected.rating) || showHidden) && <div><dt><MetricIcon metric="rating" />Observed rating</dt><dd>{hasRecordedValue(selected.rating) ? <>{formatNumber(selected.rating)} <span>/ 10</span></> : "Not recorded"}</dd></div>}{metrics.filter((metric) => showHidden || hasRecordedValue(appearance?.metrics[metric])).map((metric) => <div key={metric}><dt><MetricIcon metric={metric} />{metricLabel[metric]}</dt><dd>{hasRecordedValue(appearance?.metrics[metric]) ? formatNumber(appearance?.metrics[metric], 0) : "Not recorded"}</dd></div>)}</dl>
          <details className="provenance-details"><summary>Match context and weighting</summary>
            <p className="compact-note">Fixture {selected.fixtureId} · {appearance?.season ?? "Covered season"} · {formatDate(selected.kickoffAt)}</p>
            {appearance ? <MatchContext context={appearance.context} ownClub={own} opponent={opponent} /> : showHidden && <p className="muted">Match evidence not recorded.</p>}
            <p className="compact-note">{(hasRecordedValue(selected.z) || showHidden) && <>Opponent minus own strength {hasRecordedValue(selected.z) ? formatNumber(selected.z, 0) : "Not recorded"} · </>}{(hasRecordedValue(selected.difficulty) || showHidden) && <>Difficulty {hasRecordedValue(selected.difficulty) ? formatNumber(selected.difficulty) : "Not recorded"} · </>}Competition coefficient {formatNumber(selected.coefficient, 1)}</p>
          </details>
        </li>;
      })}</ol> : <div className="notice">No qualifying appearances selected.</div>}
      <details className="provenance-details"><summary>Selection rules{showHidden && " & recorded gaps"}</summary><p>Latest five qualifying finalized appearances in enabled coverage before this input cutoff, with known participation and club membership and at least 60 reported minutes. New qualifying matches replace the oldest regardless of performance. These are the exact saved or comparison inputs, separate from current observations.</p><p className="compact-note">Input cutoff {formatDate(input.cutoffAt)}</p>{showHidden && (input.gaps.length ? <><p>Recorded gaps may predate the selected window; only gaps that could change it block outputs.</p><ReasonList reasons={input.gaps} /></> : <p className="muted">No input eligibility gaps recorded.</p>)}</details>
    </section>}
    {((showHidden && result.reasons.length > 0) || result.warnings.length > 0) && <details className="panel provenance-details" aria-label="Result explanations"><summary>Result & context details</summary>
      {showHidden && <ReasonList reasons={result.reasons} />}
      {result.warnings.length > 0 && <><h3>Context warnings</h3><ReasonList reasons={result.warnings} /></>}
    </details>}
  </div>;
}
