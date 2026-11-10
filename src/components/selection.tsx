"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type Selection = { id: string; name: string; position: string };
type SelectionContext = { selected: Selection[]; toggle: (player: Selection) => void; replace: (players: Selection[]) => void; remove: (id: string) => void; clear: () => void };
const context = createContext<SelectionContext | null>(null);
const storageKey = "football-comparison-current";
const validPlayerId = (value: string) => (/^[1-9]\d{0,17}$/.test(value) && Number.isSafeInteger(Number(value)))
  || /^Player:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Selection[]>([]);
  useEffect(() => {
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]");
      if (Array.isArray(value)) {
        const safe = value.filter((item): item is Selection => item && typeof item === "object" && typeof item.id === "string" && validPlayerId(item.id) && typeof item.name === "string" && item.name.length <= 300 && ["GK", "DEF", "MID", "FWD", "UNKNOWN"].includes(item.position));
        // Loading untrusted display preferences never grants application access.
        queueMicrotask(() => setSelected([...new Map(safe.map((p) => [p.id, p])).values()].slice(0, 4)));
      }
    } catch { /* Session storage is optional. */ }
  }, []);
  const update = useCallback((change: (previous: Selection[]) => Selection[]) => setSelected((previous) => {
    const next = change(previous);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Keep the current in-memory selection. */ }
    return next;
  }), []);
  const toggle = useCallback((player: Selection) => update((old) => old.some((p) => p.id === player.id) ? old.filter((p) => p.id !== player.id) : old.length < 4 ? [...old, player] : old), [update]);
  const remove = useCallback((id: string) => update((old) => old.filter((p) => p.id !== id)), [update]);
  const clear = useCallback(() => update(() => []), [update]);
  const replace = useCallback((players: Selection[]) => update(() => [...new Map(players.map((p) => [p.id, p])).values()].slice(0, 4)), [update]);
  return <context.Provider value={{ selected, toggle, replace, remove, clear }}>{children}</context.Provider>;
}
export function useSelection() { const value = useContext(context); if (!value) throw new Error("Comparison selection requires its provider"); return value; }
export function SelectionTray() {
  const { selected, remove, clear } = useSelection();
  const pathname = usePathname();
  if (!selected.length || pathname === "/compare") return null;
  const query = new URLSearchParams();for (const p of selected) query.append("playerId", p.id);
  return <aside className="selection-bar" aria-label="Comparison selection"><div><strong>{selected.length} of 4 players selected</strong><div className="selection-list">{selected.map((p) => <button key={p.id} className="selection-chip" onClick={() => remove(p.id)} aria-label={`Remove ${p.name} from comparison`}>{p.name}<span aria-hidden="true">×</span></button>)}</div></div><div className="action-row"><button className="button button-quiet button-small" onClick={clear}>Clear selection</button><Link className="button button-small" href={`/compare?${query}`}>Compare players <span aria-hidden="true">↗</span></Link></div></aside>;
}
