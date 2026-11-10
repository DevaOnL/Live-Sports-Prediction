import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, chmod, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { readCaptureFile, writeCaptureFile, writeConfirmedCaptureFile } from "../scripts/measure";
import { PROSPECTIVE_PROTOCOL, scoreCapture, sealCapture, validateCapture, type ObservedTarget, type ProspectiveCapture,
  type ProspectiveFixture, type ProspectiveOutcomes, type ProspectivePlayer } from "../src/server/evaluation/prospective";
import { canonicalJson, evaluateForecast, inputHash } from "../src/server/forecast/engine";
import { METRICS, type ForecastInput, type HistoryAppearance, type Metric, type Position } from "../src/server/forecast/types";
import { cutoffUtc, localDate } from "../src/server/ingestion/standings";

const capturedAt = "2026-11-10T12:00:00.000Z", completedAt = "2026-11-10T12:00:01.000Z";
const source = { sourceOrdinal: "42", latestRetrievedAt: "2026-11-10T11:00:00.000Z" };
const fixture: ProspectiveFixture = { fixtureId: "900006", leagueId: "153", season: "2026/27", competition: "championship",
  kickoffAt: "2026-11-12T14:00:00.000Z", homeClubId: "3072", awayClubId: "5006", issueCutoffAt: "2026-11-12T00:00:00.000Z",
  earliestForClubIds: ["3072", "5006"] };

function history(index: number): HistoryAppearance {
  const kickoffAt = `2026-11-0${index}T14:00:00.000Z`;
  return { fixtureId: String(900000 + index), leagueId: "153", season: "2026/27", competition: "championship",
    kickoffAt, status: "final", homeClubId: "3072", awayClubId: String(5000 + index), clubId: "3072", covered: true,
    membershipKnown: true, participation: "played", minutes: 90, rating: 7,
    metrics: Object.fromEntries(METRICS.map((metric) => [metric, 1])) as Record<Metric, number>,
    context: { complete: true, clubs: 24, own: { rank: 10, tiedCount: 1, uncertain: false },
      opponent: { rank: 11, tiedCount: 1, uncertain: false }, key: `table:${index}`,
      cutoffAt: cutoffUtc(localDate(kickoffAt, "Europe/London"), "Europe/London"), reasons: [] } };
}

function player(playerId = "8001", position: Position = "FWD", available = true): ProspectivePlayer {
  const input: ForecastInput = { player: { id: playerId, position }, cutoffAt: capturedAt,
    appearances: [1, 2, 3, 4, 5].map(history), gaps: [], currentClub: available ? { clubId: "3072", leagueId: "153", season: "2026/27" } : null,
    rosterReasons: available ? [] : [{ code: "missing_roster_observation" }], targets: [{ ...fixture, status: "scheduled",
      context: { ...history(1).context!, cutoffAt: capturedAt } }] };
  const result = evaluateForecast(input);
  const outputs = position === "FWD" ? ["goals", "assists", "shotsOnTarget"] : position === "MID" ? ["assists", "keyPasses", "tackles"]
    : position === "DEF" ? ["tackles", "interceptions"] : position === "GK" ? ["saves", "goalsConceded"] : [];
  return { playerId, input, result, inputHash: inputHash(input, result), provenance: { sourceOrdinal: "42" },
    baselines: { rating: { ratingMean: 7 }, ...Object.fromEntries(outputs.map((metric) => [metric,
      { arithmeticIndividualPer90: 1, pooledPer90: 1, ...(metric === "goals" ? { goalZero: 0 } : {}) }])) } };
}

function capture(players = [player()]): ProspectiveCapture {
  return sealCapture({ schemaVersion: 1, protocol: PROSPECTIVE_PROTOCOL, capturedAt, completedAt, source,
    fixtures: [structuredClone(fixture)], missedIssueCutoffs: [], players, undatedFixturesOutsideUniverse: 0 });
}

function target(playerId = "8001", changes: Partial<HistoryAppearance> = {}): ObservedTarget {
  return { playerId, position: "FWD", target: { ...history(1), ...fixture, status: "final", rating: 8, minutes: 97,
    metrics: { ...history(1).metrics, goals: 2 }, context: null, ...changes } };
}

function outcomes(appearances = [target()]): ProspectiveOutcomes {
  return { scoredAt: "2026-11-13T12:00:00.000Z", source: { sourceOrdinal: "100", latestRetrievedAt: "2026-11-13T11:00:00.000Z" },
    fixtures: [{ ...fixture, status: "final", statisticsStatus: "complete" }], appearances };
}

