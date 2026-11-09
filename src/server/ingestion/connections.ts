import pg from "pg";
import { MongoClient } from "mongodb";

export function required(name: string): string {
  const value = process.env[name];
  if (!value || /replace[-_\s]*with|change[-_\s]*me|placeholder/i.test(value)) throw new Error(`Configure ${name}`);
  return value;
}

export function port(name: string, fallback: string): number {
  const text = process.env[name] ?? fallback;
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${name}`);
  return value;
}

export function mongoDatabase(): string {
  const value = process.env.MONGO_DB ?? "sports";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid MONGO_DB");
  return value;
}

export function mongoConnection(admin = false): MongoClient {
  const database = mongoDatabase();
  const host = process.env.MONGO_HOST ?? "127.0.0.1";
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error("Invalid MONGO_HOST");
  return new MongoClient(`mongodb://${host}:${port("MONGO_PORT", "27017")}`, {
    auth: {
      username: admin ? process.env.MONGO_BOOTSTRAP_USER ?? "bootstrap" : process.env.MONGO_WORKER_USER ?? "lsp_ingestion",
      password: required(admin ? "MONGO_BOOTSTRAP_PASSWORD" : "MONGO_WORKER_PASSWORD"),
    },
    authSource: admin ? "admin" : database,
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
    socketTimeoutMS: 30_000,
    maxPoolSize: 6,
  });
}

export function writerPool(): pg.Pool {
  const pool = new pg.Pool({
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port: port("POSTGRES_PORT", "5432"),
    database: process.env.POSTGRES_DB ?? "sports",
    user: "lsp_writer",
    password: required("POSTGRES_WRITER_PASSWORD"),
    connectionTimeoutMillis: 5_000,
    statement_timeout: 120_000,
    idleTimeoutMillis: 30_000,
    max: 6,
    application_name: "live-sports-ingestion",
  });
  // Query rejections are handled at operational boundaries; never print raw diagnostics.
  pool.on("error", () => undefined);
  return pool;
}
