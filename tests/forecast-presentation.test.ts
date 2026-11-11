import assert from "node:assert/strict";
import test from "node:test";
import { comparisonNotices, forecastNotices, hasForecastOutputs, hasOutput, hasRecordedValue, selectedEvidence, tierLabel } from "../src/lib/forecast-presentation";
import type { ForecastInput, ForecastResult, Output } from "../src/server/forecast/types";

test("selected display evidence follows model selection and joins its own input rather than recent observation order", () => {
  const input = { appearances: [{ fixtureId: "older", metrics: { goals: 0 } }, { fixtureId: "newer", metrics: { goals: null } }] } as ForecastInput;
  const result = { selected: [{ fixtureId: "newer" }, { fixtureId: "older" }] } as ForecastResult;
  const evidence = selectedEvidence(input, result);
  assert.deepEqual(evidence.map(({ selected, appearance }) => [selected.fixtureId, appearance?.metrics.goals]), [["newer", null], ["older", 0]]);
});

test("freshness notices catch expired targets even when source ordinals match without asserting freshness", () => {
  const source = { cutoffAt: "2026-11-09T12:00:00Z", sourceOrdinal: "12" };
  const forecast = { evaluation: { cutoffAt: "2026-11-09T11:30:00Z", sourceOrdinal: "12" }, result: { target: { kickoffAt: "2026-11-09T11:45:00Z" } } } as Parameters<typeof forecastNotices>[0];
  const notices = forecastNotices(forecast, source);
  assert.equal(notices.length, 2);
  assert(notices.some((message) => message.includes("kickoff has passed")));
  assert(notices.some((message) => message.includes("over 15 minutes old")));
  assert.equal(forecastNotices({ ...forecast, evaluation: { cutoffAt: source.cutoffAt, sourceOrdinal: "12" }, result: { target: null } }, source).length, 0);
  assert.equal(forecastNotices({ ...forecast, evaluation: { cutoffAt: source.cutoffAt, sourceOrdinal: "11" }, result: { target: null } }, source).length, 1);
});

test("tier presentation preserves unresolved ties crossing tier boundaries", () => {
  assert.equal(tierLabel({ rank: 8, tiedCount: 2, uncertain: true }, 24), "Uncertain tier · neutral weight");
  assert.equal(tierLabel({ rank: 1, tiedCount: 2, uncertain: true }, 24), "Upper tier");
  assert.equal(tierLabel({ rank: 14, tiedCount: 1, uncertain: false }, 18), "Lower tier");
  assert.equal(tierLabel(null, 24), "Unknown tier");
});

test("comparison notices distinguish an aged shared snapshot and passed target from current availability", () => {
  const comparison = { cutoffAt: "2026-11-09T12:00:00Z", players: [{ result: { target: { kickoffAt: "2026-11-09T12:10:00Z" } } }, { result: { target: null } }] } as Parameters<typeof comparisonNotices>[0];
  assert.deepEqual(comparisonNotices(comparison), []);
  const passed = comparisonNotices(comparison, "2026-11-09T12:10:00Z");
  assert.equal(passed.length, 1);
  assert(passed[0].includes("kickoff"));
  const aged = comparisonNotices(comparison, "2026-11-09T12:16:00Z");
  assert.equal(aged.length, 2);
  assert(aged[1].includes("snapshot is over 15 minutes old"));
  assert.equal(comparisonNotices({ ...comparison, players: [{ result: { target: null } }] }, "2026-11-09T12:16:00Z").length, 1);
});


test("result visibility preserves numeric zero and only counts recorded output values", () => {
  for (const value of [0, 7.1, -1]) assert.equal(hasRecordedValue(value), true);
  for (const value of [null, undefined, NaN, Infinity]) assert.equal(hasRecordedValue(value), false);
  const missing: Output = { status: "unavailable", value: null, reasons: [] };
  const zero: Output = { status: "available", value: 0, reasons: [] };
  assert.equal(hasOutput(zero), true);
  assert.equal(hasOutput(missing), false);
  assert.equal(hasOutput(undefined), false);
  const result = { forecastRating: missing, adjustedFormIndex: missing, projected90: { goals: missing } } as unknown as ForecastResult;
  assert.equal(hasForecastOutputs(result), false);
  assert.equal(hasForecastOutputs({ ...result, projected90: { goals: zero } }), true);
});
