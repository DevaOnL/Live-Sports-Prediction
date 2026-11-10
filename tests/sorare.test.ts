import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ProviderError } from "../src/server/ingestion/provider";
import { CURRENT_SOURCE } from "../src/server/ingestion/sources";
import { SorareCaptureError, SorareClient, SorarePipeline, SORARE_FORMAT, SORARE_QUERIES, normalizeSorareCapture } from "../src/server/ingestion/sorare";
import { RateLimitError } from "../src/server/ingestion/store";
import type { ProviderAction, ProviderResponse } from "../src/server/ingestion/types";

const coverage = CURRENT_SOURCE.coverage[0];
const uuid = (number: number) => `00000000-0000-0000-0000-${String(number).padStart(12, "0")}`;
const club = (number: number) => ({ id: `Club:${uuid(number)}`, slug: `club-${number}`, name: `Club ${number}` });
const player = (number: number) => ({ id: `Player:${uuid(number)}`, slug: `player-${number}`, displayName: `Player ${number}`, position: "Forward" });
const game = (number = 1) => ({ id: `Game:${uuid(number)}`, date: "2026-11-01T15:00:00Z", competition: { slug: coverage.id },
  homeTeam: club(1), awayTeam: club(2), statusTyped: "played", homeGoals: 1, awayGoals: 0, lowCoverage: true, scored: true, coverageStatus: "FULL" });
const connection = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
type Kind = keyof typeof SORARE_QUERIES;
function capture(kind: Kind, variables: Record<string, unknown>, football: unknown, retrievedAt = "2026-11-10T15:00:00.000Z") {
  return { query: SORARE_QUERIES[kind], variables, retrievedAt, text: JSON.stringify({ data: { football } }) };
}
function response(action: ProviderAction, captures: unknown[], complete = true): ProviderResponse {
  const text = JSON.stringify({ format: SORARE_FORMAT, complete, captures });
  return { action, params: { provider: "sorare", format: SORARE_FORMAT, league_id: coverage.id, ...(action === "get_statistics" ? { match_id: game().id } : {}) },
    resourceKey: "sorare:synthetic", retrievedAt: "2026-11-10T15:01:00.000Z", text, contentSha256: createHash("sha256").update(text).digest("hex") };
}
function stats(overrides: Record<string, unknown> = {}, scoreOverrides: Record<string, unknown> = {}) {
  return { anyPlayer: player(1), anyPlayerGameStats: { anyTeam: club(1), minsPlayed: 90, goals: 1, goalAssist: null,
    ontargetScoringAtt: 2, totalTackle: null, wonTackle: 2, interceptionWon: null, saves: null, goalsConceded: 0,
    playedInGame: true, onGameSheet: true, fieldStatus: "ON_FIELD", reviewed: false, live: false, ...overrides },
    scoreStatus: "REVIEWING", scoringVersion: 1, detailedScore: [ { stat: "goal_assist", statValue: 0 }, { stat: "interception_won", statValue: 0 }, { stat: "won_tackle", statValue: 2 } ], ...scoreOverrides };
}
function statistics(scores: unknown[] = [stats()], formations: Record<string, unknown> = {}) {
  return response("get_statistics", [capture("statistics", { id: uuid(1) }, { game: { ...game(),
    homeFormation: { startingLineupAvailable: true, startingLineup: [[player(1)]], bench: [player(2)] },
    awayFormation: { startingLineupAvailable: true, startingLineup: [[player(3)]], bench: [] }, playerGameScores: scores, ...formations } })]);
}

test("Sorare transport uses a fixed POST endpoint/header and preserves exact response capture bytes", async () => {
  const attempts: string[] = [];
  const raw = ' {"data":{"football":{"competition":{"slug":"premier-league-gb-eng","contestants":[]}}}}\n';
  const client = new SorareClient({ reserveRequest: async (_action, resource) => { attempts.push(resource); } }, "synthetic-secret", async (url, options) => {
    assert.equal(String(url), "https://api.sorare.com/graphql");
    assert.equal(options?.method, "POST"); assert.equal(options?.redirect, "error");
    assert.equal(new Headers(options?.headers).get("APIKEY"), "synthetic-secret");
    assert(!String(options?.body).includes("synthetic-secret"));
    return new Response(raw);
  });
  const result = await client.request("get_standings", { league_id: coverage.id });
  const bundle = JSON.parse(result.text);
  assert.equal(bundle.captures[0].text, raw); assert.equal(bundle.complete, true);
  assert.equal(result.params.provider, "sorare"); assert.equal(attempts.length, 1);
  assert(attempts.every((resource) => resource.startsWith("sorare:")));
  assert(!result.text.includes("synthetic-secret"));
});

