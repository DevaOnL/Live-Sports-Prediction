import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { captureProspective, confirmProspectivePersistence, scoreProspective, validateCapture, type ProspectiveCapture } from "../src/server/evaluation/prospective";
import { canonicalJson } from "../src/server/forecast/engine";
import { port, required } from "../src/server/ingestion/connections";

const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
type Confirmation = { schemaVersion: 1; kind: "prospective-confirmation-v1"; captureDigest: string; durablyConfirmedAt: string };

function validateConfirmation(value: unknown, capture: ProspectiveCapture): Confirmation {
  const row = value as Confirmation;
  if (!row || typeof row !== "object" || Array.isArray(row)
    || Object.keys(row).sort().join(",") !== "captureDigest,durablyConfirmedAt,kind,schemaVersion"
    || row.schemaVersion !== 1 || row.kind !== "prospective-confirmation-v1" || row.captureDigest !== capture.digest
    || typeof row.durablyConfirmedAt !== "string" || !Number.isFinite(Date.parse(row.durablyConfirmedAt))
    || new Date(row.durablyConfirmedAt).toISOString() !== row.durablyConfirmedAt || row.durablyConfirmedAt < capture.completedAt
    || capture.fixtures.some((fixture) => row.durablyConfirmedAt >= fixture.issueCutoffAt)) {
    throw new Error("Invalid or unconfirmed private capture");
  }
  return row;
}

async function persistCaptureFile(path: string, value: ProspectiveCapture, confirm?: () => Promise<string>): Promise<string | undefined> {
  const text = `${canonicalJson(validateCapture(value))}\n`;
  if (Buffer.byteLength(text) > MAX_CAPTURE_BYTES - 1024) throw new Error("Capture is too large");
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let identity: { dev: number; ino: number } | undefined;
  try {
    identity = await file.stat();
    await file.chmod(0o600); await file.writeFile(text); await file.sync();
    // Persist the new directory entry as well as the file contents before timing it.
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
    if (!confirm) return undefined;
    const durablyConfirmedAt = await confirm();
    const receipt = validateConfirmation({ schemaVersion: 1, kind: "prospective-confirmation-v1", captureDigest: value.digest, durablyConfirmedAt }, value);
    const current = await lstat(path);
    if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("Capture destination changed");
    // This trailer records a clock read AFTER the capture bytes were durable.
    // A crash before the complete trailer leaves a pending file that scoring rejects.
    // The trailer may persist later: its timestamp attests the earlier capture fsync.
    await file.writeFile(`${canonicalJson(receipt)}\n`);
    await file.sync();
    return durablyConfirmedAt;
  } catch (error) {
    // Never unlink a preexisting path or a replacement installed while awaiting SQL.
    const current = await lstat(path).catch(() => null);
    if (identity && current?.isFile() && current.dev === identity.dev && current.ino === identity.ino) await unlink(path).catch(() => undefined);
    throw error;
  } finally { await file.close(); }
}

/** Pending serialization only. A file without a confirmation trailer cannot be scored. */
export async function writeCaptureFile(path: string, value: ProspectiveCapture): Promise<void> {
  await persistCaptureFile(path, value);
}

/** Existing files are untouched. Failure removes only this newly created inode. */
export async function writeConfirmedCaptureFile(path: string, value: ProspectiveCapture, pool: pg.Pool): Promise<string> {
  return (await persistCaptureFile(path, value, () => confirmProspectivePersistence(pool, value)))!;
}

export async function readCaptureFile(path: string): Promise<ProspectiveCapture> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CAPTURE_BYTES || (stat.mode & 0o777) !== 0o600
      || (process.getuid && stat.uid !== process.getuid())) throw new Error("Capture must be an owned private regular file");
    const lines = (await file.readFile("utf8")).split("\n");
    if (lines.length !== 3 || lines[2] !== "") throw new Error("Invalid or unconfirmed private capture");
    const capture = validateCapture(JSON.parse(lines[0]));
    const receipt = validateConfirmation(JSON.parse(lines[1]), capture);
    if (lines[0] !== canonicalJson(capture) || lines[1] !== canonicalJson(receipt)) throw new Error("Invalid or changed private capture");
    return capture;
  } finally { await file.close(); }
}

async function main() {
  const [command, path, ...extra] = process.argv.slice(2);
  if (!["capture", "score"].includes(command) || !path || extra.length) throw new Error("Use capture PATH or score PATH");
  if (command === "capture") {
    await lstat(path).then(() => { throw new Error("Capture destination already exists"); }, (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const pool = new pg.Pool({ host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: port("POSTGRES_PORT", "5432"),
    database: process.env.POSTGRES_DB ?? "sports", user: "lsp_reader", password: required("POSTGRES_READER_PASSWORD"),
    options: "-c search_path=pg_catalog", connectionTimeoutMillis: 5_000, statement_timeout: 120_000, max: 1,
    application_name: "live-sports-prospective-measurement" });
  pool.on("error", () => undefined);
  try {
    if (command === "capture") {
      const capture = await captureProspective(pool);
      const durablyConfirmedAt = await writeConfirmedCaptureFile(path, capture, pool);
      console.info(JSON.stringify({ schemaVersion: 1, protocol: capture.protocol, captureDigest: capture.digest,
        capturedAt: capture.capturedAt, completedAt: capture.completedAt, durablyConfirmedAt, fixtures: capture.fixtures.length,
        players: capture.players.length, unavailablePlayers: capture.players.filter((row) => row.result.status === "unavailable").length,
        undatedFixturesOutsideUniverse: capture.undatedFixturesOutsideUniverse, missedIssueCutoffs: capture.missedIssueCutoffs.length,
        measurementStatus: capture.fixtures.length ? "awaiting_real_outcomes" : "no_eligible_future_targets",
        unavailableReason: capture.fixtures.length ? null : capture.missedIssueCutoffs.length ? "issue_cutoff_missed" : "no_future_fixture" }));
    } else console.info(JSON.stringify(await scoreProspective(pool, await readCaptureFile(path))));
  } finally { await pool.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Prospective measurement failed; use capture PATH or score PATH with the restricted reader connection and an unchanged private capture.");
    process.exitCode = 1;
  });
}
