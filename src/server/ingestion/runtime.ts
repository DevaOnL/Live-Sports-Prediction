import { mongoConnection, mongoDatabase, writerPool, required } from "./connections";
import { JobQueue, type IngestionJob } from "./jobs";
import { coverageFor } from "./coverage";
import { IngestionPipeline } from "./pipeline";
import { ForecastStore } from "../forecast/store";

export async function createRuntime(needsProvider = true) {
  const pool = writerPool();
  const mongo = mongoConnection();
  try {
    await mongo.connect();
    await pool.query("SELECT 1 FROM sports.ingestion_batches LIMIT 0");
    await pool.query("SELECT 1 FROM sports.roster_snapshots,sports.roster_entries,sports.forecast_revisions,sports.forecast_heads LIMIT 0");
    const db = mongo.db(mongoDatabase());
    await db.collection("raw_archives").findOne({}, { projection: { _id: 1 } });
    const pipeline = new IngestionPipeline(pool, db, needsProvider ? required("APIFOOTBALL_API_KEY") : "offline-reconciliation");
    const queue = new JobQueue(pool, undefined, true);
    const forecasts = new ForecastStore(pool);
    const handle = async (job: IngestionJob) => {
      if (job.kind === "fixture.statistics") await pipeline.statistics(job.payload.leagueId, job.payload.fixtureId);
      else if (job.kind === "standings.rebuild") await pipeline.store.rebuild(coverageFor(job.payload.leagueId));
      else await forecasts.refreshAll();
    };
    return {
      pool, mongo, db, pipeline, queue, forecasts, handle,
      async ping() {
        await pool.query("SELECT 1");
        await db.collection("import_metadata").findOne({}, { projection: { _id: 1 } });
      },
      async close() { await Promise.all([pool.end(), mongo.close()]); },
    };
  } catch {
    await Promise.allSettled([pool.end(), mongo.close()]);
    throw new Error("Ingestion connections unavailable; check migrations and runtime credentials");
  }
}
