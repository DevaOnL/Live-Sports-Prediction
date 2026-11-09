import type { ClubsData } from "@/lib/contracts";
import { selectedEvidence, tierLabel } from "@/lib/forecast-presentation";
import { formatDate, formatNumber, metricLabel, reasonText } from "@/lib/presentation";
import type { Context, ForecastInput, ForecastResult, Metric, Output, Reason } from "@/server/forecast/types";
import { StatusBadge } from "./ui";

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

export function EvidenceProvenance({ provenance }: { provenance: Record<string, unknown> }) {
  const appearances = Array.isArray(provenance.appearanceRevisionIds) ? provenance.appearanceRevisionIds.length : 0;
  const fixtures = Array.isArray(provenance.fixtureRevisionIds) ? provenance.fixtureRevisionIds.length : 0;
  const rosterTimes = Array.isArray(provenance.rosterObservations) ? provenance.rosterObservations.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("observedAt" in item) || typeof item.observedAt !== "string") return [];
    return [item.observedAt];
  }).sort() : [];
  return <dl className="data-list"><div><dt>Appearance revisions in input</dt><dd>{appearances}</dd></div><div><dt>Fixture revisions in context</dt><dd>{fixtures}</dd></div><div><dt>Latest roster observation in evidence</dt><dd>{formatDate(rosterTimes.at(-1))}</dd></div></dl>;
}

function OutputCard({ label, unit, output }: { label: string; unit: string; output: Output }) {
  return <article className="metric-card">
    <div className="metric-heading"><h3>{label}</h3><StatusBadge status={output.status} /></div>
    <p className="metric-value">{output.status === "available" ? formatNumber(output.value) : "—"}<span className="metric-unit">{unit}</span></p>
    <div className="output-reasons"><ReasonList reasons={output.reasons} /></div>
  </article>;
}

function MatchContext({ context, ownClub, opponent }: { context: Context | null; ownClub: string; opponent: string }) {
  if (!context) return <p className="muted">Standings context unavailable.</p>;
  const rank = (value: Context["own"]) => value ? `${value.rank}${value.tiedCount > 1 ? `–${value.rank + value.tiedCount - 1} (tied)` : ""} of ${context.clubs}` : "Unknown rank";
  return <div className="match-context">
    <div className="context-grid">
      <div><span className="muted">{ownClub}</span><strong>{rank(context.own)}</strong><span>{tierLabel(context.own, context.clubs)}</span></div>
      <div><span className="muted">{opponent}</span><strong>{rank(context.opponent)}</strong><span>{tierLabel(context.opponent, context.clubs)}</span></div>
    </div>
    <p className="muted">Context as of {formatDate(context.cutoffAt)}. {context.complete ? "Reconstructed from observed final results." : "Context is incomplete."}</p>
    <ReasonList reasons={context.reasons} />
  </div>;
}