function cohort(report: ReturnType<typeof scoreCapture>, output: string) {
  const row = report.cohorts.find((row) => row.leagueId === "all" && row.position === "all" && row.output === output);
  assert(row); return row;
}

function readerClock(at: string, onClock?: () => Promise<void>, queries: string[] = []): Pool {
  return { connect: async () => ({ release() {}, query: async (sql: string) => {
    queries.push(sql);
    if (sql.startsWith("SELECT current_user")) return { rows: [{ name: "lsp_reader", read_only: "on" }] };
    if (sql === "SELECT clock_timestamp() AS at") { await onClock?.(); return { rows: [{ at: new Date(at) }] }; }
    return { rows: [] };
  } }) } as unknown as Pool;
}

test("a future capture stays pending, then scores frozen estimates and paired baselines when real outcomes are observed", () => {
  const frozen = capture(), original = structuredClone(frozen);
  const pending = outcomes([]);
  pending.scoredAt = "2026-11-11T12:00:00.000Z";
  pending.fixtures[0].status = "scheduled";
  let report = scoreCapture(frozen, pending);
  assert.equal(report.fixtureCoverage.pending, 1);
  assert.equal(report.measurementStatus, "pending_outcomes");
  assert.equal(report.eligibleTargets, 0);
  assert.equal(report.scoredTargetCases, 0);
  assert.equal(report.cohorts.length, 0);
  report = scoreCapture(frozen, outcomes());
  assert.equal(report.scoredTargetCases, 1);
  assert.equal(report.measurementStatus, "measured");
  assert.equal(cohort(report, "rating").errors.heuristic.mae, 1);
  const goals = cohort(report, "goals"), actual = 180 / 97;
  assert.equal(goals.unit, "events per 90 minutes");
  assert(Math.abs(goals.errors.heuristic.mae! - Math.abs(1 - actual)) < 1e-12);
  assert.equal(goals.errors.baselines.goalZero!.mae, actual);
  for (const baseline of Object.values(goals.errors.baselines)) assert.equal(baseline.count, goals.scored);
  const corrected = outcomes(); corrected.appearances[0].target.rating = 10;
  assert.equal(cohort(scoreCapture(frozen, corrected), "rating").errors.heuristic.mae, 3);
  assert.deepEqual(frozen, original, "later outcomes never rewrite or re-evaluate saved inputs, predictions or baselines");
  const text = JSON.stringify(report);
  assert(!text.includes("8001") && !text.includes("900006") && !text.includes("inputHash") && !text.includes("provenance"));
});

test("uncaptured players and unavailable captures remain in the denominator on exactly paired output cases", () => {
  const frozen = capture([player(), player("8002", "FWD", false)]);
  const report = scoreCapture(frozen, outcomes([target(), target("8002"), target("8003")]));
  const goals = cohort(report, "goals");
  assert.equal(report.eligibleTargets, 3);
  assert.equal(goals.eligibleTargets, 3);
  assert.equal(goals.scored, 1);
  assert.equal(goals.coverage, 1 / 3);
  assert(goals.exclusions.some((row) => row.code === "prediction_not_captured" && row.count === 1));
  assert(goals.exclusions.some((row) => row.code === "missing_roster_observation" && row.count === 1));
  for (const baseline of Object.values(goals.errors.baselines)) assert.equal(baseline.count, 1);
});

test("all positions use their frozen outputs and missing target values never become zero", () => {
  const positions: Position[] = ["GK", "DEF", "MID", "FWD", "UNKNOWN"];
  const frozen = capture(positions.map((position, index) => player(String(8001 + index), position)));
  const actual = positions.map((position, index) => ({ ...target(String(8001 + index)), position }));
  actual[3].target.rating = 0;
  const report = scoreCapture(frozen, outcomes(actual));
  assert.equal(report.eligibleTargets, 5);
  assert.equal(cohort(report, "rating").scored, 5);
  assert.equal(cohort(report, "goals").eligibleTargets, 1);
  assert.equal(cohort(report, "assists").eligibleTargets, 2);
  assert.equal(cohort(report, "tackles").eligibleTargets, 2);
  assert.equal(cohort(report, "saves").eligibleTargets, 1);
  assert(!report.cohorts.some((row) => row.position === "UNKNOWN" && row.output !== "rating"));
});

