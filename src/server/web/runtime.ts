import "server-only";
import pg from "pg";
import { createAuthentication } from "../auth/config";
import { ReadService } from "../api/read";
import { AdminService } from "../api/admin";
import { port, required } from "../ingestion/connections";

function settings() {
  const baseURL = new URL(required("AUTH_BASE_URL"));
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(baseURL.hostname);
  if ((baseURL.protocol !== "https:" && !(baseURL.protocol === "http:" && loopback)) ||
      baseURL.username || baseURL.password || baseURL.pathname !== "/" || baseURL.search || baseURL.hash) {
    throw new Error("Configure a canonical authentication origin");
  }
  const secret = required("BETTER_AUTH_SECRET");
  if (secret.length < 32) throw new Error("Configure a private authentication secret");
  const passwords = {
    reader: required("POSTGRES_READER_PASSWORD"), writer: required("POSTGRES_WRITER_PASSWORD"), auth: required("POSTGRES_AUTH_PASSWORD"),
  };
  if (Object.values(passwords).some((password) => password.length < 16) || new Set(Object.values(passwords)).size !== 3) {
    throw new Error("Configure independent database runtime passwords");
  }
  return { baseURL: baseURL.origin, secret, passwords };
}

export function webConfigured(): boolean {
  try { settings(); return true; } catch { return false; }
}

function pool(role: "reader" | "writer" | "auth", password: string) {
  const connection = new pg.Pool({
    host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: port("POSTGRES_PORT", "5432"),
    database: process.env.POSTGRES_DB ?? "sports", user: `lsp_${role}`, password,
    options: role === "auth" ? "-c search_path=pg_catalog,auth" : "-c search_path=pg_catalog",
    connectionTimeoutMillis: 5_000, statement_timeout: 30_000, idleTimeoutMillis: 30_000,
    max: role === "auth" ? 6 : 4, application_name: `live-sports-web-${role}`,
  });
  connection.on("error", () => undefined);
  return connection;
}

function createRuntime() {
  const config = settings();
  const reader = pool("reader", config.passwords.reader);
  const writer = pool("writer", config.passwords.writer);
  const authPool = pool("auth", config.passwords.auth);
  return {
    origin: config.baseURL, authPool, reader, writer,
    auth: createAuthentication(authPool, { baseURL: config.baseURL, secret: config.secret }),
    read: new ReadService(reader), admin: new AdminService(writer),
  };
}

export type WebRuntime = ReturnType<typeof createRuntime>;
const globalRuntime = globalThis as typeof globalThis & { liveSportsWeb?: WebRuntime };

/** Runtime credentials and connections are never evaluated during route imports. */
export function getWebRuntime(): WebRuntime {
  return globalRuntime.liveSportsWeb ??= createRuntime();
}
