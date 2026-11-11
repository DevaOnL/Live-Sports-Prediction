"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { returnPath } from "@/lib/navigation";

export function LoginForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setPending(true);
    setError("");
    try {
      const result = await fetch("/api/auth/sign-in/email", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: fields.get("email"), password: fields.get("password"), rememberMe: false }),
      });
      if (!result.ok) {
        setError(result.status === 429 ? "Too many attempts. Please wait a minute before trying again."
          : result.status >= 500 ? "Sign-in could not be completed. Please try again shortly."
          : "We could not sign you in. Check your email and password.");
        return;
      }
      form.reset();
      router.replace(returnPath(new URLSearchParams(window.location.search).get("next")));
      router.refresh();
    } catch { setError("Sign-in could not be completed. Please try again shortly."); }
    finally { setPending(false); }
  }
  return (
    <form className="account-form" onSubmit={signIn} aria-busy={pending}>
      <label htmlFor="email">Email address</label>
      <input id="email" name="email" type="email" autoComplete="username" maxLength={254} required aria-describedby="login-error" />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" autoComplete="current-password" maxLength={128} required aria-describedby="login-error" />
      <p id="login-error" className="account-error" role="status" aria-live="polite">{error}</p>
      <button className="button" type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in"}<span aria-hidden="true">→</span></button>
    </form>
  );
}
