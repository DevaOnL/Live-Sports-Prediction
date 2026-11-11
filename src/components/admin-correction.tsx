"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiFailure } from "@/lib/api";
import type { PlayerData } from "@/lib/contracts";
import type { AppearanceMetrics, CorrectedAppearance } from "@/server/api/admin";
import { formatDate, presentationText } from "@/lib/presentation";
import { CommandFeedback, useAdminCommand } from "./admin-command";

const metricFields = [
  ["minutes", "Minutes"], ["rating", "Rating"], ["goals", "Goals"], ["assists", "Assists"],
  ["shotsOnTarget", "Shots on target"], ["keyPasses", "Key passes"], ["tackles", "Tackles"],
  ["interceptions", "Interceptions"], ["saves", "Saves"], ["goalsConceded", "Goals conceded"],
] as const;
type Observed = PlayerData["observedAppearances"][number];
type LoadedAppearance = { playerId: string; playerName: string; loadedAt: number; row: Observed };
const metricsOf = (row: Observed): AppearanceMetrics => ({ minutes: row.minutes, rating: row.rating, ...row.metrics });
const validId = (value: string, kind: "Player" | "Game") => (/^[1-9]\d{0,17}$/.test(value) && Number.isSafeInteger(Number(value)))
  || new RegExp(`^${kind}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).test(value);

export function AdminCorrection({ playerId: initialPlayerId = "", fixtureId: initialFixtureId = "", onSaved }: {
  playerId?: string; fixtureId?: string; onSaved: () => void;
}) {
  const [playerId, setPlayerId] = useState(initialPlayerId);
  const [fixtureId, setFixtureId] = useState(initialFixtureId);
  const [loaded, setLoaded] = useState<LoadedAppearance | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>();
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<Partial<Record<keyof AppearanceMetrics, string>>>({});
  const [edited, setEdited] = useState<Partial<Record<keyof AppearanceMetrics, boolean>>>({});
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const command = useAdminCommand<CorrectedAppearance>((result) => {
    setLoaded((current) => current ? { ...current, row: { ...current.row, revisionId: result.revisionId,
      minutes: result.metrics.minutes, rating: result.metrics.rating,
      metrics: Object.fromEntries(Object.entries(result.metrics).filter(([key]) => key !== "minutes" && key !== "rating")) as Observed["metrics"] } } : null);
    setEdited({});
    setDraft(Object.fromEntries(Object.entries(result.metrics).map(([key, value]) => [key, value === null ? "" : String(value)])));
    setReason("");
    onSaved();
  });
  const conflict = command.error instanceof ApiFailure && command.error.status === 409;
  const correctable = loaded !== null && loaded.row.revisionId !== null && loaded.row.membershipKnown
    && loaded.row.participation === "played" && loaded.row.status === "final"
    && loaded.row.kickoffAt !== null && Number.isFinite(Date.parse(loaded.row.kickoffAt)) && Date.parse(loaded.row.kickoffAt) <= loaded.loadedAt;

  function invalidate() {
    controller.current?.abort();
    setLoading(false);
    setLoaded(null);
    setLoadError(undefined);
    setEdited({});
  }
  async function load() {
    if (command.locked) return;
    command.clear();
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setLoaded(null);
    setLoadError(undefined);
    setEdited({});
    if (!validId(playerId, "Player") || !validId(fixtureId, "Game")) {
      setLoadError(new Error("Provide valid player and fixture identifiers."));
      return;
    }
    setLoading(true);
    try {
      const detail = await api<PlayerData>(`players/${encodeURIComponent(playerId)}`, { signal: next.signal });
      if (next.signal.aborted) return;
      const row = detail.observedAppearances.find((appearance) => appearance.fixtureId === fixtureId);
      if (!row) throw new Error("This fixture is not among the player's 50 most recent observed appearances.");
      setLoaded({ playerId, playerName: detail.player.name, loadedAt: Date.parse(detail.source.cutoffAt), row });
      setDraft(Object.fromEntries(Object.entries(metricsOf(row)).map(([key, value]) => [key, value === null ? "" : String(value)])));
      setReason("");
    } catch (error) { if (!next.signal.aborted) setLoadError(error); }
    finally { if (!next.signal.aborted) setLoading(false); }
  }
  async function correct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loaded || !correctable || (conflict && !command.uncertain)) return;
    const changes: Partial<AppearanceMetrics> = {};
    for (const [field] of metricFields) if (edited[field]) changes[field] = draft[field]?.trim() ? Number(draft[field]) : null;
    if (!Object.keys(changes).length) return;
    await command.send("admin/appearances", { playerId: loaded.playerId, fixtureId: loaded.row.fixtureId,
      expectedRevisionId: loaded.row.revisionId, reason, changes }, "PATCH");
  }

  return <section className="panel" aria-labelledby="correction-title">
    <div className="panel-header"><div><p className="eyebrow">Canonical data</p><h2 id="correction-title">Correct an appearance</h2></div></div>
    <div className="panel-body"><p className="muted">Load current values. Save an audited revision.</p>
      <details className="provenance-details"><summary>Correction help</summary><p>Source archives stay intact. Later provider observations may supersede a correction; forecast refresh is asynchronous.</p></details>
      <form onSubmit={correct} className="page-stack">
        <div className="field-grid">
          <label className="field" htmlFor="correction-player"><span className="field-label">Player ID</span><input id="correction-player" className="field-input" value={playerId} disabled={command.locked} onChange={(event) => { invalidate(); setPlayerId(event.target.value); }} /></label>
          <label className="field" htmlFor="correction-fixture"><span className="field-label">Fixture ID</span><input id="correction-fixture" className="field-input" value={fixtureId} disabled={command.locked} onChange={(event) => { invalidate(); setFixtureId(event.target.value); }} /></label>
        </div>
        <div className="action-row"><button className="button button-secondary" type="button" onClick={load} disabled={loading || command.locked}>{loading ? "Loading appearance…" : loaded || conflict ? "Reload appearance" : "Load appearance"}</button></div>
        {loadError !== undefined && <p className="error-message" role="alert">{loadError instanceof Error ? presentationText(loadError.message) : "The appearance could not be loaded."}</p>}
        {loaded && <>
          <div><h3>{loaded.playerName}</h3><p>{loaded.row.homeClub.name} · {loaded.row.awayClub.name} · {formatDate(loaded.row.kickoffAt)}</p>
            <p className="form-note">{correctable ? "Final · Played · Membership verified" : "Correction cannot be applied. A final, played appearance, verified membership and current revision are required."}</p></div>
          <label className="field" htmlFor="correction-revision"><span className="field-label">Expected revision</span><input id="correction-revision" className="field-input code-value" value={loaded.row.revisionId ?? "Not recorded"} readOnly /></label>
          <p className="form-note" id="correction-null-note">Choose fields to change. Edited blank = missing (null); 0 = known zero. Unchecked fields stay unchanged.</p>
          <div className="correction-grid">{metricFields.map(([field, label]) => <div className="field" key={field}>
            <label className="checkbox-label"><input type="checkbox" checked={edited[field] ?? false} disabled={command.locked || !correctable} onChange={(event) => setEdited((current) => ({ ...current, [field]: event.target.checked }))} />Edit {label.toLowerCase()}</label>
            <label htmlFor={`correction-${field}`} className="field-label">{label}</label>
            <input id={`correction-${field}`} className="field-input" type="number" min="0" max={field === "rating" ? 10 : 2_147_483_647} step={field === "rating" ? "0.01" : "1"} value={draft[field] ?? ""} placeholder="Missing (null)" aria-describedby="correction-null-note" disabled={!edited[field] || command.locked || !correctable} onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))} />
          </div>)}</div>
          <label className="field" htmlFor="correction-reason"><span className="field-label">Reason</span><textarea id="correction-reason" className="field-textarea" rows={3} minLength={3} maxLength={1000} required value={reason} disabled={command.locked || !correctable} onChange={(event) => setReason(event.target.value)} /></label>
          <div className="action-row"><button className="button" type="submit" disabled={command.pending || !correctable || (!command.uncertain && (conflict || !Object.values(edited).some(Boolean)))}>{command.pending ? "Saving correction…" : command.uncertain ? "Retry same correction" : "Apply correction"}</button></div>
        </>}
        <CommandFeedback {...command}>{conflict && <p>Another revision may now be current. Reload appearance before applying a new correction.</p>}{command.result && <p>Correction saved as a manual revision. The audit trail retains the reason and before/after values.</p>}</CommandFeedback>
      </form>
    </div>
  </section>;
}
