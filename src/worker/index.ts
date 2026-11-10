import { createServer } from "node:http";
import { setTimeout as pause } from "node:timers/promises";
import { port } from "../server/ingestion/connections";
import { createRuntime } from "../server/ingestion/runtime";
import { ProviderError } from "../server/ingestion/provider";
import { RateLimitError } from "../server/ingestion/store";
import { pollForecasts } from "./forecast-polling";

async function main() {
  const enabledText = process.env.INGESTION_ENABLED ?? "false";
  if (!["true", "false"].includes(enabledText)) throw new Error("Invalid INGESTION_ENABLED");
  const enabled = enabledText === "true";
  const listenPort = port("WORKER_PORT", "4001");
  const runtime = enabled ? await createRuntime() : null;
  const abort = new AbortController();
  let stopping = false;
  let lastProgress = Date.now();
  let nextSync = 0;
  let lastSync: string | null = null;
  let sourceState = enabled ? "awaiting-sync" : "disabled";
  let persistenceUp = true;
  let forecastsUp = true;
  let lastForecastProgress = Date.now();
  let supplementState = runtime?.enrichment ? "awaiting-sync" : "disabled";
  let nextSupplement = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end(JSON.stringify({ error: "Not found" })); return;
    }
    let databases = false;
    if (runtime) {
      try { await runtime.ping(); databases = true; } catch { /* Return health state without connection diagnostics. */ }
    }
    const healthy = !stopping && (!enabled || (databases && persistenceUp && forecastsUp
      && Date.now() - lastProgress < 300_000 && Date.now() - lastForecastProgress < 300_000));
    response.writeHead(healthy ? 200 : 503).end(JSON.stringify({
      service: "worker", status: healthy ? "alive" : "unavailable", scope: enabled ? "ingestion" : "process-only",
      jobsEnabled: enabled, databaseConnections: databases, lastSync, sourceState,
      predictionsEnabled: enabled,
      supplementState,
      forecastPolling: enabled ? forecastsUp && Date.now() - lastForecastProgress < 300_000 ? "alive" : "unavailable" : "disabled",
    }));
  });
  server.listen(listenPort, "0.0.0.0", () => console.info(`Worker health listening on ${listenPort}; ingestion ${enabled ? "enabled" : "disabled"}.`));
  const loop = async () => {
    if (!runtime) return;
    while (!stopping) {
      try {
        await runtime.pipeline.reconcile();
        if (Date.now() >= nextSync) {
          try {
            await runtime.pipeline.sync();
            await runtime.queue.scheduleStatistics();
            lastSync = new Date().toISOString();
            sourceState = "synced";
            nextSync = Date.now() + 900_000;
          } catch (error) {
            if (error instanceof RateLimitError) { sourceState = "budget-deferred"; nextSync = Math.max(Date.now() + 1000, error.retryAt.getTime()); }
            else if (error instanceof ProviderError) { sourceState = error.code; nextSync = Math.max(Date.now() + (error.retryable ? 60_000 : 900_000), error.retryAt?.getTime() ?? 0); }
            else throw error;
          }
        }
        await runtime.queue.dispatch(500);
        // Finite batches allow polling, recovery, and shutdown between jobs.
        for (let index = 0; index < 5 && !stopping; index++) {
          if (!await runtime.queue.runOnce(runtime.handle)) break;
          lastProgress = Date.now();
        }
        persistenceUp = true;
        lastProgress = Date.now();
      } catch {
        persistenceUp = false;
        console.error("Ingestion persistence unavailable; retrying safely.");
      }
      await pause(5_000, undefined, { signal: abort.signal }).catch(() => undefined);
    }
  };
  const supplementLoop = async () => {
    if (!runtime?.enrichment) return;
    while (!stopping) {
      if (Date.now() >= nextSupplement) {
        try {
          const progress = await runtime.enrichment.run(2);
          supplementState = progress.pending ? "backfilling" : progress.unmapped ? "partial" : "synced";
          nextSupplement = Date.now() + (progress.pending ? 60_000 : 3_600_000);
        } catch (error) {
          supplementState = error instanceof RateLimitError ? "budget-deferred" : "source-unavailable";
          nextSupplement = error instanceof RateLimitError ? Math.max(Date.now() + 1000, error.retryAt.getTime()) : Date.now() + 900_000;
        }
      }
      await pause(5_000, undefined, { signal: abort.signal }).catch(() => undefined);
    }
  };
  const running = Promise.all([loop(), supplementLoop(), runtime ? pollForecasts(runtime.queue, runtime.handle, {
    signal: abort.signal,
    onProgress() { forecastsUp = true; lastForecastProgress = Date.now(); },
    onError() { forecastsUp = false; console.error("Forecast persistence unavailable; retrying safely."); },
  }) : Promise.resolve()]);
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    server.close();
    const deadline = setTimeout(() => process.exit(1), 45_000);
    deadline.unref();
    await running;
    await runtime?.close();
    clearTimeout(deadline);
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}

main().catch(() => { console.error("Worker startup failed; check ingestion configuration and database setup."); process.exitCode = 1; });