test("Sorare transport rejects out-of-scope requests before reserving attempts", async () => {
  let attempts = 0;
  const client = new SorareClient({ reserveRequest: async () => { attempts++; } }, "secret", async () => { throw new Error("unexpected"); });
  for (const params of [{ league_id: "153" }, { league_id: coverage.id, token: "bad" }] as Record<string, string>[]) {
    await assert.rejects(() => client.request("get_events", params), (error) => error instanceof ProviderError && error.code === "request_invalid");
  }
  await assert.rejects(() => client.request("get_statistics", { league_id: coverage.id, match_id: "player-slug" }), /outside approved/);
  assert.equal(attempts, 0);
});

test("Sorare transport sanitizes GraphQL errors, key echoes, HTTP failures, redirects and oversized bodies", async () => {
  const cases = [
    [() => new Response(JSON.stringify({ errors: [{ message: "synthetic-secret query rejected" }] })), "credential_echo", false],
    [() => new Response(JSON.stringify({ errors: [{ message: "Rate limit with private details" }] })), "provider_rate_limit", true],
    [() => new Response(JSON.stringify({ errors: [{ message: "Unknown private field" }] })), "provider_rejected", false],
    [() => new Response("private body", { status: 503 }), "http_unavailable", true],
    [() => new Response("", { status: 302 }), "redirect_rejected", false],
    [() => new Response("", { headers: { "content-length": String(8 * 1024 * 1024 + 1) } }), "response_too_large", false],
  ] as const;
  for (const [makeResponse, code, retryable] of cases) {
    let attempts = 0;
    const client = new SorareClient({ reserveRequest: async () => { attempts++; } }, "synthetic-secret", async () => makeResponse());
    await assert.rejects(() => client.request("get_standings", { league_id: coverage.id }), (error) => {
      assert(error instanceof ProviderError); assert.equal(error.code, code); assert.equal(error.retryable, retryable);
      assert(!error.message.includes("private")); assert(!error.message.includes("synthetic-secret")); return true;
    });
    assert.equal(attempts, 1);
  }
});

test("every roster page and every club's activePlayers page consumes an attempt", async () => {
  let attempts = 0;
  let calls = 0;
  const client = new SorareClient({ reserveRequest: async () => { attempts++; } }, "synthetic-secret", async (_url, options) => {
    const { query, variables } = JSON.parse(String(options?.body)); calls++;
    if (query === SORARE_QUERIES.teams) return Response.json({ data: { football: { competition: { slug: coverage.id,
      teams: variables.after === null ? connection(Array.from({ length: 10 }, (_, index) => club(index + 1)), true, "team-page-2")
        : connection(Array.from({ length: 10 }, (_, index) => club(index + 11))) } } } });
    assert.equal(query, SORARE_QUERIES.players);
    const number = Number(variables.slug.slice(5));
    return Response.json({ data: { football: { club: { ...club(number),
      activePlayers: variables.after === null ? connection([player(number * 10)], true, "player-page-2") : connection([player(number * 10 + 1)]) } } } });
  });
  const result = await client.request("get_teams", { league_id: coverage.id });
  const batch = normalizeSorareCapture(result, coverage);
  assert.equal(calls, 42); assert.equal(attempts, calls); assert.equal(batch.clubs.length, 20);
  assert.equal(batch.players.length, 40); assert.equal(batch.roster?.complete, true);
  assert.equal(batch.roster?.entries.length, 40);
});

