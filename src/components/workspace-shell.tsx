"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, type ReactNode } from "react";
import type { Identity } from "@/lib/contracts";
import { SelectionProvider, SelectionTray } from "./selection";

const identityContext = createContext<Identity | null>(null);
export function useIdentity() { return useContext(identityContext); }
export function WorkspaceShell({ identity, children }: { identity: Identity; children: ReactNode }) {
  const pathname = usePathname();
  const links = [{ href: "/overview", label: "Overview", icon: "◫" }, { href: "/players", label: "Players", icon: "◎" },
    { href: "/compare", label: "Compare", icon: "⇄" }, ...(identity.role === "admin" ? [{ href: "/admin", label: "Operations", icon: "↗" }] : [])];
  return <identityContext.Provider value={identity}><SelectionProvider><div className="workspace">
    <a className="skip-link" href="#main">Skip to content</a>
    <aside className="workspace-sidebar">
      <Link className="workspace-brand" href="/overview"><span className="brand-mark" aria-hidden="true">lp<span /></span><span>Live Sports<br />Prediction</span></Link>
      <p className="sidebar-caption">Your football workspace</p>
      <nav className="workspace-nav" aria-label="Workspace navigation">{links.map((link) => <Link key={link.href} href={link.href} aria-current={pathname === link.href || pathname.startsWith(link.href + "/") ? "page" : undefined}><span aria-hidden="true">{link.icon}</span>{link.label}</Link>)}</nav>
      <div className="sidebar-bottom"><div className="coverage-note"><span className="status-dot" /> Two leagues. One clear view.<p>Championship & Ligue 2<br />Regular season · 2026/27</p></div><Link className="workspace-account" href="/account" aria-label="Account settings"><span className="avatar" aria-hidden="true">{identity.name.slice(0, 1).toUpperCase()}</span><span><strong>{identity.name}</strong><small>{identity.role === "admin" ? "Administrator" : "Viewer"} · Account</small></span><span aria-hidden="true">↗</span></Link></div>
    </aside>
    <div className="workspace-content"><header className="workspace-topbar"><Link href="/" className="muted">Football, with the evidence in view.</Link><span className="season-chip">2026 / 27</span></header><main className="workspace-main" id="main" tabIndex={-1}>{children}</main><div className="workspace-tray"><SelectionTray /></div><footer className="workspace-footer">Explainable estimates from covered match history. Forecasts are not guarantees.</footer></div>
  </div></SelectionProvider></identityContext.Provider>;
}