test("captured arithmetic and pooled per-90 baselines retain distinct reported-minute calculations", () => {
  const saved = player(), minutes = [60, 75, 90, 97, 120], goals = [1, 2, 0, 1, 0];
  saved.input.appearances.forEach((row, index) => { row.minutes = minutes[index]; row.metrics.goals = goals[index]; });
  saved.result = evaluateForecast(saved.input); saved.inputHash = inputHash(saved.input, saved.result);
  const arithmetic = goals.reduce((sum, value, index) => sum + 90 * value / minutes[index], 0) / 5;
  const pooled = 90 * 4 / 442;
  saved.baselines.goals = { arithmeticIndividualPer90: arithmetic, pooledPer90: pooled, goalZero: 0 };
  for (const metric of ["assists", "shotsOnTarget"] as const) saved.baselines[metric] = {
    arithmeticIndividualPer90: minutes.reduce((sum, value) => sum + 90 / value, 0) / 5, pooledPer90: 90 * 5 / 442 };
  const actual = 180 / 97, scored = cohort(scoreCapture(capture([saved]), outcomes()), "goals");
  assert.notEqual(arithmetic, pooled);
  assert(Math.abs(scored.errors.heuristic.mae! - Math.abs(pooled - actual)) < 1e-12);
  assert(Math.abs(scored.errors.baselines.arithmeticIndividualPer90!.mae! - Math.abs(arithmetic - actual)) < 1e-12);
  assert(Math.abs(scored.errors.baselines.pooledPer90!.mae! - Math.abs(pooled - actual)) < 1e-12);
});

test("missing metrics remain output-specific and short, DNP and unknown targets cannot enter scoring", () => {
  const actual = target(); actual.target.metrics.goals = null;
  let report = scoreCapture(capture(), outcomes([actual]));
  assert.equal(cohort(report, "goals").eligibleTargets, 1);
  assert.equal(cohort(report, "goals").targetValueAvailable, 0);
  assert.equal(cohort(report, "goals").errors.heuristic.mae, null);
  assert.equal(cohort(report, "rating").scored, 1);
  report = scoreCapture(capture(), outcomes([target("8001", { minutes: 59 }), target("8002", { participation: "dnp", minutes: 0 }),
    target("8003", { minutes: null }), target("8004", { membershipKnown: false })]));
  assert.equal(report.eligibleTargets, 0);
  assert.equal(cohort(report, "rating").coverage, null);
  assert(cohort(report, "rating").targetExclusions.some((row) => row.code === "target_minutes_missing"));
});

test("changed fixture metadata and an intervening newly scheduled match cannot repair a frozen target", () => {
  const changed = outcomes(); changed.fixtures[0].kickoffAt = "2026-11-12T15:00:00.000Z";
  let report = scoreCapture(capture(), changed);
  assert.equal(report.fixtureCoverage.metadataChanged, 1);
  assert.equal(cohort(report, "rating").scored, 0);
  assert(cohort(report, "rating").exclusions.some((row) => row.code === "target_metadata_changed"));
  const reordered = outcomes();
  reordered.fixtures.push({ ...reordered.fixtures[0], fixtureId: "900007", awayClubId: "5007", kickoffAt: "2026-11-11T14:00:00.000Z" });
  report = scoreCapture(capture(), reordered);
  assert.equal(report.fixtureCoverage.orderChanged, 1);
  assert.equal(cohort(report, "rating").scored, 0);
  assert(cohort(report, "rating").exclusions.some((row) => row.code === "target_order_changed"));
  const transferred = outcomes(); transferred.appearances[0].target.clubId = "5006";
  assert(cohort(scoreCapture(capture(), transferred), "rating").exclusions.some((row) => row.code === "target_club_mismatch"));
});

test("future finals, missing and undated fixtures and whole-match gaps are explicit", () => {
  const future = outcomes(); future.scoredAt = "2026-11-11T12:00:00.000Z";
  let report = scoreCapture(capture(), future);
  assert.equal(report.scoredTargetCases, 0);
  assert(cohort(report, "rating").exclusions.some((row) => row.code === "target_future_final"));
  const missing = outcomes([]); missing.fixtures = [];
  report = scoreCapture(capture(), missing);
  assert.equal(report.fixtureCoverage.missing, 1);
  const undated = outcomes([]); undated.fixtures[0].kickoffAt = null;
  report = scoreCapture(capture(), undated);
  assert.equal(report.fixtureCoverage.undated, 1);
  assert.equal(report.fixtureCoverage.finalsWithoutAppearances, 1);
  assert.throws(() => scoreCapture(capture(), { ...outcomes(), scoredAt: capturedAt }), /precedes capture/);
});

