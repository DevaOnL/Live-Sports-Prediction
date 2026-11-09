import { setTimeout as pause } from "node:timers/promises";
import type { IngestionJob, JobQueue } from "../server/ingestion/jobs";

type ForecastQueue = Pick<JobQueue, "scheduleForecast" | "dispatch" | "runForecastOnce">;
type PollingOptions = {
  signal: AbortSignal;
  onProgress: () => void;
  onError: () => void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

/** Local refresh continues while source polling waits for upstream responses. */
export async function pollForecasts(queue: ForecastQueue, handle: (job: IngestionJob) => Promise<void>, options: PollingOptions): Promise<void> {
  const wait = options.wait ?? ((milliseconds, signal) => pause(milliseconds, undefined, { signal }));
  while (!options.signal.aborted) {
    try {
      await queue.scheduleForecast();
      if (options.signal.aborted) break;
      await queue.dispatch(500);
      if (options.signal.aborted) break;
      await queue.runForecastOnce(handle);
      options.onProgress();
    } catch { options.onError(); }
    if (options.signal.aborted) break;
    try { await wait(5_000, options.signal); }
    catch { if (!options.signal.aborted) options.onError(); }
  }
}
