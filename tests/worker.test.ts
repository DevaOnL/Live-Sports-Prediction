import assert from "node:assert/strict";
import { test } from "node:test";
import type { IngestionJob } from "../src/server/ingestion/jobs";
import { pollForecasts } from "../src/worker/forecast-polling";

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
