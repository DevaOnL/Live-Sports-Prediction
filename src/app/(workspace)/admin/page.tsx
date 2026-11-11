import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getPageIdentity } from "@/server/web/access";
import { AdminDashboard } from "@/components/admin-dashboard";

export default async function Administration({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  let identity;
  try { identity = await getPageIdentity(); }
  catch {
    return <section className="state-panel" role="alert"><h1>Operations could not load.</h1><p>Your session could not be checked. Try again shortly.</p><Link className="button button-secondary" href="/admin">Try again</Link></section>;
  }
  if (!identity) redirect("/login");
  if (identity.role !== "admin") return <section className="state-panel" role="alert"><h1>Administrator access required.</h1><p>Your current account can explore players and forecasts. Operational controls require an administrator account.</p><Link className="button" href="/overview">Back to overview</Link></section>;
  const params = await searchParams;
  return <Suspense fallback={<p role="status">Loading operations…</p>}><AdminDashboard initialPlayerId={typeof params.playerId === "string" ? params.playerId : undefined} initialFixtureId={typeof params.fixtureId === "string" ? params.fixtureId : undefined} /></Suspense>;
}
