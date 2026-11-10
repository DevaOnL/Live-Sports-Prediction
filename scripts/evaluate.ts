import pg from "pg";
import { port, required } from "../src/server/ingestion/connections";
import { readFrozenEvaluation } from "../src/server/evaluation/database";

async function main() {
  if (process.argv.length !== 2) throw new Error("The evaluation protocol is fixed");
  const pool = new pg.Pool({
    host: process.env.POSTGRES_HOST ?? "127.0.0.1", port: port("POSTGRES_PORT", "5432"),
    database: process.env.POSTGRES_DB ?? "sports", user: "lsp_reader", password: required("POSTGRES_READER_PASSWORD"),
    options: "-c search_path=pg_catalog", connectionTimeoutMillis: 5_000, statement_timeout: 120_000, max: 1,
    application_name: "live-sports-evaluation",
  });
  pool.on("error", () => undefined);
  try { console.info(JSON.stringify((await readFrozenEvaluation(pool)).report)); }
  finally { await pool.end(); }
}

main().catch(() => {
  console.error("Evaluation failed; configure the restricted reader connection after migration.");
  process.exitCode = 1;
});
