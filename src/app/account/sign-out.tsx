"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function signOut() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const result = await fetch("/api/auth/sign-out", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!result.ok) { setError("Sign-out could not be completed. Please try again."); return; }
      router.replace("/login");
      router.refresh();
    } catch { setError("Sign-out could not be completed. Please try again."); }
    finally { setPending(false); }
  }
  return <><button type="button" className="button" onClick={signOut} disabled={pending}>{pending ? "Signing out…" : "Sign out"}</button>
    <p className="account-error" role="status" aria-live="polite">{error}</p></>;
}
