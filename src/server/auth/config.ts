import { betterAuth } from "better-auth";
import type { Pool } from "pg";

const sessionSeconds = 8 * 60 * 60;

export function createAuthentication(pool: Pool, settings: { baseURL: string; secret: string }) {
  let url: URL;
  try { url = new URL(settings.baseURL); }
  catch { throw new Error("Configure a canonical authentication origin."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Authentication requires an HTTPS origin or a local HTTP origin.");
  }
  if (settings.secret.length < 32 || /replace[-_\s]*with|change[-_\s]*me|placeholder/i.test(settings.secret)) {
    throw new Error("Configure a private authentication secret of at least 32 characters.");
  }
  return betterAuth({
    appName: "Live Sports Prediction",
    database: pool,
    baseURL: url.origin,
    basePath: "/api/auth",
    secret: settings.secret,
    trustedOrigins: [url.origin],
    emailAndPassword: {
      enabled: true, disableSignUp: true, requireEmailVerification: false,
      minPasswordLength: 12, maxPasswordLength: 128,
    },
    user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    account: { accountLinking: { enabled: false } },
    session: {
      expiresIn: sessionSeconds, updateAge: 15 * 60, cookieCache: { enabled: false },
      additionalFields: { persistent: { type: "boolean", required: true, defaultValue: false, input: false, returned: false } },
    },
    databaseHooks: {
      session: {
        create: { async before(session, context) {
          // Only the validated sign-in option chooses persistence. The separate
          // dont_remember cookie can be omitted by a client and is not authority.
          const persistent = context?.path === "/sign-in/email" && context.body?.rememberMe !== false;
          // Better Auth otherwise gives nonpersistent cookies a 24-hour SQL session.
          return { data: { ...session, persistent, expiresAt: new Date(Math.min(
            session.expiresAt.getTime(), Date.now() + sessionSeconds * 1000,
          )) } };
        } },
        update: { async before(session, context) {
          const id = context?.context.session?.session.id;
          if (!id) return false;
          // Hidden additional fields are omitted from Better Auth's session
          // output, so consult their authoritative SQL value before renewal.
          const stored = (await pool.query<{ persistent: boolean; expiresAt: Date }>(
            'SELECT persistent,"expiresAt" FROM auth.session WHERE id=$1', [id],
          )).rows[0];
          if (!stored) return false;
          return { data: { ...session, persistent: stored.persistent,
            ...(stored.persistent ? {} : { expiresAt: stored.expiresAt }) } };
        } },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
    advanced: {
      // The local listener has no trusted proxy. A shared per-path bucket keeps
      // caller-supplied forwarding headers from bypassing the database limiter.
      ipAddress: { ipAddressHeaders: [] },
      useSecureCookies: url.protocol === "https:",
      cookiePrefix: "lsp",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
    },
    disabledPaths: [
      "/sign-up/email", "/sign-in/social", "/request-password-reset", "/reset-password",
      "/change-email", "/delete-user", "/delete-user/callback", "/send-verification-email",
      "/verify-email", "/change-password", "/set-password", "/verify-password", "/update-user",
      "/update-session", "/link-social", "/unlink-account", "/get-access-token", "/refresh-token",
      "/account-info", "/list-accounts", "/list-sessions", "/revoke-session", "/revoke-sessions",
      "/revoke-other-sessions",
    ],
    // The HTTP boundary catches thrown errors and serializes safe responses.
    // This also avoids the underlying router printing raw database diagnostics.
    onAPIError: { throw: true },
    logger: { disabled: true },
    telemetry: { enabled: false },
  });
}
