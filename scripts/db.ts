import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const advisoryLock = 0x4c535044;
const roleNames = ["lsp_reader", "lsp_writer", "lsp_auth", "lsp_migrator"] as const;
const passwordVariables = [
  "POSTGRES_READER_PASSWORD",
  "POSTGRES_WRITER_PASSWORD",
  "POSTGRES_AUTH_PASSWORD",
  "POSTGRES_MIGRATOR_PASSWORD",
] as const;

class ConfigurationError extends Error {}

type Migration = { filename: string; checksum: string; sql: string };

function secret(name: string) {
  const value = process.env[name];
  if (!value || value.length < 16 || /replace[-_\s]*with|change[-_\s]*me|placeholder/i.test(value)) {
    throw new ConfigurationError(`${name} must contain a private password of at least 16 characters.`);
  }
  return value;
}

function connection(user: string, password: string, operation: string): pg.ClientConfig {
  const portText = process.env.POSTGRES_PORT ?? "5432";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError("POSTGRES_PORT must be an integer between 1 and 65535.");
  }
  return {
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port,
    database: process.env.POSTGRES_DB ?? "sports",
    user,
    password,
    application_name: `live-sports-${operation}`,
    connectionTimeoutMillis: 10_000,
  };
}

function identifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function transaction(client: pg.Client, run: () => Promise<void>) {
  await client.query("BEGIN");
  try {
    await run();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function locked(config: pg.ClientConfig, run: (client: pg.Client) => Promise<void>) {
  const client = new Client(config);
  // Connection failures also reject queries. Suppress the EventEmitter's default
  // uncaught-error path, which could print unredacted server diagnostics.
  client.on("error", () => undefined);
  let acquired = false;
  try {
    await client.connect();
    await client.query("SET lock_timeout = '15s'");
    await client.query("SET statement_timeout = '120s'");
    await client.query("SELECT pg_advisory_lock($1::bigint)", [advisoryLock]);
    acquired = true;
    await run(client);
  } finally {
    if (acquired) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [advisoryLock]).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

async function provision() {
  const passwords = passwordVariables.map(secret);
  const bootstrapPassword = secret("POSTGRES_BOOTSTRAP_PASSWORD");
  if (new Set([...passwords, bootstrapPassword]).size !== passwords.length + 1) {
    throw new ConfigurationError("Bootstrap and runtime passwords must all be different.");
  }
  const config = connection(process.env.POSTGRES_USER ?? "sports_bootstrap", bootstrapPassword, "provision");
  await locked(config, async (client) => {
    await transaction(client, async () => {
      const membership = await client.query(
        `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
         WHERE r.rolname = ANY($1::text[]) LIMIT 1`,
        [roleNames],
      );
      if (membership.rowCount) {
        throw new ConfigurationError("Runtime roles have unexpected role memberships; administrator review is required.");
      }
      const owner = await client.query(
        `SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
         WHERE d.datname = current_database() AND r.rolname = ANY($1::text[])`,
        [roleNames],
      );
      if (owner.rowCount) {
        throw new ConfigurationError("The application database must remain owned by its bootstrap administrator.");
      }
      for (const [index, role] of roleNames.entries()) {
        const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
        if (!existing.rowCount) await client.query(`CREATE ROLE ${identifier(role)} NOLOGIN`);
        const command = await client.query<{ statement: string }>(
          `SELECT format(
            'ALTER ROLE %I WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
            $1::text, $2::text
          ) AS statement`,
          [role, passwords[index]],
        );
        await client.query(command.rows[0].statement);
        await client.query(`ALTER ROLE ${identifier(role)} SET search_path = pg_catalog`);
        await client.query(`ALTER ROLE ${identifier(role)} SET default_transaction_isolation = 'read committed'`);
      }
      const database = await client.query<{ name: string }>("SELECT current_database() AS name");
      const db = identifier(database.rows[0].name);
      const roles = roleNames.map(identifier).join(", ");
      await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC, ${roles}`);
      await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${roles}`);
      await client.query(`GRANT CREATE ON DATABASE ${db} TO lsp_migrator`);
      await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC, ${roles}`);
    });
  });
  console.info("Database roles provisioned.");
}

// Strip quoted values/bodies and comments before checking top-level transaction
// commands. SQL functions may contain BEGIN/END inside their dollar-quoted body.
function topLevelSql(sql: string) {
  // PostgreSQL accepts high-bit characters in unquoted identifiers, including
  // their UTF-8 bytes. Consume the whole identifier so its $ cannot open a body.
  const identifierStart = /[A-Za-z_\u0080-\uFFFF]/;
  const identifierPart = /[A-Za-z0-9_$\u0080-\uFFFF]/;
  const dollarQuote = /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/;
  let result = "";
  let index = 0;
  while (index < sql.length) {
    if (sql.startsWith("--", index)) {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index++;
      result += " ";
    } else if (sql.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith("/*", index)) { depth++; index += 2; }
        else if (sql.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      result += " ";
    } else if (sql[index] === "'" || sql[index] === '"') {
      if (sql[index] === "'" && /[eE]/.test(sql[index - 1] ?? "") &&
          !identifierPart.test(sql[index - 2] ?? "")) {
        // Escape mode can continue into later newline-separated literals.
        // Keep migration syntax narrower instead of inferring that state.
        throw new ConfigurationError("Top-level E-prefixed escape strings are unsupported in migrations; use standard strings or dollar quotes.");
      }
      const quote = sql[index++];
      while (index < sql.length) {
        if (sql[index++] === quote) {
          if (sql[index] === quote) index++;
          else break;
        }
      }
      result += " ";
    } else if (identifierStart.test(sql[index])) {
      const start = index++;
      while (index < sql.length && identifierPart.test(sql[index])) index++;
      result += sql.slice(start, index);
    } else if (sql[index] === "$" && dollarQuote.test(sql.slice(index))) {
      const tag = sql.slice(index).match(dollarQuote)![0];
      const end = sql.indexOf(tag, index + tag.length);
      index = end < 0 ? sql.length : end + tag.length;
      result += " ";
    } else result += sql[index++];
  }
  return result;
}

async function readMigrations(directory: string): Promise<Migration[]> {
  let entries;
  let root;
  try {
    root = await realpath(directory);
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    throw new ConfigurationError("Migration directory is unavailable.");
  }
  const sqlEntries = entries.filter((entry) => entry.name.endsWith(".sql"));
  if (!sqlEntries.length || sqlEntries.some((entry) => !entry.isFile() || !/^\d{3}_[a-z][a-z0-9_]*\.sql$/.test(entry.name))) {
    throw new ConfigurationError("Migration files must use unique sequential NNN_name.sql filenames, starting at 001.");
  }
  sqlEntries.sort((left, right) => left.name.localeCompare(right.name));
  const migrations: Migration[] = [];
  for (const [index, entry] of sqlEntries.entries()) {
    if (Number(entry.name.slice(0, 3)) !== index + 1) {
      throw new ConfigurationError("Migration files must use unique sequential NNN_name.sql filenames, starting at 001.");
    }
    let contents;
    try { contents = await readFile(resolve(root, entry.name)); }
    catch { throw new ConfigurationError("A migration file could not be read."); }
    const sql = contents.toString("utf8");
    const unquoted = topLevelSql(sql);
    if (!unquoted.trim() || /(?:^|;)\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i.test(unquoted)) {
      throw new ConfigurationError("Migration files must contain SQL without top-level transaction control.");
    }
    migrations.push({ filename: entry.name, checksum: createHash("sha256").update(contents).digest("hex"), sql });
  }
  return migrations;
}

async function migrate(directory: string) {
  const migrations = await readMigrations(directory);
  const config = connection("lsp_migrator", secret("POSTGRES_MIGRATOR_PASSWORD"), "migrate");
  await locked(config, async (client) => {
    const ledger = await client.query<{ exists: boolean }>("SELECT to_regclass('infra.schema_migrations') IS NOT NULL AS exists");
    if (!ledger.rows[0].exists) {
      const unmanaged = await client.query(
        "SELECT 1 FROM pg_namespace WHERE nspname IN ('sports', 'auth', 'infra') LIMIT 1",
      );
      if (unmanaged.rowCount) {
        throw new ConfigurationError("Unmanaged sports/auth/infra schema found; administrator review is required.");
      }
      await transaction(client, async () => {
        await client.query("CREATE SCHEMA infra AUTHORIZATION lsp_migrator");
        await client.query(`CREATE TABLE infra.schema_migrations (
          filename text PRIMARY KEY CHECK (filename ~ '^[0-9]{3}_[a-z][a-z0-9_]*[.]sql$'),
          checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
          applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )`);
        await client.query("REVOKE ALL ON SCHEMA infra FROM PUBLIC");
        await client.query("REVOKE ALL ON TABLE infra.schema_migrations FROM PUBLIC");
      });
    }
    const ownership = await client.query<{ owned: boolean }>(
      `SELECT pg_get_userbyid(c.relowner) = current_user AND
              pg_get_userbyid(n.nspowner) = current_user AS owned
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'infra' AND c.relname = 'schema_migrations' AND c.relkind = 'r'`,
    );
    if (ownership.rows[0]?.owned !== true) {
      throw new ConfigurationError("The migration ledger must be owned by lsp_migrator.");
    }
    const applied = await client.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM infra.schema_migrations ORDER BY filename",
    );
    for (const [index, row] of applied.rows.entries()) {
      const expected = migrations[index];
      if (!expected || expected.filename !== row.filename) {
        throw new ConfigurationError("Migration history is not a contiguous prefix of the available migrations.");
      }
      if (expected.checksum !== row.checksum) {
        throw new ConfigurationError("An applied migration checksum has changed; restore it and add a new migration.");
      }
    }
    if (!applied.rows.length) {
      const unmanaged = await client.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('sports', 'auth') LIMIT 1");
      if (unmanaged.rowCount) {
        throw new ConfigurationError("Unmanaged sports/auth schema found; administrator review is required.");
      }
    }
    for (const migration of migrations.slice(applied.rows.length)) {
      await transaction(client, async () => {
        // Match the scanner even when a previous migration changed the session.
        await client.query("SET LOCAL standard_conforming_strings = on");
        await client.query(migration.sql);
        await client.query("INSERT INTO infra.schema_migrations (filename, checksum) VALUES ($1, $2)", [migration.filename, migration.checksum]);
      });
      console.info(`Applied ${migration.filename}.`);
    }
    console.info(`Database migrations current (${migrations.length} applied).`);
  });
}

async function main() {
  const [command, ...options] = process.argv.slice(2);
  if (command === "provision" && options.length === 0) await provision();
  else if (command === "migrate" && (options.length === 0 || (options.length === 2 && options[0] === "--dir" && options[1]))) {
    const directory = options.length ? resolve(options[1]) : fileURLToPath(new URL("../db/migrations/", import.meta.url));
    await migrate(directory);
  } else throw new ConfigurationError("Usage: scripts/db.ts provision | migrate [--dir path]");
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) console.error(error.message);
  else {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    console.error(`Database operation failed${/^[0-9A-Z]{5}$/.test(code) ? ` (${code})` : ""}.`);
  }
  process.exitCode = 1;
});
