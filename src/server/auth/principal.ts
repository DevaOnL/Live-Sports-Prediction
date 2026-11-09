import type { Pool } from "pg";
import type { createAuthentication } from "./config";

export type Principal = {
  id: string;
  name: string;
  email: string;
  role: "viewer" | "admin";
  sessionId: string;
  expiresAt: Date;
};

export async function resolvePrincipal(
  auth: ReturnType<typeof createAuthentication>,
  authPool: Pool,
  headers: Headers,
): Promise<Principal | null> {
  const authenticated = await auth.api.getSession({
    headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!authenticated) return null;
  const expiresAt = new Date(authenticated.session.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) return null;
  const result = await authPool.query<{ id: string; name: string; email: string; role: string }>(
    'SELECT id, name, email, role FROM auth."user" WHERE id = $1',
    [authenticated.user.id],
  );
  const user = result.rows[0];
  if (!user || (user.role !== "viewer" && user.role !== "admin") || expiresAt.getTime() <= Date.now()) return null;
  return { ...user, role: user.role, sessionId: authenticated.session.id, expiresAt };
}
