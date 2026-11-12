import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "mongodb";
import type { Pool } from "pg";
import { EnrichmentPipeline } from "../src/server/ingestion/enrichment";
import { archiveId } from "../src/server/ingestion/archive";
import { HighlightlyClient, HighlightlyError, highlightlyResponse } from "../src/server/ingestion/highlightly-client";
import { ProviderError } from "../src/server/ingestion/provider";
import { clubName, normalizeHighlightly, primaryFingerprint, sameFixture, samePlayerName, type EnrichmentFixture } from "../src/server/ingestion/highlightly-normalize";

const fixture: EnrichmentFixture = {
  id: "fixture", nativeId: "native", revisionId: "revision", leagueId: "premier-league-gb-eng", kickoffAt: "2026-11-01T15:00:00.000Z",
  home: { id: "home", name: "Test United FC" }, away: { id: "away", name: "Other FC" }, homeScore: 1, awayScore: 0,
  appearances: [{ id: "appearance", primaryRevisionId: "primary", playerId: "player", name: "Alex Example", clubId: "home",
    participation: "played", minutes: 90, goals: 1, assists: 0, shotsOnTarget: 2 }],
};
function capture(change: Record<string, unknown> = {}, stats: Record<string, unknown> = {}, primary = fixture) {
  const external = { id: 1, date: fixture.kickoffAt, league: { id: 33973, season: 2026 }, homeTeam: { id: 2, name: "Test United" },
    awayTeam: { id: 3, name: "Other" }, state: { description: "Finished", score: { current: "1 - 0" } } };
  const text = JSON.stringify([{ team: { id: 2 }, players: [{ id: 4, name: "A. Example", minutesPlayed: 90, matchRating: "7.20",
    statistics: { goalsScored: 1, assists: 0, shotsOnTarget: 2, passesKey: 0, tacklesTotal: 3, interceptionsTotal: 0, ...stats }, ...change }] },
  { team: { id: 3 }, players: [] }]);
  const response = highlightlyResponse("get_statistics", fixture.leagueId, { format: "highlightly-box-v1", fixture: external,
    scheduleArchiveId: "a".repeat(64), primaryFingerprint: primaryFingerprint(primary), capture: { path: "/box-score/1", retrievedAt: "2026-11-10T12:00:00.000Z", text } });
  return { ...response, id: archiveId(response) };
}

