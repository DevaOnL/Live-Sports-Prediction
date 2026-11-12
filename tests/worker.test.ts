import assert from "node:assert/strict";
import { test } from "node:test";
import type { IngestionJob } from "../src/server/ingestion/jobs";
import { pollForecasts } from "../src/worker/forecast-polling";
import { supplementFailure, supplementProgress } from "../src/worker/supplement-retry";
import { HighlightlyError } from "../src/server/ingestion/highlightly-client";
import { ProviderError } from "../src/server/ingestion/provider";
import { RateLimitError } from "../src/server/ingestion/store";

test("supplement retries distinguish local allowance, global failures and persistence without exposing error details", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  const reset = new Date(now + 43_200_000);
  assert.deepEqual(supplementFailure(new RateLimitError(reset), 1, now), {
    state: "budget-deferred", retryAt: reset.toISOString(), error: null,
  });
  const global = new HighlightlyError("http_rate_limit", true, "provider", "rate_limit", 429, reset);
  assert.deepEqual(supplementFailure(global, 1, now), {
    state: "http_rate_limit", retryAt: reset.toISOString(), error: { code: "http_rate_limit", reason: "rate_limit", status: 429 },
  });
  const unavailable = new HighlightlyError("http_unavailable", true, "provider", "unavailable", 503, reset);
  assert.equal(supplementFailure(unavailable, 2, now).retryAt, reset.toISOString());
  const transport = new ProviderError("transport_failed", true);
  assert.equal(Date.parse(supplementFailure(transport, 1, now).retryAt) - now, 900_000);
  assert.equal(Date.parse(supplementFailure(transport, 2, now).retryAt) - now, 1_800_000);
  assert.equal(Date.parse(supplementFailure(transport, 100, now).retryAt) - now, 3_600_000);
  const secret = "private-upstream-message-and-key";
  const failure = supplementFailure(new Error(secret), 1, now);
  assert.deepEqual(failure, { state: "processing-failed", retryAt: new Date(now + 60_000).toISOString(), error: { code: "processing_failed" } });
  assert.equal(JSON.stringify(failure).includes(secret), false);
});

test("supplement progress keeps busy and cooling work distinct from successful synchronization", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  const empty = { fixtures: 0, appearances: 0, pending: 0, unmapped: 0 };
  assert.equal(supplementProgress({ ...empty, busy: true }, now).state, "busy");
  const cooling = new Date(now + 600_000).toISOString();
  const waiting = supplementProgress({ ...empty, pending: 2, deferred: 2, retryAt: cooling }, now);
  assert.equal(waiting.state, "waiting-for-data");
  assert.equal(waiting.retryAt, cooling);
  const remaining = supplementProgress({ ...empty, pending: 3, deferred: 2, retryAt: cooling }, now);
  assert.equal(remaining.state, "backfilling");
  assert.equal(Date.parse(remaining.retryAt) - now, 60_000);
  assert.equal(supplementProgress({ ...empty, unmapped: 1 }, now).state, "partial");
  assert.equal(supplementProgress(empty, now).state, "synced");
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function pollingClock() {
  const sleeps: ReturnType<typeof gate>[] = [];
  let sleeping = gate();
  return {
    wait: async (milliseconds: number, signal: AbortSignal) => {
      assert.equal(milliseconds, 5_000);
      const tick = gate();
      sleeps.push(tick);
      sleeping.release();
      const abort = () => tick.release();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) tick.release();
      try { await tick.promise; }
      finally { signal.removeEventListener("abort", abort); }
    },
    asleep: async () => { await sleeping.promise; },
    tick: () => { sleeping = gate(); sleeps.shift()!.release(); },
  };
}

