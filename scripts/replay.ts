import pg from "pg";
import { port, required } from "../src/server/ingestion/connections";
import { runReplay } from "../src/server/replay/run";
import { readReplaySnapshot } from "../src/server/replay/snapshot";

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("Usage: npm run replay");
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const source = new pg.Pool({ host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: port("POSTGRES_PORT", "5432"),
    database: process.env.POSTGRES_DB ?? "sports", user: "lsp_reader", password: required("POSTGRES_READER_PASSWORD"),
    options: "-c search_path=pg_catalog -c default_transaction_read_only=on", application_name: "live-sports-historical-replay-reader",
    connectionTimeoutMillis: 5_000, statement_timeout: 120_000, max: 1 });
  source.on("error", interrupted);
  try {
    const snapshot = await readReplaySnapshot(source, abort.signal);
    await source.end();
    const report = await runReplay(snapshot, abort.signal);
    console.info(JSON.stringify(report));
  } finally {
    await source.end().catch(() => undefined);
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }
}

main().catch(() => {
  console.error("Historical replay failed. Check the restricted reader connection, approved data prerequisites and Linux Docker with PostgreSQL 17. The source is read-only; inspect the documented ownership label if Docker cleanup cannot complete.");
  process.exitCode = 1;
});
