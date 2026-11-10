import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "mongodb";
import type { Pool } from "pg";
import { EnrichmentPipeline } from "../src/server/ingestion/enrichment";
import { archiveId } from "../src/server/ingestion/archive";
import { HighlightlyClient, highlightlyResponse } from "../src/server/ingestion/highlightly-client";
import { clubName, normalizeHighlightly, primaryFingerprint, sameFixture, samePlayerName, type EnrichmentFixture } from "../src/server/ingestion/highlightly-normalize";

const fixture: EnrichmentFixture = {
  id: "fixture", nativeId: "native", revisionId: "revision", leagueId: "premier-league-gb-eng", kickoffAt: "2026-11-01T15:00:00.000Z",
  home: { id: "home", name: "Test United FC" }, away: { id: "away", name: "Other FC" }, homeScore: 1, awayScore: 0,
  appearances: [{ id: "appearance", primaryRevisionId: "primary", playerId: "player", name: "Alex Example", clubId: "home",
    participation: "played", minutes: 90, goals: 1, assists: 0, shotsOnTarget: 2 }],
};
function capture(change: Record<string, unknown> = {}, stats: Record<string, unknown> = {}) {
  const external = { id: 1, date: fixture.kickoffAt, league: { id: 33973, season: 2026 }, homeTeam: { id: 2, name: "Test United" },
    awayTeam: { id: 3, name: "Other" }, state: { description: "Finished", score: { current: "1 - 0" } } };
  const text = JSON.stringify([{ team: { id: 2 }, players: [{ id: 4, name: "A. Example", minutesPlayed: 90, matchRating: "7.20",
    statistics: { goalsScored: 1, assists: 0, shotsOnTarget: 2, passesKey: 0, tacklesTotal: 3, interceptionsTotal: 0, ...stats }, ...change }] },
  { team: { id: 3 }, players: [] }]);
  const response = highlightlyResponse("get_statistics", fixture.leagueId, { format: "highlightly-box-v1", fixture: external,
    scheduleArchiveId: "a".repeat(64), primaryFingerprint: primaryFingerprint(fixture), capture: { path: "/box-score/1", retrievedAt: "2026-11-10T12:00:00.000Z", text } });
  return { ...response, id: archiveId(response) };
}

