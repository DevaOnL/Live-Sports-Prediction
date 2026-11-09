import { randomUUID } from "node:crypto";
import { writerPool } from "../src/server/ingestion/connections";
import { ForecastStore } from "../src/server/forecast/store";

async function main() {
  const [command = "status", argument, cutoffText, ...extra] = process.argv.slice(2);
  const playerId = /^[1-9]\d{0,17}$/.test(argument ?? "") && Number.isSafeInteger(Number(argument));
  const requestId = argument ?? randomUUID();
  const historyCutoff = cutoffText ?? new Date().toISOString();
  const valid = command === "status" ? !argument && !cutoffText
    : command === "request" ? !cutoffText && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
    : command === "history" ? playerId && Number.isFinite(Date.parse(historyCutoff))
    : command === "refresh" ? !cutoffText && (playerId || argument === "all")
    : (command === "show" || command === "lineage") && playerId && !cutoffText;
  if (!valid || extra.length) throw new Error("Invalid forecast command");
  const pool = writerPool();
  try {
    const store = new ForecastStore(pool);
    if (command === "status") console.info(JSON.stringify(await store.status()));
    else if (command === "show") console.info(JSON.stringify(await store.show(argument)));
    else if (command === "history") {
      const cutoffAt = new Date(historyCutoff).toISOString();
      const rows = await pool.query("SELECT * FROM sports.player_qualifying_history($1,$2::timestamptz)", [argument, cutoffAt]);
      console.info(JSON.stringify({ playerId: argument, cutoffAt, scope: "eligible-candidates", completeHistoryVerified: false, appearances: rows.rows }));
    } else if (command === "lineage") {
      console.info(JSON.stringify((await pool.query("SELECT * FROM sports.forecast_lineage($1)", [argument])).rows));
    } else if (command === "request") {
      await pool.query("CALL sports.request_forecast_refresh($1::uuid)", [requestId]);
      console.info(JSON.stringify({ requestId: requestId.toLowerCase(), scope: "all" }));
    } else console.info(JSON.stringify(argument === "all" ? await store.refreshAll() : await store.refresh(argument)));
  } finally { await pool.end(); }
}

main().catch(() => {
  console.error("Forecast command failed; use status, show PLAYER_ID, refresh PLAYER_ID|all, history PLAYER_ID [cutoff], lineage PLAYER_ID, or request [UUID] after database migration.");
  process.exitCode = 1;
});