test("incomplete cursor chains and conflicting roster membership never claim a complete roster", () => {
  const teams = Array.from({ length: 20 }, (_, index) => club(index + 1));
  const captures = [capture("teams", { slug: coverage.id, after: null }, { competition: { slug: coverage.id, teams: connection(teams) } }),
    ...teams.map((known, index) => capture("players", { slug: known.slug, after: null }, { club: { ...known,
      activePlayers: connection([player(index === 1 ? 1 : index + 1)], index === 2, index === 2 ? "missing-next" : null) } }))];
  const batch = normalizeSorareCapture(response("get_teams", captures), coverage);
  assert.equal(batch.roster?.complete, false);
  assert(batch.issues.some((issue) => issue.code === "conflicting_roster_membership"));
  assert(batch.issues.some((issue) => issue.code === "missing_capture_pages"));
});

test("failed multi-page captures remain explicitly incomplete and unimportable", async () => {
  let calls = 0;
  const client = new SorareClient({ reserveRequest: async () => {} }, "synthetic-secret", async () => {
    calls++;
    return calls === 1 ? Response.json({ data: { football: { competition: { slug: coverage.id,
      pastGames: connection([game()], true, "next") } } } }) : new Response("unavailable", { status: 503 });
  });
  await assert.rejects(() => client.request("get_events", { league_id: coverage.id }), (error) => {
    assert(error instanceof SorareCaptureError); assert.equal(error.retryable, true);
    assert.equal(JSON.parse(error.capture.text).complete, false);
    assert.equal(normalizeSorareCapture(error.capture, coverage).fixtures.length, 0); return true;
  });
});

test("long shared quota exhaustion propagates without an HTTP attempt", async () => {
  let calls = 0;
  const client = new SorareClient({ reserveRequest: async () => { throw new RateLimitError(new Date(Date.now() + 60_000)); } }, "synthetic-secret", async () => { calls++; return Response.json({}); });
  await assert.rejects(() => client.request("get_events", { league_id: coverage.id }), RateLimitError);
  assert.equal(calls, 0);
});

test("a local pacing deadline that expires during the SQL round trip is reserved again", async () => {
  let reservations = 0, calls = 0;
  const client = new SorareClient({ reserveRequest: async () => {
    if (++reservations === 1) throw new RateLimitError(new Date(Date.now() - 1));
  } }, "synthetic-secret", async () => {
    calls++;
    return Response.json({ data: { football: { competition: { slug: coverage.id, contestants: [] } } } });
  });
  const result = await client.request("get_standings", { league_id: coverage.id });
  assert.equal(JSON.parse(result.text).complete, true);
  assert.equal(reservations, 2); assert.equal(calls, 1);
});

test("expired local pacing deadlines remain bounded and never bypass reservation", async () => {
  let reservations = 0, calls = 0;
  const client = new SorareClient({ reserveRequest: async () => {
    reservations++;
    throw new RateLimitError(new Date(Date.now() - 1));
  } }, "synthetic-secret", async () => { calls++; return Response.json({}); });
  await assert.rejects(() => client.request("get_standings", { league_id: coverage.id }), RateLimitError);
  assert.equal(reservations, 11); assert.equal(calls, 0);
});

test("partial captures are quarantined while their original local budget exhaustion propagates", async () => {
  let reservations = 0, calls = 0, imports = 0;
  const limit = new RateLimitError(new Date(Date.now() + 60_000));
  const client = new SorareClient({ reserveRequest: async () => {
    if (++reservations > 1) throw limit;
  } }, "synthetic-secret", async () => {
    calls++;
    return Response.json({ data: { football: { competition: { slug: coverage.id,
      teams: connection(Array.from({ length: coverage.expectedClubs }, (_, index) => club(index + 1))) } } } });
  });
  const pipeline = new SorarePipeline({ connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) } as never,
    { collection: () => ({}) } as never, "synthetic-secret");
  const saved: ProviderResponse[] = [], marks: unknown[] = [];
  pipeline.provider.request = client.request.bind(client);
  pipeline.archives.pending = async () => [];
  pipeline.archives.save = async (value) => { saved.push(value); return { ...value, id: "partial-archive" }; };
  pipeline.archives.mark = async (...args) => { marks.push(args); };
  pipeline.store.import = async () => { imports++; throw new Error("partial captures must never import"); };
  await assert.rejects(() => pipeline.sync(), (error) => error === limit);
  assert.equal(reservations, 2); assert.equal(calls, 1); assert.equal(imports, 0);
  assert.equal(saved.length, 1);
  const bundle = JSON.parse(saved[0].text);
  assert.equal(bundle.complete, false); assert.equal(bundle.captures.length, 1);
  assert.equal(normalizeSorareCapture(saved[0], coverage).players.length, 0);
  assert.deepEqual(marks, [["partial-archive", "invalid", [{ code: "incomplete_capture", resource: "get_teams" }]]]);
});

