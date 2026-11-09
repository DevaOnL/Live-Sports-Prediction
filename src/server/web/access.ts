import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { resolvePrincipal } from "../auth/principal";
import { getWebRuntime } from "./runtime";
import type { Identity } from "@/lib/contracts";

/** React's cache is scoped to this server render, never a browser role cache. */
export const getPageIdentity = cache(async (): Promise<Identity | null> => {
  const runtime = getWebRuntime();
  const principal = await resolvePrincipal(runtime.auth, runtime.authPool, new Headers(await headers()));
  return principal ? { id: principal.id, name: principal.name, email: principal.email, role: principal.role,
    expiresAt: principal.expiresAt.toISOString() } : null;
});
