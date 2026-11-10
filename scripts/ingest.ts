import { createRuntime } from "../src/server/ingestion/runtime";
import { RateLimitError } from "../src/server/ingestion/store";
import { ProviderError } from "../src/server/ingestion/provider";
import { sourceSeasonGuard } from "../src/server/ingestion/sources";

async function main() {
  const [command, id, ...extra] = process.argv.slice(2);
  if (!command || !["sync", "once", "reconcile", "status", "retry"].includes(command) || extra.length || (command === "retry") !== Boolean(id)) {
    throw new Error("Usage: npm run ingest -- sync|once|reconcile|status|retry <job-id>");
  }
  const runtime = await createRuntime(command === "sync" || command === "once");
  try {
    if (command === "sync") {
      const imports = await runtime.pipeline.sync();
      await runtime.queue.scheduleStatistics();
      const dispatched = await runtime.queue.dispatch(500);
      console.info(JSON.stringify({ imports, dispatched }));
    } else if (command === "once") {
      await runtime.pipeline.reconcile();
      await runtime.queue.dispatch(500);
      let processed = 0;
      // Bounded operator command; the long-running worker continues the backlog.
      while (processed < 10 && await runtime.queue.runOnce(runtime.handle)) processed++;
      console.info(JSON.stringify({ processed, jobs: await runtime.queue.status() }));
    } else if (command === "reconcile") {
      console.info(JSON.stringify({ reconciled: await runtime.pipeline.reconcile() }));
    } else if (command === "retry") {
      console.info(JSON.stringify({ retried: await runtime.queue.retryFailed(id) }));
    } else {
      const fixtures = await runtime.pool.query(`SELECT c.provider_id AS league_id,f.status,f.statistics_status,count(*)::text AS count
        FROM sports.fixtures f JOIN sports.competition_seasons s ON s.id=f.season_id
        JOIN sports.competitions c ON c.id=s.competition_id WHERE f.provider=$1 AND ${sourceSeasonGuard(runtime.profile, "s", "c")}
        GROUP BY c.provider_id,f.status,f.statistics_status ORDER BY 1,2,3`, [runtime.profile.provider]);
      const archives = await runtime.db.collection("raw_archives").aggregate([
        { $match: runtime.profile.provider === "sorare" ? { "params.provider": "sorare" } : { "params.provider": { $exists: false } } },
        { $lookup: { from: "import_metadata", localField: "_id", foreignField: "_id", as: "metadata" } },
        { $unwind: "$metadata" }, { $group: { _id: "$metadata.state", count: { $sum: 1 } } },
      ]).toArray();
      const limit = runtime.profile.provider === "sorare" ? 60 : 120;
      const windowSeconds = runtime.profile.provider === "sorare" ? 60 : 3600;
      const budget = await runtime.pool.query(`SELECT count(*)::int AS used,$1::int-count(*)::int AS remaining
        FROM sports.provider_requests WHERE attempted_at>clock_timestamp()-($2::int*interval '1 second')
          AND ${runtime.profile.provider === "sorare" ? "resource_key LIKE 'sorare:%'" : "resource_key NOT LIKE 'sorare:%'"}`, [limit, windowSeconds]);
      const reconciliation = await runtime.pool.query(`SELECT entity_key,detail->'complete' AS complete,detail->'mismatches' AS mismatches,
        detail->'reconstructionIssues' AS issues,occurred_at FROM sports.audit_log
        WHERE action='reconcile' AND ${runtime.profile.provider === "sorare" ? "entity_key LIKE 'sorare:%'" : "entity_key NOT LIKE 'sorare:%'"}
        ORDER BY occurred_at DESC LIMIT 2`);
      console.info(JSON.stringify({ provider: runtime.profile.provider, fixtures: fixtures.rows, archives,
        budget: { ...budget.rows[0], limit, windowSeconds }, jobs: await runtime.queue.status(), failures: await runtime.queue.failures(), reconciliation: reconciliation.rows }));
    }
  } finally { await runtime.close(); }
}

main().catch((error: unknown) => {
  if (error instanceof RateLimitError) console.error(`Request budget exhausted; retry after ${error.retryAt.toISOString()}`);
  else if (error instanceof ProviderError) console.error(error.message);
  else console.error("Ingestion command failed; verify command, services, migrations, and local runtime configuration.");
  process.exitCode = 1;
});
