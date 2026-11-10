"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Identity } from "@/lib/contracts";

export function SiteMasthead({ identity }: { identity?: Identity }) {
  const pathname = usePathname();
  const links = [{ href: "/overview", label: "Overview", icon: "◫" }, { href: "/players", label: "Players", icon: "◎" }, { href: "/compare", label: "Compare", icon: "⇄" }];
  return <><header className="site-masthead"><div className="masthead-inner">
    <Link className="wordmark" href="/" aria-label="Live Sports Prediction home">LSP<span>LIVE SPORTS PREDICTION</span></Link>
    <nav className="product-nav" aria-label={identity ? "Workspace navigation" : "Main navigation"}>{links.map((link) => <Link key={link.href} href={link.href} aria-current={pathname === link.href || pathname.startsWith(link.href + "/") ? "page" : undefined}><span aria-hidden="true">{link.icon}</span>{link.label}</Link>)}</nav>
    <Link className="masthead-account" href={identity ? "/account" : "/login"} aria-label={identity ? "Account settings" : undefined}>{identity ? <><span className="avatar" aria-hidden="true">{identity.name.slice(0, 1).toUpperCase()}</span><span>Account</span></> : <>Sign in <span aria-hidden="true">↗</span></>}</Link>
  </div></header><div className="match-ticker"><span>THE MATCHDAY EDIT</span><p>PREMIER LEAGUE <b aria-hidden="true">✦</b> LA LIGA <b aria-hidden="true">✦</b> 2026 / 27</p></div></>;
}