test("statistics preserve native IDs, explicit detail zeros, reviewed state and unavailable metrics", () => {
  const batch = normalizeSorareCapture(statistics(), coverage);
  const fixture = batch.fixtures[0], appearance = fixture.appearances.find((item) => item.player.id === player(1).id)!;
  assert.equal(fixture.id, game().id); assert.equal(fixture.home.id, club(1).id); assert.equal(fixture.status, "final");
  assert.equal(appearance.player.slug, "player-1"); assert.equal(appearance.minutes, 90); assert.equal(appearance.assists, 0);
  assert.equal(appearance.interceptions, 0); assert.equal(appearance.tackles, null);
  assert.equal(appearance.rating, null); assert.equal(appearance.keyPasses, null);
  assert.equal(fixture.statisticsStatus, "partial"); assert(batch.issues.some((issue) => issue.code === "statistics_under_review"));
  assert.equal(fixture.appearances.find((item) => item.player.id === player(2).id)?.participation, "unknown");
});

test("direct/detail conflicts stay null and fantasy score/playedInLineup never provide observations", () => {
  const batch = normalizeSorareCapture(statistics([stats({ goalAssist: 1, minsPlayed: null, playedInGame: undefined, fieldStatus: "UNKNOWN", playedInLineup: true },
    { score: 99, scoreStatus: "FINAL" })]), coverage);
  const appearance = batch.fixtures[0].appearances[0];
  assert.equal(appearance.assists, null); assert.equal(appearance.rating, null); assert.equal(appearance.participation, "unknown");
  assert(batch.issues.some((issue) => issue.code === "conflicting_metric" && issue.field === "goalAssist"));
});

test("DNP requires affirmative evidence and does not turn unreported counts into zero", () => {
  const score = stats({ minsPlayed: null, playedInGame: false, onGameSheet: false, fieldStatus: "NOT_ON_GAME_SHEET", goals: null, ontargetScoringAtt: null, goalsConceded: null },
    { scoreStatus: "DID_NOT_PLAY", detailedScore: [{ stat: "mins_played", statValue: 0 }] });
  const appearance = normalizeSorareCapture(statistics([score]), coverage).fixtures[0].appearances[0];
  assert.equal(appearance.participation, "dnp"); assert.equal(appearance.minutes, 0); assert.equal(appearance.goals, null);
});

test("scheduled score placeholders stay unknown and season-external fixtures stay excluded", () => {
  const inside = { ...game(), statusTyped: "scheduled", homeGoals: 0, awayGoals: 0 };
  const outside = { ...game(2), date: "2025-11-01T15:00:00Z" };
  const result = normalizeSorareCapture(response("get_events", [
    capture("past", { slug: coverage.id, after: null }, { competition: { slug: coverage.id, pastGames: connection([outside]) } }),
    capture("future", { slug: coverage.id, after: null }, { competition: { slug: coverage.id, futureGames: connection([inside]) } }),
  ]), coverage);
  assert.equal(result.fixtures.length, 1); assert.equal(result.fixtures[0].homeScore, null); assert.equal(result.fixtures[0].awayScore, null);
  assert(result.issues.some((issue) => issue.code === "incomplete_schedule"));
});

