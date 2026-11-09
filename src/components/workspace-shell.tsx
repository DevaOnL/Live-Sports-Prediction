"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Identity } from "@/lib/contracts";
import { SelectionProvider, SelectionTray } from "./selection";
import { SiteMasthead } from "./site-masthead";

const identityContext = createContext<Identity | null>(null);
export function useIdentity() { return useContext(identityContext); }
export function WorkspaceShell({ identity, children }: { identity: Identity; children: ReactNode }) {
  return <identityContext.Provider value={identity}><SelectionProvider><div className="workspace">
    <a className="skip-link" href="#main">Skip to content</a>
    <SiteMasthead identity={identity} />
    <div className="workspace-content"><main className="workspace-main" id="main" tabIndex={-1}>{children}</main><div className="workspace-tray"><SelectionTray /></div><footer className="workspace-footer">Forecasts are estimates. Missing evidence stays visible.</footer></div>
  </div></SelectionProvider></identityContext.Provider>;
}