test("final fixture coverage distinguishes complete, partial, missing and unknown statistics", () => {
  const { digest, ...body } = capture([]);
  assert.match(digest, /^[a-f0-9]{64}$/);
  body.fixtures = ["complete", "partial", "missing", "unknown"].map((_, index) => ({ ...fixture,
    fixtureId: String(900006 + index), homeClubId: String(6000 + 2 * index), awayClubId: String(6001 + 2 * index),
    earliestForClubIds: [String(6000 + 2 * index), String(6001 + 2 * index)] }));
  const observed = outcomes([]);
  observed.fixtures = body.fixtures.map((row, index) => ({ ...row, status: "final", statisticsStatus: ["complete", "partial", "missing", "unknown"][index] }));
  const report = scoreCapture(sealCapture(body), observed);
  assert.equal(report.fixtureCoverage.final, 4);
  assert.equal(report.fixtureCoverage.finalsWithCompleteStatistics, 1);
  assert.equal(report.fixtureCoverage.finalsWithPartialStatistics, 1);
  assert.equal(report.fixtureCoverage.finalsWithMissingStatistics, 1);
  assert.equal(report.fixtureCoverage.finalsWithUnknownStatistics, 1);
  assert.equal(report.fixtureCoverage.finalsWithoutAppearances, 4);
});

test("capture validation enforces true local midnight including Paris and DST, schema and checksums", () => {
  const valid = capture();
  assert.deepEqual(validateCapture(JSON.parse(canonicalJson(valid))), valid);
  const changed = structuredClone(valid); changed.players[0].result.forecastRating.value = 9;
  assert.throws(() => validateCapture(changed), /Invalid or changed/);
  const { digest, ...body } = valid;
  assert.match(digest, /^[a-f0-9]{64}$/);
  const malformed = structuredClone(body); malformed.players[0].result.forecastRating.value = 999;
  assert.throws(() => validateCapture(sealCapture(malformed)), /Invalid or changed/);
  assert.throws(() => validateCapture(sealCapture({ ...body, completedAt: fixture.issueCutoffAt })), /Invalid or changed/);
  const paris = structuredClone(body); paris.fixtures[0].leagueId = "164"; paris.fixtures[0].competition = "ligue_2";
  paris.fixtures[0].issueCutoffAt = "2026-11-11T23:00:00.000Z";
  validateCapture(sealCapture(paris));
  paris.fixtures[0].issueCutoffAt = "2026-11-12T00:00:00.000Z";
  assert.throws(() => validateCapture(sealCapture(paris)), /Invalid or changed/);
  const daylight = structuredClone(body);
  daylight.capturedAt = "2026-10-24T12:00:00.000Z"; daylight.completedAt = "2026-10-24T12:00:01.000Z"; daylight.players = [];
  daylight.source.latestRetrievedAt = "2026-10-24T11:00:00.000Z";
  daylight.fixtures[0].kickoffAt = "2026-10-25T14:00:00.000Z"; daylight.fixtures[0].issueCutoffAt = "2026-10-24T23:00:00.000Z";
  validateCapture(sealCapture(daylight));
  assert.throws(() => validateCapture({ ...valid, extra: "not allowed" }), /Invalid or changed/);
});

test("missed issue deadlines and an empty universe report unavailable accuracy explicitly", () => {
  const { digest, ...body } = capture([]);
  assert.match(digest, /^[a-f0-9]{64}$/);
  body.fixtures = [];
  let report = scoreCapture(sealCapture(body), outcomes([]));
  assert.equal(report.measurementStatus, "no_eligible_future_targets");
  assert.deepEqual(report.measurementReasons, ["no_future_fixture"]);
  body.missedIssueCutoffs = [{ ...fixture, kickoffAt: "2026-11-10T14:00:00.000Z", issueCutoffAt: "2026-11-10T00:00:00.000Z" }];
  report = scoreCapture(sealCapture(body), outcomes([]));
  assert.equal(report.fixtureCoverage.missedIssueCutoffs, 1);
  assert.deepEqual(report.measurementReasons, ["issue_cutoff_missed"]);
});

