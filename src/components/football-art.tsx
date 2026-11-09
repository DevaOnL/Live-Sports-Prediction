import type { ReactNode } from "react";

export function PlayerArtwork({ position, className = "" }: { position: string; className?: string }) {
  const colors: Record<string, string> = { GK: "#ffe849", DEF: "#83c8fb", MID: "#f64c91", FWD: "#bba0ee", UNKNOWN: "#eee8da" };
  return <svg className={`football-art ${className}`} viewBox="0 0 320 250" fill="none" aria-hidden="true" focusable="false">
    <path d="M0 0h320v250H0z" fill={colors[position] ?? colors.UNKNOWN} />
    <path d="M-15 210 320-25M35 275 370 40" stroke="#080808" strokeOpacity=".12" strokeWidth="36" />
    <path d="M24 25h272v200H24zM160 25v200" stroke="#080808" strokeOpacity=".25" strokeWidth="2" />
    <circle cx="160" cy="125" r="44" stroke="#080808" strokeOpacity=".25" strokeWidth="2" />
    <path d="m115 63-45 26 22 48 28-13v86h94v-86l28 13 22-48-45-26-29-12h-46z" fill="#080808" transform="translate(5 6)" />
    <path d="m109 57-45 26 22 48 28-13v86h94v-86l28 13 22-48-45-26-29-12h-46z" fill="#fffaf0" stroke="#080808" strokeWidth="4" strokeLinejoin="round" />
    <path d="M139 46q20 35 44 0M139 102h44v59h-44z" stroke="#080808" strokeWidth="4" />
    <path d="M153 112h15v40h-15z" fill={colors[position] ?? colors.UNKNOWN} />
    <circle cx="260" cy="205" r="26" fill="#fffaf0" stroke="#080808" strokeWidth="3" />
    <path d="m260 191 12 9-5 14h-14l-5-14zM260 191v-12m12 21 13-3m-18 17 8 12m-22-12-8 12m3-26-13-3" stroke="#080808" strokeWidth="3" />
  </svg>;
}

export function MetricIcon({ metric, size = 32 }: { metric: string; size?: number }) {
  let art: ReactNode;
  if (/minute|time/i.test(metric)) art = <><circle cx="16" cy="17" r="11" /><path d="M16 10v8l5 3M12 2h8M16 2v4" /></>;
  else if (/form|trend/i.test(metric)) art = <><path d="M4 26V7m0 19h24M8 20l6-7 5 3 9-11m-8 0h8v8" /></>;
  else if (/club|league|competition/i.test(metric)) art = <><path d="M8 4h16v10c0 7-8 10-8 10s-8-3-8-10zM16 24v5M10 29h12M8 8H3v5q0 5 7 5m14-10h5v5q0 5-7 5" /></>;
  else if (/player|people/i.test(metric)) art = <><circle cx="16" cy="9" r="5" /><path d="M6 29v-5a10 10 0 0 1 20 0v5M3 9a4 4 0 0 0 0 8m26-8a4 4 0 0 1 0 8" /></>;
  else if (/rating|star/i.test(metric)) art = <path d="m16 3 4 9 10 1-8 7 3 10-9-5-9 5 3-10-8-7 10-1z" />;
  else if (/save|clean|defen/i.test(metric)) art = <><path d="m16 3 11 5v9c0 7-11 13-11 13S5 24 5 17V8zM10 16l4 4 8-9" /></>;
  else art = <><circle cx="16" cy="16" r="13" /><path d="m16 8 8 6-3 9H11l-3-9zM16 8V3m8 11 5-2m-8 11 3 5m-13-5-3 5m0-14-5-2" /></>;
  return <svg className="metric-icon" width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" focusable="false">{art}</svg>;
}
