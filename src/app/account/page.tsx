import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolvePrincipal, type Principal } from "@/server/auth/principal";
import { getWebRuntime } from "@/server/web/runtime";
import { SignOut } from "./sign-out";
import { SiteMasthead } from "@/components/site-masthead";
import { PlayerArtwork } from "@/components/football-art";

export const dynamic = "force-dynamic";

export default async function Account() {
  let principal: Principal | null;
  try {
    const runtime = getWebRuntime();
    principal = await resolvePrincipal(runtime.auth, runtime.authPool, new Headers(await headers()));
  } catch {
    return <main className="account-shell"><section className="account-card">
      <h1>Try again shortly.</h1><p className="account-intro">Your session could not be checked.</p>
      <Link className="text-link" href="/account">Try again <span aria-hidden="true">→</span></Link>
    </section></main>;
  }
  if (!principal) redirect("/login");
  return (
    <><a className="skip-link" href="#main">Skip to content</a><SiteMasthead identity={{ name: principal.name, role: principal.role, email: principal.email, id: principal.id, expiresAt: principal.expiresAt.toISOString() }} /><main className="account-shell" id="main" tabIndex={-1}><div className="account-layout"><div className="account-visual"><PlayerArtwork position="FWD" /></div>
      <section className="account-card" aria-labelledby="account-title">
        <h1 id="account-title">{principal.name}</h1>
        <p className="account-intro">{principal.email}</p>
        <p className="account-role">{principal.role === "admin" ? "Administrator" : "Viewer"}</p>
        <p><Link className="text-link" href="/overview">Open your workspace <span aria-hidden="true">→</span></Link></p>
        <SignOut />
      </section>
    </div></main></>
  );
}
