import { mongoConnection, mongoDatabase, writerPool, required } from "./connections";
import { JobQueue, type IngestionJob } from "./jobs";
import { runtimeSource, sourceCoverage } from "./sources";
import { IngestionPipeline } from "./pipeline";
import { SorarePipeline } from "./sorare";
import { ForecastStore } from "../forecast/store";

export async function createRuntime(needsProvider = true) {
  const profile = runtimeSource();
  const pool = writerPool();
  const mongo = mongoConnection();
  try {
    await mongo.connect();
    await pool.query("SELECT 1 FROM sports.ingestion_batches LIMIT 0");
    await pool.query("SELECT 1 FROM sports.roster_snapshots,sports.roster_entries,sports.forecast_revisions,sports.forecast_heads LIMIT 0");
    const db = mongo.db(mongoDatabase());
    await db.collection("raw_archives").findOne({}, { projection: { _id: 1 } });
    const pipeline = profile.provider === "sorare"
      ? new SorarePipeline(pool, db, needsProvider ? required("SORARE_API_KEY") : "offline-reconciliation")
      : new IngestionPipeline(pool, db, needsProvider ? required("APIFOOTBALL_API_KEY") : "offline-reconciliation");
    const queue = new JobQueue(pool, undefined, true, profile);
    const forecasts = new ForecastStore(pool, profile);
    const handle = async (job: IngestionJob) => {
      if (job.kind === "fixture.statistics") await pipeline.statistics(job.payload.leagueId, job.payload.fixtureId);
      else if (job.kind === "standings.rebuild") await pipeline.store.rebuild(sourceCoverage(profile, job.payload.leagueId));
      else if (job.kind === "source.sync") {
        await pipeline.sync();
        await queue.scheduleStatistics();
      } else await forecasts.refreshAll();
    };
    return {
      pool, mongo, db, pipeline, queue, forecasts, handle, profile,
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
