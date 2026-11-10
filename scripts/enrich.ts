import { EnrichmentPipeline } from "../src/server/ingestion/enrichment";
import { createRuntime } from "../src/server/ingestion/runtime";
import { required } from "../src/server/ingestion/connections";
import { RateLimitError } from "../src/server/ingestion/store";

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((value) => value.startsWith("--"));
  const sizes = args.filter((value) => !value.startsWith("--"));
  if (new Set(flags).size !== flags.length || flags.some((value) => !["--cached-only", "--use-reserve"].includes(value))
    || sizes.length > 1 || flags.length > 1) throw new Error("Use one optional batch size and either --cached-only or --use-reserve");
  const limit = Number(sizes[0] ?? 2);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Use a batch size between 1 and 100");
  const runtime = await createRuntime(false);
  try {
    try {
      const pipeline = new EnrichmentPipeline(runtime.pool, runtime.db, required("HIGHLIGHTLY_API_KEY"), {
        requestReserve: flags.includes("--use-reserve") ? 0 : 5,
      });
      console.info(JSON.stringify(flags.includes("--cached-only") ? await pipeline.reprocessCached() : await pipeline.run(limit)));
    } catch (error) {
      if (error instanceof RateLimitError) console.info(JSON.stringify({ state: "budget-deferred", retryAt: error.retryAt.toISOString() }));
      else throw error;
    }
    console.info(JSON.stringify(await runtime.forecasts.refreshAll()));
  } finally { await runtime.close(); }
}
main().catch(() => { console.error("Supplementary ingestion failed; check source configuration, migrations and archive status."); process.exitCode = 1; });