test("supplement mapping corroborates club, exact minutes and three observed counts", () => {
  const batch = normalizeHighlightly(capture(), fixture);
  assert.equal(batch.observations.length, 1);
  assert.deepEqual(batch.observations[0].metrics, { rating: 7.2, keyPasses: 0, tackles: 3, interceptions: 0 });
  assert.equal(normalizeHighlightly(capture({ minutesPlayed: 89 }), fixture).observations.length, 0);
  assert.equal(normalizeHighlightly(capture({}, { goalsScored: 0 }), fixture).observations.length, 0);
  assert.equal(normalizeHighlightly(capture({ name: "Adam Example" }), fixture).observations.length, 0);
});
test("missing, malformed and boolean counts never become measured zero", () => {
  const row = normalizeHighlightly(capture({ matchRating: "" }, { passesKey: false, tacklesTotal: -1, interceptionsTotal: 1.5 }), fixture).observations[0];
  assert.deepEqual(row.metrics, { rating: null, keyPasses: null, tackles: null, interceptions: null });
  assert.equal(normalizeHighlightly(capture({ statistics: [] }), fixture).observations.length, 0);
  assert.equal(normalizeHighlightly(capture({ matchRating: "NaN" }), fixture).observations[0].metrics.rating, null);
  assert.equal(normalizeHighlightly(capture({ matchRating: "99.99" }), fixture).observations[0].metrics.rating, null);
  assert.equal(normalizeHighlightly(capture({ matchRating: 7.235 }), fixture).observations[0].metrics.rating, null);
});
test("source correction, ambiguous names and duplicate external identities fail closed", () => {
  assert.throws(() => normalizeHighlightly(capture(), { ...fixture, revisionId: "corrected" }), /evidence/);
  const ambiguous = { ...fixture, appearances: [...fixture.appearances, { ...fixture.appearances[0], id: "second" }] };
  const raw = capture();
  const bundle = JSON.parse(raw.text); bundle.primaryFingerprint = primaryFingerprint(ambiguous); raw.text = JSON.stringify(bundle);
  assert.equal(normalizeHighlightly(raw, ambiguous).observations.length, 0);
  const duplicate = capture(); const value = JSON.parse(duplicate.text); const boxes = JSON.parse(value.capture.text);
  boxes[1].players.push(boxes[0].players[0]); value.capture.text = JSON.stringify(boxes); duplicate.text = JSON.stringify(value);
  assert.throws(() => normalizeHighlightly(duplicate, fixture), /player identity/);
});
test("name normalization permits accent/initial equivalence but rejects different full first names", () => {
  assert(samePlayerName("Álex Example", "A. Example"));
  assert(!samePlayerName("Alex Example", "Adam Example"));
  assert(!samePlayerName("Alex Example", "Example"));
  assert(!samePlayerName("---", "..."));
  assert(!samePlayerName("李明", "王强"));
  assert.equal(clubName("Atlético de Madrid"), clubName("Atletico Madrid"));
  assert.notEqual(clubName("Manchester United"), clubName("Manchester City"));
});
test("HTML apostrophes preserve strict identity and observed-count corroboration", () => {
  for (const entity of ["&apos;", "&#39;", "&#039;", "&#x27;", "&#X0027;"]) {
    assert(samePlayerName("Luke O'Nien", `L. O${entity}Nien`));
    assert(samePlayerName(`Dara O${entity}Shea`, "D. O’Shea"));
    assert(!samePlayerName("Luke O'Nien", `Louis O${entity}Nien`));
    assert(!samePlayerName("Luke O'Nien", `A. O${entity}Nien`));
  }
  assert(!samePlayerName("Luke O'Nien", "L. O&aposNien"));
  assert(!samePlayerName("Luke O'Nien", "L. O&APOS;Nien"));
  assert(!samePlayerName("Luke O'Nien", "L. O&unknown;Nien"));
  const primary = { ...fixture, appearances: [{ ...fixture.appearances[0], name: "Luke O'Nien" }] };
  const raw = capture({ name: "L. O&apos;Nien" });
  assert.equal(normalizeHighlightly(raw, primary).observations.length, 1);
  assert.equal(normalizeHighlightly(capture({ name: "L. O&apos;Nien", minutesPlayed: 89 }), primary).observations.length, 0);
  assert.equal(normalizeHighlightly(capture({ name: "L. O&apos;Nien" }, { assists: 1 }), primary).observations.length, 0);
});
test("verified club aliases retain exact fixture time, score, league and opponent checks", () => {
  const pairs = [["Ipswich Town FC", "Ipswich"], ["Coventry City FC", "Coventry"],
    ["RC Celta", "Celta de Vigo"], ["RCD Espanyol de Barcelona", "Espanyol"],
    ["Real Club Deportivo de La Coruña", "Deportivo La Coruña"],
    ["Real Racing Club de Santander", "Racing Santander"], ["D. Alavés", "Alavés"]];
  for (const [primary, external] of pairs) {
    assert.equal(clubName(primary), clubName(external));
    const canonical = { ...fixture, home: { ...fixture.home, name: primary } };
    const row = { id: 1, date: fixture.kickoffAt, league: { id: 33973, season: 2026 },
      homeTeam: { name: external }, awayTeam: { name: "Other" }, state: { description: "Finished", score: { current: "1 - 0" } } };
    assert(sameFixture(row, canonical));
    assert(!sameFixture({ ...row, date: "2026-11-01T16:00:00.000Z" }, canonical));
    assert(!sameFixture({ ...row, league: { id: 33973, season: 2025 } }, canonical));
    assert(!sameFixture({ ...row, awayTeam: { name: "Another" } }, canonical));
    assert(!sameFixture({ ...row, state: { description: "Finished", score: { current: "0 - 1" } } }, canonical));
  }
  assert.notEqual(clubName("Coventry City FC"), clubName("Manchester City FC"));
  assert.notEqual(clubName("RC Celta"), clubName("Celtic FC"));
});
test("HTTP client reserves every attempt, forbids redirects and keeps keys out of failures", async () => {
  let attempts = 0, observed = -1;
  const client = new HighlightlyClient({ async reserveRequest() { attempts++; }, async observeQuota(n) { observed = n; } }, "private-test-credential", async (url, options) => {
    assert.equal(String(url), "https://soccer.highlightly.net/box-score/1");
    assert.equal(options?.redirect, "error"); assert.equal(options?.credentials, "omit");
    return new Response("[]", { headers: { "x-ratelimit-requests-remaining": "88" } });
  });
  await client.get("get_statistics", "/box-score/1"); assert.equal(attempts, 1); assert.equal(observed, 88);
  await assert.rejects(client.get("get_statistics", "https://external.invalid"), (error: unknown) => error instanceof Error && "code" in error && error.code === "request_invalid");
  assert.equal(attempts, 1);
  const echo = new HighlightlyClient({ async reserveRequest() {}, async observeQuota() {} }, "private-test-credential", async () => new Response(JSON.stringify({ value: "private-test-credential" })));
  await assert.rejects(echo.get("get_statistics", "/box-score/1"), (error: unknown) => error instanceof Error && !error.message.includes("private-test-credential"));
});
test("a failed advisory-lock query releases its pooled connection", async () => {
  let released = 0;
  const pool = { async connect() { return { async query() { throw new Error("Synthetic database outage"); }, release() { released++; } }; } };
  const db = { collection() { return {}; } };
  const pipeline = new EnrichmentPipeline(pool as unknown as Pool, db as unknown as Db, "private-test-credential");
  await assert.rejects(pipeline.run(), /Synthetic database outage/);
  assert.equal(released, 1);
});
