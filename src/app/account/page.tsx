import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolvePrincipal, type Principal } from "@/server/auth/principal";
import { getWebRuntime } from "@/server/web/runtime";
import { SignOut } from "./sign-out";

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
    <main className="account-shell" id="main">
      <Link className="account-brand" href="/">Live Sports Prediction <span aria-hidden="true">↗</span></Link>
      <section className="account-card" aria-labelledby="account-title">
        <p className="eyebrow">Your account</p>
        <h1 id="account-title">Welcome, {principal.name}.</h1>
        <p className="account-intro">You are signed in as {principal.email}.</p>
        <p className="account-role">{principal.role === "admin" ? "Administrator" : "Viewer"}</p>
        <p><Link className="text-link" href="/overview">Open your workspace <span aria-hidden="true">→</span></Link></p>
        <SignOut />
      </section>
    </main>
  );
}
