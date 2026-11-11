import Link from "next/link";
import { redirect } from "next/navigation";
import { getPageIdentity } from "@/server/web/access";
import { WorkspaceShell } from "@/components/workspace-shell";

export const dynamic = "force-dynamic";
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  let identity;
  try { identity = await getPageIdentity(); }
  catch { return <main className="account-shell" id="main"><section className="account-card"><h1>Try again shortly.</h1><p className="account-intro">Your session could not be checked. Please try again shortly.</p><Link className="button" href="/overview">Try again</Link><p><Link className="text-link" href="/login">Return to sign in</Link></p></section></main>; }
  if (!identity) redirect("/login");
  return <WorkspaceShell identity={identity}>{children}</WorkspaceShell>;
}