test("an observed final and clock changes refresh locally while source synchronization remains blocked", async () => {
  const sourceRequest = gate();
  let sourceFinished = false;
  const source = sourceRequest.promise.then(() => { sourceFinished = true; });
  const controller = new AbortController();
  const clock = pollingClock();
  const pending = ["canonical.changed"];
  const refreshed: string[][] = [];
  let dispatched: string[] = [];
  let scheduled = 0;
  const queue = {
    scheduleForecast: async () => { pending.push(`clock:${++scheduled}`); return 1; },
    dispatch: async () => { dispatched = pending.splice(0); return dispatched.length; },
    runForecastOnce: async (handle: (job: IngestionJob) => Promise<void>) => {
      await handle({ id: "local-refresh", kind: "forecast.refresh", payload: {} }); return true;
    },
  };
  let progress = 0;
  const running = pollForecasts(queue, async () => { refreshed.push(dispatched); }, {
    signal: controller.signal, wait: clock.wait, onProgress: () => { progress++; }, onError: () => assert.fail("no local error expected"),
  });
  try {
    await clock.asleep();
    assert.equal(sourceFinished, false);
    assert.deepEqual(refreshed, [["canonical.changed", "clock:1"]]);
    pending.push("roster.changed");
    clock.tick();
    await clock.asleep();
    assert.equal(sourceFinished, false);
    assert.deepEqual(refreshed[1], ["roster.changed", "clock:2"]);
    assert.equal(progress, 2);
  } finally {
    controller.abort();
    sourceRequest.release();
    await Promise.all([running, source]);
  }
});

test("local polling reports a persistence failure, retries and stops promptly from an aborted wait", async () => {
  const controller = new AbortController();
  const clock = pollingClock();
  let attempts = 0;
  let failures = 0;
  let progress = 0;
  const running = pollForecasts({
    scheduleForecast: async () => { if (++attempts === 1) throw new Error("unavailable"); return 0; },
    dispatch: async () => 0,
    runForecastOnce: async () => false,
  }, async () => undefined, {
    signal: controller.signal, wait: clock.wait, onProgress: () => { progress++; }, onError: () => { failures++; },
  });
  try {
    await clock.asleep();
    assert.equal(failures, 1);
    assert.equal(progress, 0);
    clock.tick();
    await clock.asleep();
    assert.equal(progress, 1);
  } finally { controller.abort(); await running; }
  assert.equal(attempts, 2);
});

test("shutdown lets an already claimed forecast complete without starting another poll", async () => {
  const controller = new AbortController();
  const started = gate();
  const finish = gate();
  let completed = false;
  let attempts = 0;
  const running = pollForecasts({
    scheduleForecast: async () => { attempts++; return 0; },
    dispatch: async () => 0,
    runForecastOnce: async () => { started.release(); await finish.promise; completed = true; return true; },
  }, async () => undefined, {
    signal: controller.signal,
    onProgress: () => undefined,
    onError: () => assert.fail("shutdown is not a failure"),
    wait: async () => assert.fail("aborted polling must not wait again"),
  });
  await started.promise;
  controller.abort();
  await Promise.resolve();
  assert.equal(completed, false);
  finish.release();
  await running;
  assert.equal(completed, true);
  assert.equal(attempts, 1);
});

for (const pendingStep of ["schedule", "dispatch"] as const) test(`shutdown during ${pendingStep} does not claim another forecast`, async () => {
  const controller = new AbortController();
  const started = gate();
  const finish = gate();
  let claims = 0;
  let dispatches = 0;
  const pending = async () => { started.release(); await finish.promise; return 0; };
  const running = pollForecasts({
    scheduleForecast: async () => pendingStep === "schedule" ? pending() : 0,
    dispatch: async () => { dispatches++; return pendingStep === "dispatch" ? pending() : 0; },
    runForecastOnce: async () => { claims++; return true; },
  }, async () => assert.fail("shutdown must not execute a handler"), {
    signal: controller.signal,
    onProgress: () => assert.fail("setup interrupted by shutdown is not a completed poll"),
    onError: () => assert.fail("shutdown is not a persistence error"),
    wait: async () => assert.fail("shutdown must not start another wait"),
  });
  await started.promise;
  controller.abort();
  finish.release();
  await running;
  assert.equal(claims, 0);
  assert.equal(dispatches, pendingStep === "schedule" ? 0 : 1);
});
