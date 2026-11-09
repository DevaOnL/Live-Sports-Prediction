import { writerPool } from "../src/server/ingestion/connections";
import { ForecastStore } from "../src/server/forecast/store";

async function main() {
  const [command = "status", playerId, ...extra] = process.argv.slice(2);
  if (!(["status", "show", "refresh"].includes(command)) || extra.length
    || (command === "status" && playerId) || (command !== "status" && !playerId)
    || (playerId && !(command === "refresh" && playerId === "all") && !/^[1-9]\d{0,17}$/.test(playerId))) {
    throw new Error("Invalid forecast command");
  }
  const pool = writerPool();
  try {
    const store = new ForecastStore(pool);
    if (command === "status") console.info(JSON.stringify(await store.status()));
    else if (command === "show") console.info(JSON.stringify(await store.show(playerId)));
    else console.info(JSON.stringify(playerId === "all" ? await store.refreshAll() : await store.refresh(playerId)));
  } finally { await pool.end(); }
}

main().catch(() => {
  console.error("Forecast command failed; use status, show PLAYER_ID, or refresh PLAYER_ID|all after database migration and roster reconciliation.");
  process.exitCode = 1;
});
