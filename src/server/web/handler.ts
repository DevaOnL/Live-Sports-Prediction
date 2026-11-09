import { isPublicApiError } from "../api/error";
import type { PlayerFilters } from "../api/read";
import { resolvePrincipal } from "../auth/principal";
import { getWebRuntime, type WebRuntime } from "./runtime";
import { enforceOrigin, failure, HttpError, keys, optionalNumber, query, readJson, response } from "./http";

function safeUser(value: unknown) {
  const user = value as Record<string, unknown> | null;
  return user ? { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified, image: user.image ?? null } : null;
}

async function authentication(request: Request, path: string, runtime: WebRuntime) {
  const methods: Record<string, string> = { "sign-in/email": "POST", "get-session": "GET", "sign-out": "POST" };
  if (!Object.hasOwn(methods, path)) throw new HttpError(404, "NOT_FOUND", "The endpoint does not exist.");
  if (request.method !== methods[path]) throw new HttpError(405, "METHOD_NOT_ALLOWED", "This method is not supported.");
  query(request, []);
  let forwarded = request;
  if (request.method === "POST") {
    const body = await readJson(request);
    keys(body, path === "sign-in/email" ? ["email", "password", "rememberMe"] : [], path === "sign-in/email" ? ["email", "password"] : []);
    if (path === "sign-in/email" && (typeof body.email !== "string" || body.email.length > 254 ||
        typeof body.password !== "string" || body.password.length > 128 ||
        (body.rememberMe !== undefined && typeof body.rememberMe !== "boolean"))) {
      throw new HttpError(400, "INVALID_CREDENTIALS", "Provide an email and password.");
    }
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    forwarded = new Request(request.url, { method: request.method, headers, body: JSON.stringify(body) });
  }
  try {
    if (path === "sign-out") {
      // The library deliberately tolerates storage errors during sign-out. An
      // explicit committed deletion makes our successful response mean revoked.
      const principal = await resolvePrincipal(runtime.auth, runtime.authPool, request.headers);
      if (principal) await runtime.authPool.query('DELETE FROM auth.session WHERE id=$1 AND "userId"=$2', [principal.sessionId, principal.id]);
    }
    const result = await runtime.auth.handler(forwarded);
    const headers = new Headers();
    for (const cookie of result.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
    const retry = result.headers.get("retry-after") ?? result.headers.get("x-retry-after");
    if (retry && /^\d{1,5}$/.test(retry)) headers.set("Retry-After", retry);
    if (!result.ok) {
      if (result.status === 429) return failure(429, "RATE_LIMITED", "Too many attempts. Try again shortly.", headers);
      if (result.status >= 500 || result.status < 400) return failure(503, "SERVICE_UNAVAILABLE", "Sign-in is temporarily unavailable.", headers);
      return failure(result.status, "AUTHENTICATION_FAILED", "Authentication could not be completed.", headers);
    }
    const data = await result.json();
    if (path === "get-session") {
      if (!data) return response(null, 200, headers);
      const session = data.session;
      return response({ user: safeUser(data.user), session: {
        id: session.id, userId: session.userId, expiresAt: session.expiresAt, createdAt: session.createdAt, updatedAt: session.updatedAt,
      } }, 200, headers);
    }
    return response(path === "sign-in/email" ? { user: safeUser(data.user), redirect: false } : { success: true }, 200, headers);
  } catch (error) {
    const status = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 503;
    if (status === 429) return failure(429, "RATE_LIMITED", "Too many attempts. Try again shortly.");
    if (status >= 400 && status < 500) return failure(status, "AUTHENTICATION_FAILED", "Authentication could not be completed.");
    return failure(503, "SERVICE_UNAVAILABLE", "Sign-in is temporarily unavailable.");
  }
}

export async function handleApi(request: Request, segments: string[]): Promise<Response> {
  try {
    const runtime = getWebRuntime();
    enforceOrigin(request, runtime.origin);
    if (segments[0] === "auth") return await authentication(request, segments.slice(1).join("/"), runtime);
    const principal = await resolvePrincipal(runtime.auth, runtime.authPool, request.headers);
    if (!principal) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
    const path = segments.join("/");
    if (segments[0] === "admin") {
      if (principal.role !== "admin") throw new HttpError(403, "FORBIDDEN", "Administrator access is required.");
      if (request.method === "GET") {
        if (path === "admin/status") { query(request, []); return response({ data: await runtime.admin.status() }); }
        if (path === "admin/jobs" || path === "admin/audit") {
          const q = query(request, path === "admin/jobs" ? ["status", "kind", "page", "pageSize"] : ["page", "pageSize"]);
          const options = { page: optionalNumber(q.get("page")), pageSize: optionalNumber(q.get("pageSize")) };
          return response({ data: path === "admin/jobs" ? await runtime.admin.jobs({ ...options,
            ...(q.has("status") ? { status: q.get("status")! } : {}), ...(q.has("kind") ? { kind: q.get("kind")! } : {}),
          }) : await runtime.admin.audit(options) });
        }
      }
      if (request.method === "POST" || request.method === "PATCH") {
        query(request, []);
        const body = await readJson(request);
        if (request.method === "POST" && ["admin/imports", "admin/forecasts/refresh"].includes(path)) {
          keys(body, ["requestId"], ["requestId"]);
          const result = path === "admin/imports" ? await runtime.admin.requestImport(principal.id, body.requestId as string)
            : await runtime.admin.requestRefresh(principal.id, body.requestId as string);
          return response({ data: result }, 202);
        }
        if (request.method === "POST" && path === "admin/statistics") {
          keys(body, ["requestId", "leagueId", "fixtureId"], ["requestId", "leagueId", "fixtureId"]);
          return response({ data: await runtime.admin.requestStatistics(principal.id, body as Parameters<typeof runtime.admin.requestStatistics>[1]) }, 202);
        }
        if (request.method === "POST" && segments.length === 4 && segments[1] === "jobs" && segments[3] === "retry") {
          keys(body, ["requestId"], ["requestId"]);
          return response({ data: await runtime.admin.retry(principal.id, segments[2], body.requestId as string) }, 202);
        }
        if (request.method === "PATCH" && path === "admin/appearances") {
          keys(body, ["requestId", "playerId", "fixtureId", "expectedRevisionId", "reason", "changes"],
            ["requestId", "playerId", "fixtureId", "expectedRevisionId", "reason", "changes"]);
          return response({ data: await runtime.admin.correctAppearance(principal.id, body as Parameters<typeof runtime.admin.correctAppearance>[1]) });
        }
      }
      throw new HttpError(404, "NOT_FOUND", "The endpoint does not exist.");
    }
    if (request.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "This method is not supported.");
    if (path === "me") {
      query(request, []);
      return response({ data: { id: principal.id, name: principal.name, email: principal.email, role: principal.role, expiresAt: principal.expiresAt } });
    }
    if (path === "overview") { query(request, []); return response({ data: await runtime.read.overview() }); }
    if (path === "competitions") { query(request, []); return response({ data: await runtime.read.competitions() }); }
    if (path === "clubs") {
      const q = query(request, ["leagueId"]);
      return response({ data: await runtime.read.clubs(q.has("leagueId") ? { leagueId: q.get("leagueId")! } : {}) });
    }
    if (path === "players") {
      const q = query(request, ["q", "leagueId", "clubId", "position", "availability", "page", "pageSize"]);
      const filters: PlayerFilters = { page: optionalNumber(q.get("page")), pageSize: optionalNumber(q.get("pageSize")) };
      for (const key of ["q", "leagueId", "clubId", "position", "availability"] as const) {
        if (q.has(key)) Object.assign(filters, { [key]: q.get(key)! });
      }
      return response({ data: await runtime.read.players(filters) });
    }
    if (segments[0] === "players" && segments.length === 2) {
      query(request, []); return response({ data: await runtime.read.player(segments[1]) });
    }
    if (segments[0] === "players" && segments.length === 3 && segments[2] === "forecast") {
      query(request, []); return response({ data: await runtime.read.forecast(segments[1]) });
    }
    if (path === "compare") {
      const q = query(request, ["playerId", "allowCrossPosition"], ["playerId"]);
      const cross = q.get("allowCrossPosition");
      if (cross !== null && cross !== "true" && cross !== "false") throw new HttpError(400, "INVALID_QUERY", "Use true or false for cross-position comparison.");
      return response({ data: await runtime.read.compare(q.getAll("playerId"), cross === "true") });
    }
    throw new HttpError(404, "NOT_FOUND", "The endpoint does not exist.");
  } catch (error) {
    if (isPublicApiError(error)) {
      return failure(error.status, error.code, error.message);
    }
    return failure(503, "SERVICE_UNAVAILABLE", "The service is temporarily unavailable. Try again shortly.");
  }
}