test("explicit suspension remains nonfinal while unrecognized fixture statuses remain unknown", () => {
  for (const statusTyped of ["suspended", "unrecognized-provider-state"]) {
    const result = normalizeSorareCapture(response("get_events", [
      capture("past", { slug: coverage.id, after: null }, { competition: { slug: coverage.id,
        pastGames: connection([{ ...game(), statusTyped, homeGoals: 9, awayGoals: 8 }]) } }),
      capture("future", { slug: coverage.id, after: null }, { competition: { slug: coverage.id, futureGames: connection([]) } }),
    ]), coverage);
    const fixture = result.fixtures[0];
    assert.equal(fixture.status, statusTyped === "suspended" ? "suspended" : "unknown");
    assert.equal(fixture.homeScore, null);
    assert.equal(fixture.awayScore, null);
    assert.equal(fixture.statisticsStatus, "unknown");
    assert.equal(fixture.detailed, false);
    assert.deepEqual(fixture.appearances, []);
    assert.equal(result.issues.some((issue) => issue.code === "unknown_status"), statusTyped !== "suspended");
    assert(result.issues.some((issue) => issue.code === "incomplete_schedule"));
  }
});

test("standings use actual contestant totals and the explicit season year", () => {
  const captures = [capture("standings", { slug: coverage.id, year: 2026 }, { competition: { slug: coverage.id,
    contestants: [{ anyTeam: club(1), matchesPlayed: 3, matchesWon: 2, matchesDrawn: 1, matchesLost: 0, goalsFor: 7, goalsAgainst: 2, points: 7, rank: 1 }] } })];
  const batch = normalizeSorareCapture(response("get_standings", captures), coverage);
  assert.deepEqual(batch.standings[0], { clubId: club(1).id, played: 3, wins: 2, draws: 1, losses: 0, goalsFor: 7, goalsAgainst: 2, points: 7 });
  assert(batch.issues.some((issue) => issue.code === "incomplete_standings"));
});

test("game lookups remove only the typed Game prefix while retaining native identity in provenance", async () => {
  const client = new SorareClient({ reserveRequest: async () => {} }, "synthetic-secret", async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    assert.deepEqual(request.variables, { id: uuid(1) });
    return Response.json({ data: { football: { game: game() } } });
  });
  const result = await client.request("get_statistics", { league_id: coverage.id, match_id: game().id });
  assert.equal(result.params.match_id, game().id); assert(result.resourceKey.includes(game().id));
});

test("Sorare streamed byte bounds cancel oversized and stalled bodies", async (context) => {
  let cancelled = false;
  const oversized = new SorareClient({ reserveRequest: async () => {} }, "synthetic-secret", async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024)); controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(() => oversized.request("get_standings", { league_id: coverage.id }),
    (error) => error instanceof ProviderError && error.code === "response_too_large");
  assert.equal(cancelled, true);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let stalledCancelled = false;
  const stalled = new SorareClient({ reserveRequest: async () => {} }, "synthetic-secret", async () => new Response(new ReadableStream<Uint8Array>({ cancel() { stalledCancelled = true; } })));
  const rejection = assert.rejects(stalled.request("get_standings", { league_id: coverage.id }),
    (error) => error instanceof ProviderError && error.code === "request_timeout" && error.retryable);
  for (let index = 0; index < 8; index++) await Promise.resolve();
  context.mock.timers.tick(30_000);
  await rejection; assert.equal(stalledCancelled, true);
});

test("cursor loops fail with a private partial capture instead of silently truncating the schedule", async () => {
  let calls = 0;
  const client = new SorareClient({ reserveRequest: async () => {} }, "synthetic-secret", async () => {
    calls++;
    return Response.json({ data: { football: { competition: { slug: coverage.id, pastGames: connection([game()], true, "same-cursor") } } } });
  });
  await assert.rejects(() => client.request("get_events", { league_id: coverage.id }), (error) => {
    assert(error instanceof SorareCaptureError); assert.equal(JSON.parse(error.capture.text).complete, false); return true;
  });
  assert.equal(calls, 2);
});

test("conflicting positive counts cannot confirm a reported DNP", () => {
  const score = stats({ minsPlayed: null, playedInGame: false, fieldStatus: "NOT_ON_GAME_SHEET" }, { detailedScore: [] });
  const batch = normalizeSorareCapture(statistics([score]), coverage);
  assert.equal(batch.fixtures[0].appearances[0].participation, "unknown");
  assert(batch.issues.some((issue) => issue.code === "conflicting_participation"));
});

