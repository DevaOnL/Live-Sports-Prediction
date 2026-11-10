import assert from "node:assert/strict";
import { test } from "node:test";
import { COVERAGE } from "../src/server/ingestion/coverage";
import { CURRENT_SOURCE, LEGACY_SOURCE, runtimeSource, sourceCoverage, sourceEntityKey, sourceSeasonGuard } from "../src/server/ingestion/sources";

test("current coverage contains only the two configured top-flight leagues and preserves archived coverage separately", () => {
  assert.equal(CURRENT_SOURCE.provider, "sorare");
  assert.equal(CURRENT_SOURCE.coefficient, 2);
  assert.deepEqual(CURRENT_SOURCE.coverage.map((coverage) => [coverage.id, coverage.expectedClubs, coverage.timezone]), [
    ["premier-league-gb-eng", 20, "Europe/London"], ["laliga-es", 20, "Europe/Madrid"],
  ]);
  assert(CURRENT_SOURCE.coverage.every((coverage) => coverage.season === "2026/27" && coverage.startsOn === "2026-07-01" && coverage.endsOn === "2027-06-30"));
  assert.deepEqual(CURRENT_SOURCE.competitionCodes, { "premier-league-gb-eng": "premier_league", "laliga-es": "la_liga" });
  assert.equal(LEGACY_SOURCE.coverage, COVERAGE);
  assert.equal(LEGACY_SOURCE.coefficient, 1.5);
  assert.equal(sourceCoverage(CURRENT_SOURCE, "laliga-es").name, "La Liga");
  assert.throws(() => sourceCoverage(CURRENT_SOURCE, "153"), /Unsupported competition/);
  assert.throws(() => sourceCoverage(LEGACY_SOURCE, "laliga-es"), /Unsupported competition/);
  assert(Object.isFrozen(CURRENT_SOURCE) && Object.isFrozen(CURRENT_SOURCE.coverage) && Object.isFrozen(CURRENT_SOURCE.competitionCodes));
});

test("runtime legacy selection is confined to the explicit test selector and a valid test database name", () => {
  const previousSelector = process.env.LSP_TEST_SOURCE;
  const previousDatabase = process.env.POSTGRES_DB;
  try {
    for (const [selector, database, expected] of [
      [undefined, "sports", CURRENT_SOURCE],
      [undefined, "sports_test", CURRENT_SOURCE],
      ["legacy", "sports", CURRENT_SOURCE],
      ["legacy", "sports_test_extra", CURRENT_SOURCE],
      ["legacy", "../sports_test", CURRENT_SOURCE],
      ["legacy", "sports_test", LEGACY_SOURCE],
      ["current", "sports_test", CURRENT_SOURCE],
    ] as const) {
      if (selector === undefined) delete process.env.LSP_TEST_SOURCE; else process.env.LSP_TEST_SOURCE = selector;
      process.env.POSTGRES_DB = database;
      assert.equal(runtimeSource(), expected);
    }
  } finally {
    if (previousSelector === undefined) delete process.env.LSP_TEST_SOURCE; else process.env.LSP_TEST_SOURCE = previousSelector;
    if (previousDatabase === undefined) delete process.env.POSTGRES_DB; else process.env.POSTGRES_DB = previousDatabase;
  }
});

test("native-ID tuple keys avoid colon and entity collisions while old evidence keys remain byte-identical", () => {
  const parts = ["Player:11111111-1111-4111-8111-111111111111", "Game:22222222-2222-4222-8222-222222222222"];
  const key = sourceEntityKey(CURRENT_SOURCE, "appearance", ...parts);
  assert.equal(key, `sorare:appearance:${JSON.stringify(parts)}`);
  assert.notEqual(key, sourceEntityKey(CURRENT_SOURCE, "fixture", ...parts));
  assert.notEqual(sourceEntityKey(CURRENT_SOURCE, "appearance", "a:b", "c"), sourceEntityKey(CURRENT_SOURCE, "appearance", "a", "b:c"));
  assert.equal(sourceEntityKey(LEGACY_SOURCE, "appearance", "900001", "8001"), "900001:8001");
});

test("internal SQL aliases reject expressions and source guards safely quote literal metadata", () => {
  for (const alias of ["cs; DROP TABLE sports.players", "cs.id", '"cs"', "", "cs--"]) {
    assert.throws(() => sourceSeasonGuard(CURRENT_SOURCE, alias), /Invalid internal SQL alias/);
    assert.throws(() => sourceSeasonGuard(CURRENT_SOURCE, "cs", alias), /Invalid internal SQL alias/);
  }
  const guard = sourceSeasonGuard({ ...CURRENT_SOURCE, coverage: [{ ...CURRENT_SOURCE.coverage[0], id: "x'y" }] }, "season", "competition");
  assert(guard.includes("competition.provider_id='x''y'"));
  assert(guard.includes("season.expected_clubs=20"));
  assert(!guard.includes("WHERE"));
});
