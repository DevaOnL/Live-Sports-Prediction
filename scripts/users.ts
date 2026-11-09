import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";

class UserCommandError extends Error {}
type Role = "viewer" | "admin";
type Command = {
  operation: "create" | "set-password" | "role" | "revoke";
  email: string;
  name?: string;
  role?: Role;
};

function command(): Command {
  const [operation, ...arguments_] = process.argv.slice(2);
  if (!["create", "set-password", "role", "revoke"].includes(operation)) {
    throw new UserCommandError("Usage: users create|set-password|role|revoke --email EMAIL [--name NAME] [--role viewer|admin] [--password-stdin].");
  }
  const values = new Map<string, string>();
  let passwordStdin = false;
  for (let index = 0; index < arguments_.length; index++) {
    const flag = arguments_[index];
    if (flag === "--password-stdin" && !passwordStdin) { passwordStdin = true; continue; }
    if (!["--email", "--name", "--role"].includes(flag) || values.has(flag) ||
        !arguments_[index + 1] || arguments_[index + 1].startsWith("--")) {
      throw new UserCommandError("Unsupported or duplicate user command options.");
    }
    values.set(flag, arguments_[++index]);
  }
  const needsPassword = operation === "create" || operation === "set-password";
  if (needsPassword !== passwordStdin ||
      (operation !== "create" && values.has("--name")) ||
      (!["create", "role"].includes(operation) && values.has("--role"))) {
    throw new UserCommandError("Create and set-password require --password-stdin; name and role options must match the command.");
  }
  const email = (values.get("--email") ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^(?:[a-z0-9_'+-]+\.)*[a-z0-9_'+-]*[a-z0-9_+-]@(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$/.test(email)) {
    throw new UserCommandError("Provide a valid --email address.");
  }
  const role = values.get("--role");
  if (["create", "role"].includes(operation) && role !== "viewer" && role !== "admin") {
    throw new UserCommandError("Provide --role viewer or --role admin.");
  }
  const name = values.get("--name")?.trim();
  if (operation === "create" && (!name || name.length > 200)) {
    throw new UserCommandError("Create requires a nonempty --name of at most 200 characters.");
  }
  return { operation: operation as Command["operation"], email, name, role: role as Role | undefined };
}

async function passwordFromStdin() {
  if (process.stdin.isTTY) throw new UserCommandError("Redirect a password line through standard input; terminal password entry is disabled.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) throw new UserCommandError("Supply one password line containing 12 to 128 characters.");
    chunks.push(bytes);
  }
  let password: string;
  try { password = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, ""); }
  catch { throw new UserCommandError("Supply a valid UTF-8 password line."); }
  if (password.length < 12 || password.length > 128 || /[\r\n\0]/.test(password)) {
    throw new UserCommandError("Supply one password line containing 12 to 128 characters.");
  }
  return password;
}

function configuration(): pg.ClientConfig {
  const password = process.env.POSTGRES_MIGRATOR_PASSWORD;
  if (!password || password.length < 16 || /replace[-_\s]*with|change[-_\s]*me|placeholder/i.test(password)) {
    throw new UserCommandError("Configure POSTGRES_MIGRATOR_PASSWORD for controlled user administration.");
  }
  const port = process.env.POSTGRES_PORT ?? "5432";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new UserCommandError("POSTGRES_PORT must be an integer between 1 and 65535.");
  }
  return {
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port: Number(port),
    database: process.env.POSTGRES_DB ?? "sports",
    user: "lsp_migrator",
    password,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    application_name: "live-sports-users",
  };
}

async function main() {
  const requested = command();
  const config = configuration();
  const password = ["create", "set-password"].includes(requested.operation) ? await passwordFromStdin() : null;
  const hash = password === null ? null : await hashPassword(password);
  const client = new pg.Client(config);
  client.on("error", () => undefined);
  let started = false;
  try {
    await client.connect();
    await client.query("BEGIN");
    started = true;
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))", [`lsp:users:${requested.email}`]);
    const existing = await client.query<{ id: string }>('SELECT id FROM auth."user" WHERE lower(email) = $1 FOR UPDATE', [requested.email]);
    if (requested.operation === "create") {
      if (existing.rowCount) throw new UserCommandError("The user already exists; use an explicit administration command.");
      const id = randomUUID();
      await client.query('INSERT INTO auth."user" (id,name,email,role) VALUES ($1,$2,$3,$4)',
        [id, requested.name, requested.email, requested.role]);
      await client.query('INSERT INTO auth.account (id,"accountId","providerId","userId",password) VALUES ($1,$2,\'credential\',$2,$3)',
        [randomUUID(), id, hash]);
    } else {
      const user = existing.rows[0];
      if (!user) throw new UserCommandError("The user does not exist.");
      if (requested.operation === "set-password") {
        await client.query(`INSERT INTO auth.account (id,"accountId","providerId","userId",password)
          VALUES ($1,$2,'credential',$2,$3) ON CONFLICT ("providerId","accountId")
          DO UPDATE SET password=EXCLUDED.password,"updatedAt"=now()`, [randomUUID(), user.id, hash]);
      }
      if (requested.operation === "role") {
        await client.query('UPDATE auth."user" SET role=$1,"updatedAt"=now() WHERE id=$2', [requested.role, user.id]);
      }
      await client.query('DELETE FROM auth.session WHERE "userId"=$1', [user.id]);
    }
    await client.query("COMMIT");
    started = false;
    console.info(requested.operation === "create" ? "User created." : "User updated; existing sessions revoked.");
  } finally {
    if (started) await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof UserCommandError ? error.message : "User administration failed.");
  process.exitCode = 1;
});