export function ForecastView({ input, result, clubs, compact = false }: Props) {
  const target = result.target ? input.targets.find((fixture) => fixture.fixtureId === result.target!.fixtureId) : undefined;
  const metrics = Object.keys(result.projected90) as Metric[];
  return <div className="forecast-view stack">
    <div className="forecast-summary"><StatusBadge status={result.status} /><span>{result.historyStatus === "ready" ? "Five-match history ready" : result.historyStatus === "incomplete_history" ? "History contains unresolved gaps" : "Fewer than five qualifying appearances"}</span></div>
    <div className="metric-grid">
      <OutputCard label="Forecast rating" unit="/ 10" output={result.forecastRating} />
      <OutputCard label="Adjusted form index" unit="/ 100" output={result.adjustedFormIndex} />
      {metrics.map((metric) => <OutputCard key={metric} label={metricLabel[metric]} unit="per 90 minutes" output={result.projected90[metric]!} />)}
    </div>
    <p className="muted">Forecast ratings are estimates on a 0–10 scale. The adjusted form index is a separate 0–100 model index. Projected statistics are decimal estimates for 90 minutes; playing time is not predicted. This heuristic has no established predictive accuracy.</p>
    <section className="detail-section" aria-label="Next fixture">
      <div className="section-heading"><div><p className="eyebrow">Looking ahead</p><h2>Next fixture</h2></div></div>
      {result.target ? <div className="panel target-card">
        <h3>{target ? `${clubName(target.homeClubId, clubs)} vs ${clubName(target.awayClubId, clubs)}` : `Fixture ${result.target.fixtureId}`}</h3>
        <p>{formatDate(result.target.kickoffAt)} · Fixture {result.target.fixtureId}</p>
        {target && <MatchContext context={target.context} ownClub={clubName(input.currentClub?.clubId, clubs)} opponent={clubName(target.homeClubId === input.currentClub?.clubId ? target.awayClubId : target.homeClubId, clubs)} />}
        <p className="muted">Difficulty {formatNumber(result.target.difficulty)} · competition coefficient {formatNumber(result.target.coefficient, 1)}</p>
      </div> : <div className="notice"><p>No future target was selected at this evaluation.</p><ReasonList reasons={input.rosterReasons.length ? input.rosterReasons : [{ code: input.currentClub ? "no_future_fixture" : "unknown_current_club" }]} /></div>}
    </section>
    <section className="detail-section" aria-label="Selected five-match window">
      <div className="section-heading"><div><p className="eyebrow">Model evidence</p><h2>{compact ? "Selected matches" : "The selected five matches"}</h2></div><span className="muted">{result.selected.length} of 5 selected</span></div>
      <p className="muted">The latest qualifying finalized appearances before this evaluation, each with at least 60 reported minutes. New eligible matches replace the oldest regardless of performance. These values belong to the same saved or comparison input as the outputs above.</p>
      {result.historyStatus !== "ready" && <div className="notice notice-warning"><p>{result.historyStatus === "incomplete_history" ? "Unresolved evidence may change this window. The model blocks affected outputs." : "Five qualifying appearances are required before the model can produce outputs."}</p></div>}
      {result.selected.length ? <ol className="evidence-list">{selectedEvidence(input, result).map(({ selected, appearance }, index) => {
        const own = clubName(selected.clubId, clubs);
        const opponentId = appearance ? appearance.homeClubId === selected.clubId ? appearance.awayClubId : appearance.homeClubId : undefined;
        return <li key={selected.fixtureId} className="evidence-card">
          <div className="evidence-top"><div><p className="eyebrow">Match {index + 1} · {formatDate(selected.kickoffAt)}</p><h3>{own} vs {clubName(opponentId, clubs)}</h3><p className="muted">Fixture {selected.fixtureId} · {appearance?.season ?? "Covered season"}</p></div><span className="minutes-tag">{formatNumber(selected.minutes, 0)} min</span></div>
          <dl className="evidence-stats"><div><dt>Observed rating</dt><dd>{formatNumber(selected.rating)} <span>/ 10</span></dd></div>{metrics.map((metric) => <div key={metric}><dt>{metricLabel[metric]}</dt><dd>{formatNumber(appearance?.metrics[metric] ?? null, 0)} <span>observed</span></dd></div>)}</dl>
          <details className="provenance-details"><summary>Match context and weighting</summary>
            {appearance ? <MatchContext context={appearance.context} ownClub={own} opponent={clubName(opponentId, clubs)} /> : <p className="muted">Detailed evidence unavailable for this match.</p>}
            <p className="muted">Opponent minus own strength {formatNumber(selected.z, 0)} · difficulty {formatNumber(selected.difficulty)} · competition coefficient {formatNumber(selected.coefficient, 1)}</p>
          </details>
        </li>;
      })}</ol> : <div className="notice">No qualifying appearances were selected.</div>}
    </section>
    {(result.reasons.length > 0 || result.warnings.length > 0) && <section className="panel" aria-label="Availability explanations"><h3>Availability and context</h3>
      <ReasonList reasons={result.reasons} />
      {result.warnings.length > 0 && <><h4>Context warnings</h4><ReasonList reasons={result.warnings} /></>}
    </section>}
  </div>;
}