test("players-page native club identity must match its team listing even when the slug matches", async () => {
  const teams = Array.from({ length: 20 }, (_, index) => club(index + 1));
  const captures = [capture("teams", { slug: coverage.id, after: null }, { competition: { slug: coverage.id, teams: connection(teams) } }),
    ...teams.map((known, index) => capture("players", { slug: known.slug, after: null }, { club: { ...known,
      ...(index === 0 ? { id: club(99).id } : {}), activePlayers: connection([player(index + 1)]) } }))];
  const batch = normalizeSorareCapture(response("get_teams", captures), coverage);
  assert.equal(batch.roster?.complete, false);
  assert(batch.issues.some((issue) => issue.code === "invalid_capture_scope"));
  let calls = 0;
  const client = new SorareClient({ reserveRequest: async () => {} }, "synthetic-secret", async () => {
    calls++;
    return calls === 1 ? Response.json({ data: { football: { competition: { slug: coverage.id, teams: connection(teams) } } } })
      : Response.json({ data: { football: { club: { ...club(1), id: club(99).id, activePlayers: connection([player(1)]) } } } });
  });
  await assert.rejects(() => client.request("get_teams", { league_id: coverage.id }), SorareCaptureError);
});

test("an explicit score player with missing statistics remains an unknown appearance", () => {
  const batch = normalizeSorareCapture(statistics([{ anyPlayer: player(99), anyPlayerGameStats: null }]), coverage);
  const unknown = batch.fixtures[0].appearances.find((appearance) => appearance.player.id === player(99).id);
  assert(unknown); assert.equal(unknown.participation, "unknown"); assert.equal(unknown.minutes, null); assert.equal(unknown.clubId, "");
  assert(batch.players.some((known) => known.id === player(99).id));
  assert(batch.issues.some((issue) => issue.code === "invalid_player_statistics" && issue.resource === player(99).id));
});

test("a game response for another native fixture cannot import its clubs or observations", () => {
  const raw = statistics();
  const bundle = JSON.parse(raw.text);
  const payload = JSON.parse(bundle.captures[0].text);
  payload.data.football.game.id = game(99).id;
  bundle.captures[0].text = JSON.stringify(payload);
  const batch = normalizeSorareCapture({ ...raw, text: JSON.stringify(bundle) }, coverage);
  assert.equal(batch.fixtures.length, 0); assert.equal(batch.clubs.length, 0); assert.equal(batch.players.length, 0);
  assert(batch.issues.some((issue) => issue.code === "mismatched_fixture"));
});

test("season-boundary pagination rejects a nonchronological connection", async () => {
  const current = game();
  const old = { ...game(2), date: "2025-01-01T15:00:00Z" };
  const client = new SorareClient({ reserveRequest: async () => {} }, "synthetic-secret", async () => Response.json({ data: { football: { competition: {
    slug: coverage.id, pastGames: connection([old, current], true, "later") } } } }));
  await assert.rejects(() => client.request("get_events", { league_id: coverage.id }), SorareCaptureError);
  const normalized = normalizeSorareCapture(response("get_events", [
    capture("past", { slug: coverage.id, after: null }, { competition: { slug: coverage.id, pastGames: connection([old, current]) } }),
    capture("future", { slug: coverage.id, after: null }, { competition: { slug: coverage.id, futureGames: connection([]) } }),
  ]), coverage);
  assert.equal(normalized.fixtures.length, 0); assert(normalized.issues.some((issue) => issue.code === "invalid_game_order"));
});

test("JSON escaping cannot hide an echoed API header credential", async () => {
  for (const key of ['synthetic-"secret"', "synthetic-secret"]) {
    const encoded = JSON.stringify({ data: { football: { competition: { slug: coverage.id, privateEcho: key } } } }).replaceAll("synthetic", "\\u0073ynthetic");
    assert(!encoded.includes(key));
    const client = new SorareClient({ reserveRequest: async () => {} }, key, async () => new Response(encoded));
    await assert.rejects(() => client.request("get_standings", { league_id: coverage.id }),
      (error) => error instanceof ProviderError && error.code === "credential_echo" && !error.message.includes(key));
  }
});