test("supplement mapping corroborates club and three observed counts while retaining primary minutes", () => {
  const batch = normalizeHighlightly(capture(), fixture);
  assert.equal(batch.observations.length, 1);
  assert.deepEqual(batch.observations[0].metrics, { rating: 7.2, keyPasses: 0, tackles: 3, interceptions: 0 });
  assert.equal(batch.observations[0].evidence.minutesDiscrepancy, 0);
  assert.equal(normalizeHighlightly(capture({}, { goalsScored: 0 }), fixture).observations.length, 0);
  assert.equal(normalizeHighlightly(capture({ name: "Adam Example" }), fixture).observations.length, 0);
});
test("small and large minute discrepancies retain both reports and always choose Sorare, including the eligibility boundary", () => {
  for (const [primaryMinutes, externalMinutes] of [[84, 85], [90, 45], [60, 59], [59, 90], [94, 90]]) {
    const primary = { ...fixture, appearances: [{ ...fixture.appearances[0], minutes: primaryMinutes }] };
    const row = normalizeHighlightly(capture({ minutesPlayed: externalMinutes }, {}, primary), primary).observations[0];
    assert(row);
    assert.deepEqual({ minutes: row.evidence.minutes, primary: row.evidence.primaryMinutes, external: row.evidence.externalMinutes,
      source: row.evidence.minutesSource, discrepancy: row.evidence.minutesDiscrepancy },
    { minutes: primaryMinutes, primary: primaryMinutes, external: externalMinutes, source: "sorare", discrepancy: externalMinutes - primaryMinutes });
    assert.equal(primary.appearances[0].minutes, primaryMinutes);
    assert.equal(row.metrics.rating, 7.2);
  }
});
test("minute precedence never admits invalid minutes, unknown participation, missing counts or different identities", () => {
  for (const minutes of [null, 0, -1, 1.5, 2_147_483_648, Number.NaN]) {
    const primary = { ...fixture, appearances: [{ ...fixture.appearances[0], minutes }] };
    assert.equal(normalizeHighlightly(capture({ minutesPlayed: 85 }, {}, primary), primary).observations.length, 0);
    if (minutes === 0) assert.equal(normalizeHighlightly(capture({ minutesPlayed: minutes }), fixture).observations.length, 0);
    else assert.throws(() => normalizeHighlightly(capture({ minutesPlayed: minutes }), fixture), /player identity/);
  }
  for (const participation of ["unknown", "dnp"]) {
    const primary = { ...fixture, appearances: [{ ...fixture.appearances[0], participation }] };
    assert.equal(normalizeHighlightly(capture({ minutesPlayed: 85 }, {}, primary), primary).observations.length, 0);
  }
  for (const stats of [{ goalsScored: null }, { assists: false }, { shotsOnTarget: -1 }, { goalsScored: 0 }]) {
    assert.equal(normalizeHighlightly(capture({ minutesPlayed: 85 }, stats), fixture).observations.length, 0);
  }
  assert.equal(normalizeHighlightly(capture({ name: "Adam Example", minutesPlayed: 85 }), fixture).observations.length, 0);
  assert.equal(normalizeHighlightly(capture({ name: "Alex Exampl", minutesPlayed: 85 }), fixture).observations.length, 0);
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
  const aliases = capture({ minutesPlayed: 85 }); const mapped = JSON.parse(aliases.text); const rows = JSON.parse(mapped.capture.text);
  rows[0].players.push({ ...rows[0].players[0], id: 5, name: "Alex Example", minutesPlayed: 45 });
  mapped.capture.text = JSON.stringify(rows); aliases.text = JSON.stringify(mapped);
  assert.equal(normalizeHighlightly(aliases, fixture).observations.length, 0, "different external IDs cannot claim the same primary appearance");
  const differentMinutes = { ...fixture, appearances: [...fixture.appearances, { ...fixture.appearances[0], id: "second", minutes: 85 }] };
  assert.equal(normalizeHighlightly(capture({ minutesPlayed: 85 }, {}, differentMinutes), differentMinutes).observations.length, 0,
    "minutes cannot disambiguate two otherwise matching primary identities");
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
test("explicit nondecomposing letters preserve full names and initial abbreviations", () => {
  for (const [primary, external] of [["Martin Ødegaard", "Martin Odegaard"], ["Alexander Sørloth", "A. Sorloth"],
    ["Jørgen Larsen", "J. Strand Larsen"], ["Łukasz Fabiański", "L. Fabianski"], ["Đorđe Petrović", "D. Petrovic"],
    ["Guðmundur Example", "Gudmundur Example"], ["Alex Ħaddad", "A. Haddad"], ["Rıdvan Example", "Ridvan Example"],
    ["Pascal Groß", "Pascal Gross"], ["Pascal Groß", "P. Gross"]]) {
    assert(samePlayerName(primary, external), `${primary} should match ${external}`);
    assert(samePlayerName(external.toUpperCase(), primary.toUpperCase()), "case folding precedes letter equivalence");
  }
  assert(!samePlayerName("Đorđe Petrović", "Djordje Petrovic"), "the explicit đ mapping does not invent a dj spelling");
  assert(!samePlayerName("Jørgen Larsen", "Jonas Strand Larsen"), "different full first names remain distinct");
  assert(!samePlayerName("Jørgen Larsen", "Larsen"), "a surname alone does not establish identity");
});
test("transliterated supplemental names retain club, count, participation and canonical minute checks", () => {
  const primary = { ...fixture, appearances: [{ ...fixture.appearances[0], name: "Jørgen Larsen", minutes: 84 }] };
  const row = normalizeHighlightly(capture({ name: "J. Strand Larsen", minutesPlayed: 85 }, {}, primary), primary).observations[0];
  assert(row);
  assert.equal(row.appearanceId, primary.appearances[0].id);
  assert.deepEqual(row.metrics, { rating: 7.2, keyPasses: 0, tackles: 3, interceptions: 0 });
  assert.equal(row.evidence.primaryName, "Jørgen Larsen");
  assert.deepEqual(row.evidence.externalNames, ["J. Strand Larsen"]);
  assert.equal(row.evidence.primaryMinutes, 84);
  assert.equal(row.evidence.externalMinutes, 85);
  assert.equal(row.evidence.minutesDiscrepancy, 1);
  assert.equal(primary.appearances[0].minutes, 84);
  for (const change of [{ clubId: "away" }, { goals: 0 }, { assists: 1 }, { shotsOnTarget: null },
    { minutes: null }, { participation: "unknown" }]) {
    const contradicted = { ...primary, appearances: [{ ...primary.appearances[0], ...change }] };
    assert.equal(normalizeHighlightly(capture({ name: "J. Strand Larsen" }, {}, contradicted), contradicted).observations.length, 0);
  }
  for (const stats of [{ goalsScored: 0 }, { assists: 1 }, { shotsOnTarget: 1 }]) {
    assert.equal(normalizeHighlightly(capture({ name: "J. Strand Larsen" }, stats, primary), primary).observations.length, 0);
  }
});
test("letter equivalence cannot disambiguate competing primary or external identities", () => {
  const primary = { ...fixture, appearances: [{ ...fixture.appearances[0], name: "Jørgen Larsen" }] };
  const ambiguous = { ...primary, appearances: [...primary.appearances,
    { ...primary.appearances[0], id: "second", playerId: "second-player", primaryRevisionId: "second-primary", name: "Jorgen Larsen" }] };
  assert.equal(normalizeHighlightly(capture({ name: "J. Strand Larsen" }, {}, ambiguous), ambiguous).observations.length, 0);
  const duplicate = capture({ name: "J. Strand Larsen" }, {}, primary);
  const bundle = JSON.parse(duplicate.text), boxes = JSON.parse(bundle.capture.text);
  boxes[0].players.push({ ...boxes[0].players[0], id: 5, name: "Jorgen Larsen" });
  bundle.capture.text = JSON.stringify(boxes); duplicate.text = JSON.stringify(bundle);
  assert.equal(normalizeHighlightly(duplicate, primary).observations.length, 0);
});
test("unsupported scripts cannot disappear into a partial transliterated identity", () => {
  for (const [primary, external] of [["Ødegaard李", "Odegaard"], ["Jørgen 李 Larsen", "J. Strand Larsen"],
    ["Jørgen Larsen", "J. Strand Larsen 李"], ["Jørgen Larsen", "Ј. Strand Larsen"], ["李明", "王强"]]) {
    assert(!samePlayerName(primary, external), `${primary} must not match ${external}`);
  }
  const primary = { ...fixture, appearances: [{ ...fixture.appearances[0], name: "Jørgen 李 Larsen" }] };
  assert.equal(normalizeHighlightly(capture({ name: "J. Strand Larsen" }, {}, primary), primary).observations.length, 0);
});
test("captured native-player aliases resolve a display name with their original archive provenance", () => {
  const alias = { name: "Rodrigo Hernández Cascante", archiveId: "b".repeat(64), contentSha256: "c".repeat(64),
    retrievedAt: "2026-11-12T12:00:00.000Z" };
  const primary = { ...fixture, appearances: [{ ...fixture.appearances[0], name: "Rodrigo", nameAliases: [alias], minutes: 84 }] };
  assert(!samePlayerName(primary.appearances[0].name, alias.name));
  const row = normalizeHighlightly(capture({ name: "Rodri", fullName: alias.name, minutesPlayed: 85 }, {}, primary), primary).observations[0];
  assert(row);
  assert.equal(row.evidence.method, "unique_alias_club_goals_assists_shots_primary_minutes");
  assert.deepEqual(row.evidence.primaryAlias, alias);
  assert.equal(row.evidence.primaryName, "Rodrigo");
  assert.deepEqual(row.evidence.externalNames, ["Rodri", alias.name]);
  assert.equal(row.evidence.primaryMinutes, 84);
  assert.equal(row.evidence.externalMinutes, 85);
  assert.equal(primary.appearances[0].minutes, 84);
  assert.equal(primaryFingerprint(primary), primaryFingerprint(fixture), "name metadata does not relabel an original capture's primary fingerprint");
  assert.equal(normalizeHighlightly(capture({ name: "R. Hernández Cascante" }, {}, primary), primary).observations.length, 1);
  const direct = { ...fixture, appearances: [{ ...fixture.appearances[0], nameAliases: [alias] }] };
  assert.deepEqual(normalizeHighlightly(capture({}, {}, direct), direct).observations[0].evidence,
    normalizeHighlightly(capture(), fixture).observations[0].evidence, "direct name matches retain their original evidence shape");
});
test("aliases require actual capture provenance and cannot guess, truncate or rearrange names", () => {
  const alias = { name: "Rodrigo Hernández Cascante", archiveId: "b".repeat(64), contentSha256: "c".repeat(64),
    retrievedAt: "2026-11-12T12:00:00.000Z" };
  const primary = { ...fixture, appearances: [{ ...fixture.appearances[0], name: "Rodrigo", nameAliases: [alias] }] };
  for (const name of ["Rodri", "Rodrigo Hernández", "Rodrigo Cascante Hernández", "Hernández Cascante", `${alias.name} 李`]) {
    assert.equal(normalizeHighlightly(capture({ name }, {}, primary), primary).observations.length, 0);
  }
  for (const invalid of [{ ...alias, name: "" }, { ...alias, name: "Rodrigo\nHernández Cascante" },
    { ...alias, name: "x".repeat(201) }, { ...alias, archiveId: "not-an-archive" }, { ...alias, contentSha256: "" },
    { ...alias, retrievedAt: "not-a-time" }, ...Object.keys(alias).map((field) => ({ ...alias, [field]: undefined }))]) {
    const unproven = { ...primary, appearances: [{ ...primary.appearances[0], nameAliases: [invalid] }] };
    assert.equal(normalizeHighlightly(capture({ name: "Rodri", fullName: alias.name }, {}, unproven), unproven).observations.length, 0);
  }
  const absent = { ...primary, appearances: [{ ...primary.appearances[0], nameAliases: [] }] };
  assert.equal(normalizeHighlightly(capture({ name: "Rodri", fullName: alias.name }, {}, absent), absent).observations.length, 0);
});
test("captured alias matching keeps club, counts, participation and minutes mandatory", () => {
  const alias = { name: "Rodrigo Hernández Cascante", archiveId: "b".repeat(64), contentSha256: "c".repeat(64),
    retrievedAt: "2026-11-12T12:00:00.000Z" };
  const primary = { ...fixture, appearances: [{ ...fixture.appearances[0], name: "Rodrigo", nameAliases: [alias] }] };
  for (const change of [{ clubId: "away" }, { goals: 0 }, { assists: 1 }, { shotsOnTarget: null },
    { participation: "unknown" }, { minutes: 0 }, { minutes: null }]) {
    const contradicted = { ...primary, appearances: [{ ...primary.appearances[0], ...change }] };
    assert.equal(normalizeHighlightly(capture({ name: "Rodri", fullName: alias.name }, {}, contradicted), contradicted).observations.length, 0);
  }
  for (const stats of [{ goalsScored: 0 }, { assists: 1 }, { shotsOnTarget: 1 }]) {
    assert.equal(normalizeHighlightly(capture({ name: "Rodri", fullName: alias.name }, stats, primary), primary).observations.length, 0);
  }
});
test("captured aliases preserve primary and external identity ambiguity rejection", () => {
  const alias = { name: "Rodrigo Hernández Cascante", archiveId: "b".repeat(64), contentSha256: "c".repeat(64),
    retrievedAt: "2026-11-12T12:00:00.000Z" };
  const primary = { ...fixture, appearances: [{ ...fixture.appearances[0], name: "Rodrigo", nameAliases: [alias] }] };
  const ambiguous = { ...primary, appearances: [...primary.appearances,
    { ...primary.appearances[0], id: "second", playerId: "second-player", name: alias.name, nameAliases: [] }] };
  assert.equal(normalizeHighlightly(capture({ name: "Rodri", fullName: alias.name }, {}, ambiguous), ambiguous).observations.length, 0);
  const duplicate = capture({ name: "Rodri", fullName: alias.name }, {}, primary);
  const bundle = JSON.parse(duplicate.text), boxes = JSON.parse(bundle.capture.text);
  boxes[0].players.push({ ...boxes[0].players[0], id: 5, name: "R. Hernández Cascante" });
  bundle.capture.text = JSON.stringify(boxes); duplicate.text = JSON.stringify(bundle);
  assert.equal(normalizeHighlightly(duplicate, primary).observations.length, 0);
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
  assert.equal(normalizeHighlightly(capture({ name: "L. O&apos;Nien", minutesPlayed: 89 }), primary).observations.length, 1);
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

const supplementBudget = { async reserveRequest() {}, async observeQuota() {} };
function responseClient(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new HighlightlyClient(supplementBudget, "private-test-credential", async () => new Response(JSON.stringify(body), { status, headers }));
}
test("only explicit unavailable box resources are isolated from global HTTP failures", async () => {
  for (const sample of [
    { status: 404, body: {}, path: "/box-score/1", scope: "resource", reason: "missing_box" },
    { status: 404, body: {}, path: "/matches?leagueId=33973", scope: "provider", reason: "rejected" },
    { status: 400, body: { message: "Invalid matchId" }, path: "/box-score/1", scope: "resource", reason: "invalid_resource" },
    { status: 400, body: { error: "Box score not found" }, path: "/box-score/1", scope: "resource", reason: "invalid_resource" },
    { status: 400, body: { message: "Malformed request" }, path: "/box-score/1", scope: "provider", reason: "rejected" },
    { status: 400, body: { error: "Invalid API key" }, path: "/box-score/1", scope: "provider", reason: "authentication" },
    { status: 401, body: { message: "Invalid matchId" }, path: "/box-score/1", scope: "provider", reason: "authentication" },
    { status: 403, body: {}, path: "/box-score/1", scope: "provider", reason: "authentication" },
    { status: 429, body: {}, path: "/box-score/1", scope: "provider", reason: "rate_limit" },
    { status: 500, body: { message: "Box score not found" }, path: "/box-score/1", scope: "provider", reason: "unavailable" },
  ]) {
    await assert.rejects(responseClient(sample.body, sample.status).get("get_statistics", sample.path), (error: unknown) => {
      assert(error instanceof HighlightlyError);
      assert(error instanceof ProviderError);
      assert.equal(error.scope, sample.scope); assert.equal(error.reason, sample.reason); assert.equal(error.status, sample.status);
      assert.equal(error.retryable, sample.status === 429 || sample.status >= 500);
      return true;
    });
  }
});
test("HTTP 200 error envelopes cannot become source captures or leak upstream details", async () => {
  for (const sample of [
    { body: { error: "Too many requests", statusCode: 429 }, scope: "provider", reason: "rate_limit", code: "provider_rate_limit" },
    { body: { message: "You have exceeded the DAILY quota for Requests on your current plan" }, scope: "provider", reason: "rate_limit", code: "provider_rate_limit" },
    { body: { status: "403", error: "Forbidden" }, scope: "provider", reason: "authentication", code: "http_rejected" },
    { body: { errors: [{ message: "Service unavailable" }] }, scope: "provider", reason: "unavailable", code: "provider_unavailable" },
    { body: { error: "Box score not found" }, scope: "resource", reason: "invalid_resource", code: "provider_rejected" },
    { body: [{ error: "Invalid matchId" }], scope: "resource", reason: "invalid_resource", code: "provider_rejected" },
    { body: { error: "Unrecognized upstream failure marker-sensitive" }, scope: "provider", reason: "rejected", code: "provider_rejected" },
  ]) {
    await assert.rejects(responseClient(sample.body).get("get_statistics", "/box-score/1"), (error: unknown) => {
      assert(error instanceof HighlightlyError);
      assert.equal(error.scope, sample.scope); assert.equal(error.reason, sample.reason); assert.equal(error.code, sample.code);
      assert.equal(error.status, 200);
      assert(!JSON.stringify(error).includes("marker-sensitive"));
      assert(!error.message.includes("marker-sensitive"));
      return true;
    });
  }
  // An absent optional metric and a schema-permitted empty box are data, not an
  // error envelope. Strict fixture/player validation remains the normalizer's job.
  assert.equal((await responseClient([]).get("get_statistics", "/box-score/1")).text, "[]");
  const schedule = { data: [], errors: [], message: "No matches", pagination: { totalCount: 0 } };
  assert.deepEqual(JSON.parse((await responseClient(schedule).get("get_events", "/matches?leagueId=33973")).text), schedule);
});
test("rate-limit retry timing respects Retry-After and reset seconds with bounded fallback", async () => {
  const samples: { headers: HeadersInit; delay: number }[] = [
    { headers: { "retry-after": "3" }, delay: 3000 },
    { headers: { "retry-after": "3", "x-ratelimit-requests-reset": "30" }, delay: 3000 },
    { headers: { "x-ratelimit-requests-reset": "120" }, delay: 120_000 },
    { headers: { "retry-after": "0" }, delay: 1000 },
    { headers: { "retry-after": "-1", "x-ratelimit-requests-reset": "invalid" }, delay: 3_600_000 },
    { headers: { "retry-after": "1.5" }, delay: 3_600_000 },
    { headers: { "x-ratelimit-requests-reset": "1800000000" }, delay: 86_400_000 },
  ];
  for (const sample of samples) {
    const before = Date.now();
    await assert.rejects(responseClient({}, 429, sample.headers).get("get_statistics", "/box-score/1"), (error: unknown) => {
      assert(error instanceof HighlightlyError); assert(error.retryAt);
      assert(error.retryAt.getTime() >= before + sample.delay);
      assert(error.retryAt.getTime() <= Date.now() + sample.delay);
      return true;
    });
  }
  await assert.rejects(responseClient({ error: "Too many requests" }, 200, { "retry-after": "90" }).get("get_statistics", "/box-score/1"), (error: unknown) => {
    assert(error instanceof HighlightlyError); assert(error.retryAt);
    assert(Math.abs(error.retryAt.getTime() - Date.now() - 90_000) < 1000);
    return true;
  });
});
test("service failures honor HTTP-date Retry-After without treating a daily reset as a service outage", async () => {
  const requested = new Date(Date.now() + 120_000).toUTCString();
  await assert.rejects(responseClient({}, 503, { "retry-after": requested, "x-ratelimit-requests-reset": "600" }).get("get_statistics", "/box-score/1"), (error: unknown) => {
    assert(error instanceof HighlightlyError); assert(error.retryAt);
    assert.equal(error.retryAt.getTime(), Date.parse(requested)); return true;
  });
  await assert.rejects(responseClient({}, 503, { "x-ratelimit-requests-reset": "600" }).get("get_statistics", "/box-score/1"), (error: unknown) => {
    assert(error instanceof HighlightlyError); assert.equal(error.retryAt, undefined); return true;
  });
});
test("quota persistence failures retain their identity and stop before accepting a capture", async () => {
  const persistence = new Error("Synthetic quota persistence failure");
  let calls = 0, cancelled = false;
  const client = new HighlightlyClient({ async reserveRequest() {}, async observeQuota() { throw persistence; } }, "private-test-credential", async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "x-ratelimit-requests-remaining": "88" } });
  });
  await assert.rejects(client.get("get_statistics", "/box-score/1"), (error: unknown) => error === persistence);
  assert.equal(calls, 1); assert.equal(cancelled, true);
  const beforeRequest = new HighlightlyClient({ async reserveRequest() { throw persistence; }, async observeQuota() {} }, "private-test-credential", async () => {
    assert.fail("a failed durable reservation must stop HTTP");
  });
  await assert.rejects(beforeRequest.get("get_statistics", "/box-score/1"), (error: unknown) => error === persistence);
});
test("transport failures and malformed successful bodies expose only safe global diagnostics", async () => {
  const client = new HighlightlyClient(supplementBudget, "private-test-credential", async () => { throw new Error("Synthetic secret-bearing socket details"); });
  await assert.rejects(client.get("get_statistics", "/box-score/1"), (error: unknown) => {
    assert(error instanceof HighlightlyError); assert.equal(error.scope, "provider"); assert.equal(error.reason, "transport");
    assert.equal(error.retryable, true); assert(!error.message.includes("socket")); return true;
  });
  for (const body of ["broken-json", "null", "42", '{"unexpected":"object"}']) {
    const malformed = new HighlightlyClient(supplementBudget, "private-test-credential", async () => new Response(body));
    await assert.rejects(malformed.get("get_statistics", "/box-score/1"), (error: unknown) => {
      assert(error instanceof HighlightlyError); assert.equal(error.scope, "provider"); assert.equal(error.reason, "invalid_response"); return true;
    });
  }
});
test("a failed advisory-lock query releases its pooled connection", async () => {
  let released = 0;
  const pool = { async connect() { return { async query() { throw new Error("Synthetic database outage"); }, release() { released++; } }; } };
  const db = { collection() { return {}; } };
  const pipeline = new EnrichmentPipeline(pool as unknown as Pool, db as unknown as Db, "private-test-credential");
  await assert.rejects(pipeline.run(), /Synthetic database outage/);
  assert.equal(released, 1);
});