test("capture files are private, exclusive, symlink-safe and reject changed or exposed contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sports-prospective-unit-"));
  try {
    const path = join(directory, "private.json"), frozen = capture();
    await writeConfirmedCaptureFile(path, frozen, readerClock("2026-11-10T12:00:02.000Z"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readCaptureFile(path), frozen);
    await assert.rejects(writeCaptureFile(path, frozen), { code: "EEXIST" });
    const link = join(directory, "link.json"); await symlink(path, link);
    await assert.rejects(readCaptureFile(link));
    await assert.rejects(writeCaptureFile(link, frozen), { code: "EEXIST" });
    await chmod(path, 0o644); await assert.rejects(readCaptureFile(path), /private regular/);
    await chmod(path, 0o600);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace('"forecastRating":{"reasons":[],"status":"available","value":7}', '"forecastRating":{"reasons":[],"status":"available","value":8}'));
    await assert.rejects(readCaptureFile(path), /Invalid or changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("private file persistence is confirmed by a fresh reader clock and late confirmation removes only its own file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sports-prospective-confirm-"));
  const queries: string[] = [];
  const clock = (at: string, onClock?: () => Promise<void>) => readerClock(at, onClock, queries);
  try {
    const frozen = capture(), path = join(directory, "confirmed.json"), confirmedAt = "2026-11-10T12:00:02.000Z";
    assert.equal(await writeConfirmedCaptureFile(path, frozen, clock(confirmedAt, async () => {
      assert.deepEqual(validateCapture(JSON.parse(await readFile(path, "utf8"))), frozen, "capture bytes exist before the final trusted clock query");
      await assert.rejects(readCaptureFile(path), /unconfirmed/, "a pre-confirmation crash cannot leave a scoreable file");
    })), confirmedAt);
    assert.deepEqual(await readCaptureFile(path), frozen);
    assert.equal(queries[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.equal(queries.at(-1), "COMMIT");
    const before = await readFile(path, "utf8"), calls = queries.length;
    await assert.rejects(writeConfirmedCaptureFile(path, frozen, clock(fixture.issueCutoffAt)), { code: "EEXIST" });
    assert.equal(queries.length, calls, "an existing capture is never re-confirmed or overwritten");
    assert.equal(await readFile(path, "utf8"), before);
    const late = join(directory, "late.json");
    await assert.rejects(writeConfirmedCaptureFile(late, frozen, clock(fixture.issueCutoffAt)), /durably confirmed/);
    await assert.rejects(readFile(late), { code: "ENOENT" });
    const backwards = join(directory, "backwards.json");
    await assert.rejects(writeConfirmedCaptureFile(backwards, frozen, clock(capturedAt)), /durably confirmed/);
    await assert.rejects(readFile(backwards), { code: "ENOENT" });
    const replaced = join(directory, "replaced.json"), original = join(directory, "original.json");
    await assert.rejects(writeConfirmedCaptureFile(replaced, frozen, clock(fixture.issueCutoffAt, async () => {
      await rename(replaced, original);
      await writeFile(replaced, "existing replacement", { mode: 0o600, flag: "wx" });
    })), /durably confirmed/);
    assert.equal(await readFile(replaced, "utf8"), "existing replacement", "cleanup cannot unlink a different inode");
    assert.deepEqual(validateCapture(JSON.parse(await readFile(original, "utf8"))), frozen);
    await assert.rejects(readCaptureFile(original), /unconfirmed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("pending crash files and invalid digest-bound confirmation receipts cannot reach CLI scoring", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sports-prospective-pending-"));
  try {
    const path = join(directory, "pending.json"), frozen = capture();
    await writeCaptureFile(path, frozen);
    assert.deepEqual(validateCapture(JSON.parse(await readFile(path, "utf8"))), frozen);
    await assert.rejects(readCaptureFile(path), /unconfirmed/);
    await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/measure.ts", "score", path], {
      cwd: process.cwd(), timeout: 10_000, env: { ...process.env, POSTGRES_HOST: "127.0.0.1", POSTGRES_PORT: "1",
        POSTGRES_READER_PASSWORD: "unit-synthetic-reader" },
    }), (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1); assert.equal(failure.stdout, ""); assert.match(failure.stderr, /Prospective measurement failed/);
      assert(!failure.stderr.includes(path) && !failure.stderr.includes("8001"));
      return true;
    });
    const receipt = { schemaVersion: 1, kind: "prospective-confirmation-v1", captureDigest: frozen.digest, durablyConfirmedAt: "2026-11-10T12:00:02.000Z" };
    await writeFile(path, `${canonicalJson(frozen)}\n${canonicalJson({ ...receipt, captureDigest: "0".repeat(64) })}\n`);
    await assert.rejects(readCaptureFile(path), /unconfirmed/);
    await writeFile(path, `${canonicalJson(frozen)}\n${canonicalJson({ ...receipt, durablyConfirmedAt: fixture.issueCutoffAt })}\n`);
    await assert.rejects(readCaptureFile(path), /unconfirmed/);
    await writeFile(path, `${canonicalJson(frozen)}\n${canonicalJson(receipt)}\n`);
    assert.deepEqual(await readCaptureFile(path), frozen);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
