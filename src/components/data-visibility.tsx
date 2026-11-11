"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

const visibilityContext = createContext<{ showHidden: boolean; setShowHidden: (value: boolean) => void }>({ showHidden: false, setShowHidden: () => {} });

export function DataVisibilityProvider({ children }: { children: ReactNode }) {
  const [showHidden, setShowHidden] = useState(false);
  return <visibilityContext.Provider value={{ showHidden, setShowHidden }}>{children}</visibilityContext.Provider>;
}

export function useDataVisibility() { return useContext(visibilityContext); }

export function DataVisibilityScope({ showHidden, children }: { showHidden: boolean; children: ReactNode }) {
  const { setShowHidden } = useDataVisibility();
  return <visibilityContext.Provider value={{ showHidden, setShowHidden }}>{children}</visibilityContext.Provider>;
}

export function HiddenDataButton({ onToggle }: { onToggle?: () => void }) {
  const { showHidden, setShowHidden } = useDataVisibility();
  return <button className="button button-secondary" type="button" aria-pressed={showHidden}
    onClick={onToggle ?? (() => setShowHidden(!showHidden))}>{showHidden ? "Hide hidden" : "Show hidden"}</button>;
}
