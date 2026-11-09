import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
import pg, { type Client, type ClientConfig } from "pg";

// Provisioning changes cluster-wide roles, so a test database alone is not isolation.
// Supply the system identifier read directly from a new disposable cluster.
const database = process.env.POSTGRES_DB ?? "";
const expectedCluster = process.env.POSTGRES_TEST_CLUSTER_ID ?? "";
if (process.env.NODE_ENV !== "test" || !/^[a-z][a-z0-9_]{0,57}_test$/.test(database) ||
    !/^\d{10,20}$/.test(expectedCluster)) {
  throw new Error("Database tests require NODE_ENV=test, a dedicated POSTGRES_DB ending _test, and POSTGRES_TEST_CLUSTER_ID from a disposable cluster.");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const connection = {
  host: process.env.POSTGRES_HOST ?? "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT ?? "5432"),
  database,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 20_000,
};
const roles = {
  reader: ["lsp_reader", "POSTGRES_READER_PASSWORD"],
  writer: ["lsp_writer", "POSTGRES_WRITER_PASSWORD"],
  auth: ["lsp_auth", "POSTGRES_AUTH_PASSWORD"],
  migrator: ["lsp_migrator", "POSTGRES_MIGRATOR_PASSWORD"],
} as const;

async function connect(role: keyof typeof roles | "bootstrap", db = database) {
  const credentials: ClientConfig = role === "bootstrap"
    ? { user: process.env.POSTGRES_USER ?? "sports_bootstrap", password: process.env.POSTGRES_BOOTSTRAP_PASSWORD }
    : { user: roles[role][0], password: process.env[roles[role][1]] };
  const client = new pg.Client({ ...connection, ...credentials, database: db });
  await client.connect();
  return client;
}

async function cli(command: "provision" | "migrate", args: string[] = [], db = database) {
  try {
    const result = await execute(process.execPath, ["--import", "tsx", join(root, "scripts/db.ts"), command, ...args], {
      cwd: root,
      env: { ...process.env, POSTGRES_DB: db },
      timeout: 45_000,
      maxBuffer: 512_000,
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const result = error as { code?: number | string; stdout?: string; stderr?: string };
    return { code: result.code, output: (result.stdout ?? "") + (result.stderr ?? "") };
  }
}

async function isolatedDatabase(work: (name: string) => Promise<void>) {
  const name = `sports_${randomUUID().replaceAll("-", "")}_test`;
  await administrator.query(`CREATE DATABASE "${name}"`);
  try {
    const result = await cli("provision", [], name);
    assert.equal(result.code, 0, result.output);
    await work(name);
  } finally {
    await administrator.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  }
}

async function transaction(role: keyof typeof roles, work: (client: Client) => Promise<void>) {
  const client = await connect(role);
  try {
    await client.query("BEGIN");
    await work(client);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

async function rejectsSql(client: Client, sql: string, values: unknown[] = [], code = "23514") {
  await client.query("SAVEPOINT rejected_statement");
  try {
    await assert.rejects(async () => {
      await client.query(sql, values);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    }, (error: unknown) => (error as { code?: string }).code === code);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT rejected_statement");
    await client.query("RELEASE SAVEPOINT rejected_statement");
  }
}

async function fixture(client: Client) {
  const competition = (await client.query(`INSERT INTO sports.competitions
    (provider_id, name, country_name, timezone, coefficient)
    VALUES ($1, 'Test league', 'England', 'Europe/London', 1.5) RETURNING id`, [randomUUID()])).rows[0].id as string;
  const season = (await client.query(`INSERT INTO sports.competition_seasons
    (competition_id, label, starts_on, ends_on, expected_clubs)
    VALUES ($1, '2026/27', '2026-07-01', '2027-06-30', 24) RETURNING id`, [competition])).rows[0].id as string;
  const clubs: string[] = [];
  for (const name of ["Home", "Away", "Other"]) {
    const id = (await client.query("INSERT INTO sports.clubs (provider_id, name) VALUES ($1, $2) RETURNING id", [randomUUID(), name])).rows[0].id as string;
    clubs.push(id);
    await client.query("INSERT INTO sports.season_clubs (season_id, club_id) VALUES ($1, $2)", [season, id]);
  }
  const player = (await client.query("INSERT INTO sports.players (provider_id, name, position) VALUES ($1, 'Test player', 'FWD') RETURNING id", [randomUUID()])).rows[0].id as string;
  const membership = (await client.query(`INSERT INTO sports.player_memberships
    (player_id, club_id, season_id, valid_from, valid_until)
    VALUES ($1, $2, $3, '2026-07-01T00:00:00Z', '2027-07-01T00:00:00Z') RETURNING id`, [player, clubs[0], season])).rows[0].id as string;
  const match = (await client.query(`INSERT INTO sports.fixtures
    (provider_id, season_id, home_club_id, away_club_id, kickoff_at)
    VALUES ($1, $2, $3, $4, '2026-11-01T15:00:00Z') RETURNING id`, [randomUUID(), season, clubs[0], clubs[1]])).rows[0].id as string;
  return { competition, season, clubs, player, membership, match };
}

async function revision(client: Client, entity = "standings", parent?: string) {
  const token = randomUUID();
  const source = (await client.query(`INSERT INTO sports.source_revisions
    (action, resource_key, archive_ref, content_sha256, retrieved_at)
    VALUES ('get_events', $1, $2, $3, now()) RETURNING id`, [token, `mongo:test:${token}`, "a".repeat(64)])).rows[0].id as string;
  const normalized = (await client.query(`INSERT INTO sports.normalized_revisions
    (source_revision_id, entity_type, entity_key, content_sha256, parent_id)
    VALUES ($1, $2, 'test-entity', $3, $4) RETURNING id`, [source, entity, "b".repeat(64), parent ?? null])).rows[0].id as string;
  return { source, normalized, token };
}

async function cleanupFixture(data: Awaited<ReturnType<typeof fixture>>) {
  await administrator.query("BEGIN");
  try {
    await administrator.query("DELETE FROM sports.appearances WHERE fixture_id=$1", [data.match]);
    await administrator.query("DELETE FROM sports.fixtures WHERE id=$1", [data.match]);
    await administrator.query("DELETE FROM sports.player_memberships WHERE id=$1", [data.membership]);
    await administrator.query("DELETE FROM sports.players WHERE id=$1", [data.player]);
    await administrator.query("DELETE FROM sports.season_clubs WHERE season_id=$1", [data.season]);
    await administrator.query("DELETE FROM sports.competition_seasons WHERE id=$1", [data.season]);
    await administrator.query("DELETE FROM sports.competitions WHERE id=$1", [data.competition]);
    await administrator.query("DELETE FROM sports.clubs WHERE id=ANY($1::uuid[])", [data.clubs]);
    await administrator.query("COMMIT");
  } catch (error) {
    await administrator.query("ROLLBACK");
    throw error;
  }
}

let administrator: Client;
before(async () => {
  administrator = await connect("bootstrap");
  assert.equal((await administrator.query("SELECT current_database() AS name")).rows[0].name, database);
  const cluster = (await administrator.query(`SELECT system_identifier::text AS identifier,
    current_setting('server_version_num')::integer AS version FROM pg_control_system()`)).rows[0];
  assert.equal(cluster.identifier, expectedCluster, "refusing to mutate an unconfirmed PostgreSQL cluster");
  assert.equal(Math.trunc(Number(cluster.version) / 10_000), 17, "database tests require PostgreSQL 17");
  const others = await administrator.query(`SELECT datname FROM pg_database
    WHERE NOT datistemplate AND datname NOT IN ('postgres', current_database())`);
  assert.equal(others.rowCount, 0, "database tests require a disposable cluster without other databases");
  for (const command of ["provision", "migrate"] as const) {
    const result = await cli(command);
    assert.equal(result.code, 0, result.output);
  }
});

test("role provisioning can be repeated without changing schema history or access", async () => {
  const previous = (await administrator.query("SELECT * FROM infra.schema_migrations ORDER BY filename")).rows;
  const result = await cli("provision");
  assert.equal(result.code, 0, result.output);
  assert.deepEqual((await administrator.query("SELECT * FROM infra.schema_migrations ORDER BY filename")).rows, previous);
  for (const role of Object.keys(roles) as (keyof typeof roles)[]) {
    const client = await connect(role);
    try {
      const settings = (await client.query(`SELECT current_user AS name,
        current_setting('search_path') AS search_path,
        current_setting('default_transaction_isolation') AS isolation`)).rows[0];
      assert.deepEqual(settings, { name: roles[role][0], search_path: "pg_catalog", isolation: "read committed" });
    } finally {
      await client.end();
    }
  }
});
after(async () => {
  await administrator?.end();
});

test("migration reruns preserve the applied history and serialize safely", async () => {
  const client = await connect("migrator");
  try {
    const previous = (await client.query("SELECT filename, checksum, applied_at FROM infra.schema_migrations ORDER BY filename")).rows;
    const files = (await readdir(join(root, "db/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    assert.deepEqual(previous.map((row) => row.filename), files);
    const results = await Promise.all([cli("migrate"), cli("migrate")]);
    for (const result of results) assert.equal(result.code, 0, result.output);
    assert.deepEqual((await client.query("SELECT filename, checksum, applied_at FROM infra.schema_migrations ORDER BY filename")).rows, previous);
  } finally {
    await client.end();
  }
});

test("migration history rejects drift and missing files; upgrade failures roll back DDL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sports-migrations-"));
  try {
    await cp(join(root, "db/migrations"), directory, { recursive: true });
    await isolatedDatabase(async (migrationDatabase) => {
      const initial = await cli("migrate", ["--dir", directory], migrationDatabase);
      assert.equal(initial.code, 0, initial.output);
      const client = await connect("migrator", migrationDatabase);
      try {
        const previous = (await client.query("SELECT filename, checksum, applied_at FROM infra.schema_migrations ORDER BY filename")).rows;
        const names = previous.map((row) => row.filename as string);
        const firstFile = join(directory, names[0]);
        const firstContents = await readFile(firstFile, "utf8");
        await writeFile(firstFile, firstContents + "\n-- simulated historical edit\n");
        const drift = await cli("migrate", ["--dir", directory], migrationDatabase);
        assert.notEqual(drift.code, 0);
        assert.match(drift.output, /checksum has changed/);
        await writeFile(firstFile, firstContents);
        const lastFile = join(directory, names.at(-1)!);
        const lastContents = await readFile(lastFile, "utf8");
        await rm(lastFile);
        const missing = await cli("migrate", ["--dir", directory], migrationDatabase);
        assert.notEqual(missing.code, 0);
        assert.match(missing.output, /not a contiguous prefix/);
        await writeFile(lastFile, lastContents);
        const nextName = `${String(names.length + 1).padStart(3, "0")}_upgrade_probe.sql`;
        await writeFile(join(directory, nextName), "CREATE TABLE sports.upgrade_probe (id integer PRIMARY KEY); SELECT 1 / 0;");
        const failed = await cli("migrate", ["--dir", directory], migrationDatabase);
        assert.notEqual(failed.code, 0);
        assert.match(failed.output, /22012/);
        assert.equal((await client.query("SELECT to_regclass('sports.upgrade_probe') AS name")).rows[0].name, null);
        assert.deepEqual((await client.query("SELECT filename, checksum, applied_at FROM infra.schema_migrations ORDER BY filename")).rows, previous);
        await writeFile(join(directory, nextName), "CREATE TABLE sports.upgrade_probe (id integer PRIMARY KEY); SET standard_conforming_strings = off;");
        const stringName = `${String(names.length + 2).padStart(3, "0")}_string_settings.sql`;
        await writeFile(join(directory, stringName), String.raw`SELECT '\';`);
        const upgrade = await cli("migrate", ["--dir", directory], migrationDatabase);
        assert.equal(upgrade.code, 0, upgrade.output);
        assert.equal((await client.query("SELECT to_regclass('sports.upgrade_probe') AS name")).rows[0].name, "sports.upgrade_probe");
        assert.equal((await cli("migrate", ["--dir", directory], migrationDatabase)).code, 0);
      } finally {
        await client.end();
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent fresh migrations create one complete ordered history", async () => {
  await isolatedDatabase(async (name) => {
    const results = await Promise.all([cli("migrate", [], name), cli("migrate", [], name)]);
    for (const result of results) assert.equal(result.code, 0, result.output);
    const client = await connect("migrator", name);
    try {
      const history = (await client.query("SELECT filename FROM infra.schema_migrations ORDER BY filename")).rows;
      const files = (await readdir(join(root, "db/migrations"))).filter((file) => file.endsWith(".sql")).sort();
      assert.deepEqual(history.map((row) => row.filename), files);
      assert.equal((await client.query("SELECT count(*) FROM auth.\"user\"")).rows[0].count, "0");
    } finally {
      await client.end();
    }
  });
});

test("a failed first migration rolls back its schema and can be retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sports-migrations-"));
  try {
    const filename = join(directory, "001_initial.sql");
    const sql = "CREATE SCHEMA sports; CREATE TABLE sports.upgrade_probe (id integer PRIMARY KEY);";
    await writeFile(filename, sql + " SELECT 1 / 0;");
    await isolatedDatabase(async (name) => {
      const failed = await cli("migrate", ["--dir", directory], name);
      assert.notEqual(failed.code, 0);
      assert.match(failed.output, /22012/);
      const client = await connect("migrator", name);
      try {
        assert.equal((await client.query("SELECT to_regnamespace('sports') AS name")).rows[0].name, null);
        assert.equal((await client.query("SELECT count(*) FROM infra.schema_migrations")).rows[0].count, "0");
        await writeFile(filename, sql);
        const retry = await cli("migrate", ["--dir", directory], name);
        assert.equal(retry.code, 0, retry.output);
        assert.equal((await client.query("SELECT count(*) FROM infra.schema_migrations")).rows[0].count, "1");
      } finally {
        await client.end();
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration files cannot commit outside the runner transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sports-migrations-"));
  try {
    await isolatedDatabase(async (name) => {
      const client = await connect("migrator", name);
      try {
        for (const sql of [
          "CREATE SCHEMA sports; /* boundary */ COMMIT;",
          "CREATE TABLE sports.first$x$ (id integer); COMMIT; CREATE TABLE sports.second$x$ (id integer); SELECT 1 / 0;",
          "CREATE TABLE sports.é$x$ (id integer); COMMIT; CREATE TABLE sports.ß$x$ (id integer); SELECT 1 / 0;",
          "CREATE SCHEMA sports; -- boundary\rCOMMIT; CREATE TABLE sports.upgrade_probe(id integer); SELECT 1/0;",
        ]) {
          await writeFile(join(directory, "001_initial.sql"), sql);
          const result = await cli("migrate", ["--dir", directory], name);
          assert.notEqual(result.code, 0);
          assert.match(result.output, /without top-level transaction control/);
          const schemas = await client.query("SELECT to_regnamespace('sports') AS sports, to_regnamespace('infra') AS infra");
          assert.deepEqual(schemas.rows[0], { sports: null, infra: null });
        }
        for (const sql of [
          "CREATE SCHEMA sports; SELECT E'first'\n'second\\'part'; COMMIT; SELECT 'end'; SELECT 1 / 0;",
          "CREATE SCHEMA sports; SELECT E'standalone';",
          "CREATE SCHEMA sports; SELECT e'standalone';",
        ]) {
          await writeFile(join(directory, "001_initial.sql"), sql);
          const result = await cli("migrate", ["--dir", directory], name);
          assert.notEqual(result.code, 0);
          assert.match(result.output, /E-prefixed escape strings are unsupported/);
          const schemas = await client.query("SELECT to_regnamespace('sports') AS sports, to_regnamespace('infra') AS infra");
          assert.deepEqual(schemas.rows[0], { sports: null, infra: null });
        }
        await writeFile(join(directory, "001_initial.sql"), `CREATE SCHEMA sports;
          SELECT 'ordinary string', $é$BEGIN; COMMIT; END$é$;
          DO $body$ BEGIN PERFORM E'allowed in a body'; END $body$;`);
        const quotedBody = await cli("migrate", ["--dir", directory], name);
        assert.equal(quotedBody.code, 0, quotedBody.output);
      } finally {
        await client.end();
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture clubs must be distinct participants in the same season", async () => {
  await transaction("migrator", async (client) => {
    const data = await fixture(client);
    await rejectsSql(client, `INSERT INTO sports.fixtures (provider_id, season_id, home_club_id, away_club_id)
      VALUES ($1, $2, $3, $3)`, [randomUUID(), data.season, data.clubs[0]]);
    const outsider = (await client.query("INSERT INTO sports.clubs (provider_id, name) VALUES ($1, 'Outsider') RETURNING id", [randomUUID()])).rows[0].id;
    await rejectsSql(client, `INSERT INTO sports.fixtures (provider_id, season_id, home_club_id, away_club_id)
      VALUES ($1, $2, $3, $4)`, [randomUUID(), data.season, data.clubs[0], outsider], "23503");
  });
});

test("appearance values preserve missing statistics, valid zero, and minutes above 90", async () => {
  await transaction("migrator", async (client) => {
    const data = await fixture(client);
    await client.query(`INSERT INTO sports.appearances
      (fixture_id, player_id, season_id, club_id, membership_id, participation, minutes, rating, goals)
      VALUES ($1, $2, $3, $4, $5, 'played', 95, 0, 0)`, [data.match, data.player, data.season, data.clubs[0], data.membership]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const appearance = (await client.query("SELECT minutes, rating, goals, tackles FROM sports.appearances WHERE fixture_id=$1 AND player_id=$2", [data.match, data.player])).rows[0];
    assert.equal(appearance.minutes, 95);
    assert.equal(Number(appearance.rating), 0);
    assert.equal(appearance.goals, 0);
    assert.equal(appearance.tackles, null);
    for (const update of ["minutes = -1", "rating = -0.1", "rating = 10.1", ...[
      "goals", "assists", "shots_on_target", "key_passes", "tackles", "interceptions", "saves", "goals_conceded",
    ].map((metric) => `${metric} = -1`)]) {
      await rejectsSql(client, `UPDATE sports.appearances SET ${update} WHERE fixture_id=$1 AND player_id=$2`, [data.match, data.player]);
    }
    await rejectsSql(client, `UPDATE sports.appearances SET participation='dnp' WHERE fixture_id=$1 AND player_id=$2`, [data.match, data.player]);
    await rejectsSql(client, `INSERT INTO sports.appearances (fixture_id, player_id, season_id)
      VALUES ($1, $2, $3)`, [data.match, data.player, data.season], "23505");
  });
});

test("unknown appearances and confirmed DNPs remain distinct from played appearances", async () => {
  await transaction("migrator", async (client) => {
    const data = await fixture(client);
    await client.query(`INSERT INTO sports.appearances (fixture_id, player_id, season_id)
      VALUES ($1, $2, $3)`, [data.match, data.player, data.season]);
    const unknown = (await client.query("SELECT participation, minutes, goals, club_id FROM sports.appearances WHERE player_id=$1", [data.player])).rows[0];
    assert.deepEqual(unknown, { participation: "unknown", minutes: null, goals: null, club_id: null });
    await rejectsSql(client, "UPDATE sports.appearances SET participation='played' WHERE player_id=$1", [data.player]);
    await client.query(`UPDATE sports.appearances SET participation='dnp', club_id=$1, membership_id=$2,
      minutes=0, goals=0 WHERE player_id=$3`, [data.clubs[0], data.membership, data.player]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await rejectsSql(client, "UPDATE sports.appearances SET goals=1 WHERE player_id=$1", [data.player]);
  });
});

test("appearance club and temporal membership cannot contradict the fixture", async () => {
  await transaction("migrator", async (client) => {
    const data = await fixture(client);
    await rejectsSql(client, `INSERT INTO sports.appearances
      (fixture_id, player_id, season_id, club_id, membership_id, participation, minutes)
      VALUES ($1, $2, $3, $4, $5, 'played', 90)`, [data.match, data.player, data.season, data.clubs[2], data.membership], "23503");
    await client.query(`INSERT INTO sports.appearances
      (fixture_id, player_id, season_id, club_id, membership_id, participation, minutes)
      VALUES ($1, $2, $3, $4, $5, 'played', 90)`, [data.match, data.player, data.season, data.clubs[0], data.membership]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await rejectsSql(client, "UPDATE sports.player_memberships SET valid_from='2026-12-01T00:00:00Z' WHERE id=$1", [data.membership]);
    await rejectsSql(client, "UPDATE sports.fixtures SET kickoff_at='2026-06-01T15:00:00Z' WHERE id=$1", [data.match]);
    await rejectsSql(client, "UPDATE sports.fixtures SET home_club_id=$1 WHERE id=$2", [data.clubs[2], data.match]);
  });
});

test("concurrent membership corrections cannot bypass a newly committed appearance", async () => {
  const first = await connect("migrator");
  const second = await connect("migrator");
  let data: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await first.query("BEGIN");
    data = await fixture(first);
    await first.query("COMMIT");
    await first.query("BEGIN");
    await first.query(`INSERT INTO sports.appearances
      (fixture_id,player_id,season_id,club_id,membership_id,participation,minutes)
      VALUES ($1,$2,$3,$4,$5,'played',90)`, [data.match, data.player, data.season, data.clubs[0], data.membership]);
    await first.query("SET CONSTRAINTS ALL IMMEDIATE");
    await second.query("BEGIN");
    const secondPid = Number((await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const correction = second.query("UPDATE sports.player_memberships SET valid_from='2026-12-01T00:00:00Z' WHERE id=$1", [data.membership]);
    const observedCorrection = correction.then(() => null, (error: unknown) => error);
    let blocked = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const blockers = (await administrator.query("SELECT pg_blocking_pids($1) AS pids", [secondPid])).rows[0].pids as number[];
      if (blockers.length) { blocked = true; break; }
      await pause(10);
    }
    assert.equal(blocked, true, "membership correction must wait for the appearance's parent lock");
    await first.query("COMMIT");
    assert.equal(await observedCorrection, null);
    await assert.rejects(second.query("COMMIT"), (error: unknown) => (error as { code?: string }).code === "23514");
  } finally {
    await first.query("ROLLBACK");
    await second.query("ROLLBACK");
    await first.end();
    await second.end();
    if (data) await cleanupFixture(data);
  }
});

test("fixture and membership corrections cannot jointly invalidate an appearance at READ COMMITTED", async () => {
  const first = await connect("migrator");
  const second = await connect("migrator");
  let data: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await first.query("BEGIN");
    data = await fixture(first);
    await first.query("UPDATE sports.fixtures SET kickoff_at='2026-08-01T15:00:00Z' WHERE id=$1", [data.match]);
    await first.query("UPDATE sports.player_memberships SET valid_until='2026-09-01T00:00:00Z' WHERE id=$1", [data.membership]);
    await first.query(`INSERT INTO sports.appearances
      (fixture_id,player_id,season_id,club_id,membership_id,participation,minutes)
      VALUES ($1,$2,$3,$4,$5,'played',90)`, [data.match, data.player, data.season, data.clubs[0], data.membership]);
    await first.query("COMMIT");
    await Promise.all([first.query("BEGIN"), second.query("BEGIN")]);
    // Start both correction transactions from the same committed context.
    const snapshotSql = `SELECT f.kickoff_at,m.valid_until FROM sports.fixtures f
      CROSS JOIN sports.player_memberships m WHERE f.id=$1 AND m.id=$2`;
    await Promise.all([first.query(snapshotSql, [data.match, data.membership]), second.query(snapshotSql, [data.match, data.membership])]);
    // Both non-key parent corrections must exist before either validation runs;
    // otherwise a scheduler could serialize the original write-skew scenario.
    await Promise.all([
      first.query("UPDATE sports.fixtures SET kickoff_at='2026-08-10T15:00:00Z' WHERE id=$1", [data.match]),
      second.query("UPDATE sports.player_memberships SET valid_until='2026-08-05T00:00:00Z' WHERE id=$1", [data.membership]),
    ]);
    const correct = async (client: Client) => {
      try {
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("COMMIT");
        return { committed: true, code: null };
      } catch (error) {
        await client.query("ROLLBACK");
        return { committed: false, code: (error as { code?: string }).code };
      }
    };
    const results = await Promise.all([
      correct(first), correct(second),
    ]);
    assert.equal(results.filter((result) => result.committed).length, 1, "both individually valid corrections cannot commit together");
    for (const result of results.filter((result) => !result.committed)) {
      assert.ok(["23514", "40P01", "40001"].includes(result.code ?? ""), `unexpected correction failure: ${result.code}`);
    }
    const persisted = (await administrator.query(`SELECT f.kickoff_at >= m.valid_from
      AND (m.valid_until IS NULL OR f.kickoff_at < m.valid_until) AS valid
      FROM sports.appearances a JOIN sports.fixtures f ON f.id=a.fixture_id
      JOIN sports.player_memberships m ON m.id=a.membership_id WHERE a.fixture_id=$1`, [data.match])).rows[0];
    assert.equal(persisted.valid, true);
  } finally {
    await first.query("ROLLBACK");
    await second.query("ROLLBACK");
    await first.end();
    await second.end();
    if (data) await cleanupFixture(data);
  }
});

test("source imports deduplicate and normalized revision chains stay acyclic and entity-specific", async () => {
  await transaction("writer", async (client) => {
    const first = await revision(client, "fixture");
    await rejectsSql(client, `INSERT INTO sports.source_revisions
      (action, resource_key, archive_ref, content_sha256, retrieved_at)
      VALUES ('get_events', $1, $2, $3, now())`, [first.token, `mongo:test:${randomUUID()}`, "a".repeat(64)], "23505");
    await rejectsSql(client, `INSERT INTO sports.source_revisions
      (action, resource_key, archive_ref, content_sha256, retrieved_at)
      VALUES ('get_events', $1, $2, 'invalid-hash', now())`, [randomUUID(), `mongo:test:${randomUUID()}`]);
    await rejectsSql(client, `INSERT INTO sports.normalized_revisions
      (source_revision_id, entity_type, entity_key, content_sha256)
      VALUES ($1, 'fixture', 'test-entity', $2)`, [first.source, "b".repeat(64)], "23505");
    const second = await revision(client, "fixture", first.normalized);
    assert.equal((await client.query("SELECT parent_id FROM sports.normalized_revisions WHERE id=$1", [second.normalized])).rows[0].parent_id, first.normalized);
    await rejectsSql(client, `INSERT INTO sports.normalized_revisions
      (source_revision_id, entity_type, entity_key, content_sha256, parent_id)
      VALUES ($1, 'player', 'different-entity', $2, $3)`, [first.source, "c".repeat(64), first.normalized], "23503");
  });
  await transaction("migrator", async (client) => {
    const first = await revision(client, "fixture");
    const second = await revision(client, "fixture", first.normalized);
    await rejectsSql(client, "UPDATE sports.normalized_revisions SET parent_id=$1 WHERE id=$2", [second.normalized, first.normalized]);
  });
});

test("standings preserve local-day context and cannot claim incomplete coverage as complete", async () => {
  await transaction("writer", async (client) => {
    const data = await fixture(client);
    const provenance = await revision(client);
    const snapshot = (await client.query(`INSERT INTO sports.standings_snapshots
      (season_id, cutoff_local_date, cutoff_at, normalized_revision_id)
      VALUES ($1, '2026-08-01', '2026-07-31T23:00:00Z', $2) RETURNING id`, [data.season, provenance.normalized])).rows[0].id as string;
    await client.query(`INSERT INTO sports.standings_rows
      (snapshot_id,season_id,club_id,position,played,wins,draws,losses,goals_for,goals_against,points)
      VALUES ($1,$2,$3,1,0,0,0,0,0,0,-4)`, [snapshot, data.season, data.clubs[0]]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await rejectsSql(client, `INSERT INTO sports.standings_snapshots
      (season_id, cutoff_local_date, cutoff_at, normalized_revision_id)
      VALUES ($1,'2026-08-02','2026-08-02T00:00:00Z',$2)`, [data.season, provenance.normalized]);
    await rejectsSql(client, `INSERT INTO sports.standings_rows
      (snapshot_id,season_id,club_id,position,played,wins,draws,losses,goals_for,goals_against,points)
      VALUES ($1,$2,$3,25,0,0,0,0,0,0,0)`, [snapshot, data.season, data.clubs[1]]);
    await rejectsSql(client, `INSERT INTO sports.standings_rows
      (snapshot_id,season_id,club_id,position,played,wins,draws,losses,goals_for,goals_against,points)
      VALUES ($1,$2,$3,2,1,0,0,0,0,0,0)`, [snapshot, data.season, data.clubs[1]]);
    await rejectsSql(client, "UPDATE sports.competitions SET timezone='Europe/Paris' WHERE id=$1", [data.competition]);
    await client.query(`INSERT INTO sports.points_adjustments
      (season_id,club_id,points,reason,effective_at,provenance_url,normalized_revision_id)
      VALUES ($1,$2,-4,'Test deduction','2026-07-01T00:00:00Z','https://example.test/decision',$3)`, [data.season, data.clubs[0], provenance.normalized]);
    await rejectsSql(client, `INSERT INTO sports.points_adjustments
      (season_id,club_id,points,reason,effective_at,provenance_url)
      VALUES ($1,$2,0,'No adjustment','2026-07-01T00:00:00Z','https://example.test/none')`, [data.season, data.clubs[0]]);
  });
  await transaction("migrator", async (client) => {
    const data = await fixture(client);
    const provenance = await revision(client);
    await rejectsSql(client, `INSERT INTO sports.standings_snapshots
      (season_id,cutoff_local_date,cutoff_at,normalized_revision_id,complete)
      VALUES ($1,'2026-11-01','2026-11-01T00:00:00Z',$2,true)`, [data.season, provenance.normalized]);
  });
});

test("outbox deduplication and job lease/retry constraints reject contradictory work states", async () => {
  await transaction("writer", async (client) => {
    const key = randomUUID();
    const outbox = (await client.query(`INSERT INTO sports.outbox
      (event_type,aggregate_type,aggregate_id,deduplication_key)
      VALUES ('fixture.final','fixture',$1,$2) RETURNING id`, [randomUUID(), key])).rows[0].id as string;
    await rejectsSql(client, `INSERT INTO sports.outbox (event_type,aggregate_type,aggregate_id,deduplication_key)
      VALUES ('fixture.final','fixture',$1,$2)`, [randomUUID(), key], "23505");
    await rejectsSql(client, `INSERT INTO sports.outbox
      (event_type,aggregate_type,aggregate_id,deduplication_key,payload)
      VALUES ('fixture.final','fixture',$1,$2,'[]'::jsonb)`, [randomUUID(), randomUUID()]);
    await rejectsSql(client, "UPDATE sports.outbox SET payload='{}'::jsonb WHERE id=$1", [outbox], "42501");
    await rejectsSql(client, "UPDATE sports.outbox SET deduplication_key=$1 WHERE id=$2", [randomUUID(), outbox], "42501");
    await client.query("UPDATE sports.outbox SET published_at=now() WHERE id=$1", [outbox]);
    const job = (await client.query(`INSERT INTO sports.jobs (outbox_id,kind,deduplication_key)
      VALUES ($1,'refresh',$2) RETURNING id`, [outbox, randomUUID()])).rows[0].id as string;
    await rejectsSql(client, "UPDATE sports.jobs SET payload='{}'::jsonb WHERE id=$1", [job], "42501");
    await rejectsSql(client, "UPDATE sports.jobs SET status='running' WHERE id=$1", [job]);
    await rejectsSql(client, "UPDATE sports.jobs SET attempts=max_attempts WHERE id=$1", [job]);
    await rejectsSql(client, "UPDATE sports.jobs SET attempts=-1 WHERE id=$1", [job]);
    await rejectsSql(client, "UPDATE sports.jobs SET status='succeeded' WHERE id=$1", [job]);
    await client.query(`UPDATE sports.jobs SET status='running', attempts=1,
      locked_by='test-worker', locked_until=now()+interval '1 minute' WHERE id=$1`, [job]);
    await client.query(`UPDATE sports.jobs SET status='succeeded', locked_by=NULL,
      locked_until=NULL, completed_at=now() WHERE id=$1`, [job]);
    assert.equal((await client.query("SELECT status,attempts FROM sports.jobs WHERE id=$1", [job])).rows[0].status, "succeeded");
    await rejectsSql(client, `INSERT INTO sports.jobs (outbox_id,kind,deduplication_key)
      VALUES ($1,'refresh',$2)`, [randomUUID(), randomUUID()], "23503");
    await client.query(`INSERT INTO sports.audit_log (actor_type,action,entity_type,entity_key)
      VALUES ('worker','refresh','fixture',$1)`, [randomUUID()]);
    await rejectsSql(client, `INSERT INTO sports.audit_log (actor_type,action,entity_type,entity_key)
      VALUES ('user','refresh','fixture',$1)`, [randomUUID()]);
  });
});

test("writer can atomically append a complete standings snapshot and all registered clubs", async () => {
  await transaction("writer", async (client) => {
    const data = await fixture(client);
    await client.query("UPDATE sports.competition_seasons SET expected_clubs=3 WHERE id=$1", [data.season]);
    const provenance = await revision(client);
    const snapshot = (await client.query(`INSERT INTO sports.standings_snapshots
      (season_id,cutoff_local_date,cutoff_at,normalized_revision_id,complete)
      VALUES ($1,'2026-11-01','2026-11-01T00:00:00Z',$2,true) RETURNING id`, [data.season, provenance.normalized])).rows[0].id as string;
    for (const [index, club] of data.clubs.entries()) {
      await client.query(`INSERT INTO sports.standings_rows
        (snapshot_id,season_id,club_id,position,played,wins,draws,losses,goals_for,goals_against,points)
        VALUES ($1,$2,$3,$4,0,0,0,0,0,0,0)`, [snapshot, data.season, club, index + 1]);
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    assert.equal(Number((await client.query("SELECT count(*) AS count FROM sports.standings_rows WHERE snapshot_id=$1", [snapshot])).rows[0].count), 3);
  });
});

test("standings context writes reject a fixed transaction snapshot before any standings exist", async () => {
  const owner = await connect("migrator");
  let data: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await owner.query("BEGIN");
    data = await fixture(owner);
    await owner.query("COMMIT");
    const context = data;
    await transaction("writer", async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await rejectsSql(client, "DELETE FROM sports.season_clubs WHERE season_id=$1 AND club_id=$2", [context.season, context.clubs[2]], "0A000");
      await rejectsSql(client, "UPDATE sports.competitions SET timezone='Europe/Paris' WHERE id=$1", [context.competition], "0A000");
      await rejectsSql(client, "UPDATE sports.competition_seasons SET expected_clubs=expected_clubs WHERE id=$1", [context.season], "0A000");
    });
  } finally {
    await owner.query("ROLLBACK");
    await owner.end();
    if (data) await cleanupFixture(data);
  }
});

test("appearance context writes reject fixed snapshots even when a newly committed appearance is invisible", async () => {
  const owner = await connect("migrator");
  let data: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await owner.query("BEGIN");
    data = await fixture(owner);
    await owner.query("COMMIT");
    const context = data;
    await transaction("writer", async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const count = async () => Number((await client.query("SELECT count(*) AS count FROM sports.appearances WHERE fixture_id=$1", [context.match])).rows[0].count);
      assert.equal(await count(), 0);
      // Every entry point must reject the isolation level before scanning rows.
      await rejectsSql(client, "UPDATE sports.fixtures SET kickoff_at=kickoff_at WHERE id=$1", [context.match], "0A000");
      await rejectsSql(client, "UPDATE sports.player_memberships SET valid_until=valid_until WHERE id=$1", [context.membership], "0A000");
      await rejectsSql(client, `INSERT INTO sports.appearances (fixture_id,player_id,season_id)
        VALUES ($1,$2,$3)`, [context.match, context.player, context.season], "0A000");
      await owner.query("BEGIN");
      await owner.query(`INSERT INTO sports.appearances
        (fixture_id,player_id,season_id,club_id,membership_id,participation,minutes)
        VALUES ($1,$2,$3,$4,$5,'played',90)`, [context.match, context.player, context.season, context.clubs[0], context.membership]);
      await owner.query("COMMIT");
      assert.equal(await count(), 0, "the fixed snapshot cannot see the committed appearance");
      await rejectsSql(client, "UPDATE sports.fixtures SET kickoff_at='2026-06-01T15:00:00Z' WHERE id=$1", [context.match], "0A000");
      await rejectsSql(client, "UPDATE sports.player_memberships SET valid_from='2026-12-01T00:00:00Z' WHERE id=$1", [context.membership], "0A000");
    });
  } finally {
    await owner.query("ROLLBACK");
    await owner.end();
    if (data) await cleanupFixture(data);
  }
});

test("reader and writer logins enforce database access boundaries", async () => {
  await transaction("reader", async (client) => {
    await client.query("SELECT id FROM sports.competitions LIMIT 1");
    await rejectsSql(client, "DELETE FROM sports.competitions WHERE false", [], "42501");
    await rejectsSql(client, "SELECT * FROM auth.session LIMIT 1", [], "42501");
    await rejectsSql(client, "SELECT * FROM sports.jobs LIMIT 1", [], "42501");
    await rejectsSql(client, "SET ROLE lsp_migrator", [], "42501");
  });
  await transaction("writer", async (client) => {
    await client.query(`INSERT INTO sports.clubs (provider_id, name) VALUES ($1, 'Writer club')`, [randomUUID()]);
    await rejectsSql(client, "CREATE TABLE sports.forbidden_ddl (id integer)", [], "42501");
    await rejectsSql(client, "CREATE TABLE public.forbidden_ddl (id integer)", [], "42501");
    await rejectsSql(client, "CREATE TEMP TABLE forbidden_temporary (id integer)", [], "42501");
    await rejectsSql(client, "DELETE FROM sports.source_revisions WHERE false", [], "42501");
    await rejectsSql(client, "UPDATE sports.audit_log SET id=id WHERE false", [], "42501");
    await rejectsSql(client, "SELECT * FROM auth.\"user\" LIMIT 1", [], "42501");
    await rejectsSql(client, "SET ROLE lsp_migrator", [], "42501");
  });
});

test("auth storage supports sessions while role changes remain server-managed", async () => {
  await transaction("auth", async (client) => {
    const user = randomUUID();
    await client.query('INSERT INTO auth."user" (id, name, email) VALUES ($1, $2, $3)', [user, "Viewer", `${user}@example.test`]);
    assert.equal((await client.query('SELECT role FROM auth."user" WHERE id=$1', [user])).rows[0].role, "viewer");
    await client.query('UPDATE auth."user" SET name=$1 WHERE id=$2', ["Updated viewer", user]);
    await rejectsSql(client, 'UPDATE auth."user" SET role=\'admin\' WHERE id=$1', [user], "42501");
    await rejectsSql(client, 'INSERT INTO auth."user" (id,name,email,role) VALUES ($1,\'Forged\',$2,\'admin\')', [randomUUID(), `${randomUUID()}@example.test`], "42501");
    await client.query('INSERT INTO auth.session (id,token,"userId","expiresAt") VALUES ($1,$2,$3,now()+interval \'1 hour\')', [randomUUID(), randomUUID(), user]);
    await client.query('INSERT INTO auth.account (id,"accountId","providerId","userId",password) VALUES ($1,$2,\'credential\',$3,\'test-hash\')', [randomUUID(), user, user]);
    await client.query('INSERT INTO auth.verification (id,identifier,value,"expiresAt") VALUES ($1,$2,\'test-value\',now()+interval \'1 hour\')', [randomUUID(), user]);
    await rejectsSql(client, 'INSERT INTO auth.session (id,token,"userId","expiresAt") VALUES ($1,$2,$3,now()+interval \'1 hour\')', [randomUUID(), randomUUID(), randomUUID()], "23503");
    await rejectsSql(client, "SELECT * FROM sports.competitions LIMIT 1", [], "42501");
    await rejectsSql(client, 'DELETE FROM auth."user" WHERE id=$1', [user], "42501");
    await client.query('DELETE FROM auth.session WHERE "userId"=$1', [user]);
  });
});

test("authentication identity constraints reject duplicate emails and invalid roles", async () => {
  await transaction("migrator", async (client) => {
    const email = `${randomUUID()}@example.test`;
    await client.query('INSERT INTO auth."user" (id,name,email,role) VALUES ($1,\'Admin\',$2,\'admin\')', [randomUUID(), email]);
    await rejectsSql(client, 'INSERT INTO auth."user" (id,name,email) VALUES ($1,\'Duplicate\',$2)', [randomUUID(), email.toUpperCase()], "23505");
    await rejectsSql(client, 'INSERT INTO auth."user" (id,name,email,role) VALUES ($1,\'Invalid\',$2,\'superadmin\')', [randomUUID(), `${randomUUID()}@example.test`]);
  });
});

test("runtime roles cannot inherit migration-owner or server administration privileges", async () => {
  const result = await administrator.query(`SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
    pg_has_role(rolname, 'lsp_migrator', 'MEMBER') AS migrator_member
    FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`, [["lsp_reader", "lsp_writer", "lsp_auth"]]);
  assert.equal(result.rows.length, 3);
  for (const role of result.rows) {
    for (const flag of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "migrator_member"]) {
      assert.equal(role[flag], false, `${role.rolname}: ${flag}`);
    }
  }
});
