import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ProviderClient, ProviderError } from "../src/server/ingestion/provider";
import { RateLimitError } from "../src/server/ingestion/store";
import type { ProviderAction } from "../src/server/ingestion/types";

const KEY = "invented-provider-test-secret-1234";
const events = { league_id: "153", from: "2026-07-01", to: "2027-06-30", timezone: "UTC" };
function mock(
  run: (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => Promise<Response> = async () => new Response("[]"),
) {
  const attempts: { action: ProviderAction; resourceKey: string }[] = [];
  let calls = 0;
  const budget = { reserveRequest: async (action: ProviderAction, resourceKey: string) => { attempts.push({ action, resourceKey }); } };
  const fetcher: typeof fetch = async (input, init) => { calls++; return run(input, init); };
  return { client: new ProviderClient(budget, KEY, fetcher), attempts, calls: () => calls };
}
async function rejects(operation: Promise<unknown>, code: ProviderError["code"], retryable: boolean) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    assert.equal(String(error).includes(KEY), false);
    assert.equal(String(error).includes("https://"), false);
    return true;
  });
}

test("fixed provider URL receives the key while returned provenance and budget omit it", async () => {
  let captured: URL | undefined;
  const body = " [\n] ";
  const fixture = mock(async (input, init) => {
    captured = new URL(String(input));
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "omit");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(fixture.attempts.length, 1);
    return new Response(body);
  });
  const result = await fixture.client.request("get_events", events);
  assert.equal(captured?.origin, "https://apiv3.apifootball.com");
  assert.equal(captured?.pathname, "/");
  assert.equal(captured?.searchParams.get("APIkey"), KEY);
  assert.equal(captured?.searchParams.get("action"), "get_events");
  assert.equal(result.text, body);
  assert.equal(result.contentSha256, createHash("sha256").update(body).digest("hex"));
  assert.ok(Number.isFinite(Date.parse(result.retrievedAt)));
  assert.deepEqual(result.params, { from: events.from, league_id: "153", timezone: "UTC", to: events.to });
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(fixture.attempts).includes(KEY), false);
  assert.equal(JSON.stringify(fixture.client).includes(KEY), false);
});

test("canonical resource keys are stable across parameter order and isolate caller mutation", async () => {
  const fixture = mock();
  const first = await fixture.client.request("get_events", events);
  const second = await fixture.client.request("get_events", { timezone: "UTC", to: events.to, league_id: "153", from: events.from });
  assert.equal(first.resourceKey, second.resourceKey);
  let unblock: (() => void) | undefined;
  const pause = new Promise<void>((resolve) => { unblock = resolve; });
  const params = { league_id: "153" };
  const client = new ProviderClient({ reserveRequest: async () => pause }, KEY, async (input) => {
    assert.equal(new URL(String(input)).searchParams.get("league_id"), "153");
    return new Response("[]");
  });
  const pending = client.request("get_teams", params);
  params.league_id = "164";
  unblock?.();
  assert.equal((await pending).params.league_id, "153");
});

test("unapproved request keys and coverage fail before consuming budget or accessing network", async () => {
  const fixture = mock();
  const bad: [ProviderAction, Record<string, string>][] = [
    ["get_teams", { league_id: "152" }], ["get_teams", {}],
    ["get_teams", { league_id: "153", APIkey: KEY }],
    ["get_teams", { league_id: "153", url: "https://example.invalid" }],
    ["get_teams", { league_id: "153", action: "get_events" }],
    ["get_standings", { league_id: "153", season: "2027/28" }],
    ["get_statistics", { league_id: "153" }],
    ["get_statistics", { league_id: "153", match_id: "9001&APIkey=secret" }],
    ["get_statistics", { league_id: "153", match_id: "0" }],
    ["get_events", { ...events, timezone: "Europe/London" }],
    ["get_events", { ...events, from: "2026-02-30" }],
    ["get_events", { ...events, from: "2026-06-30" }],
    ["get_events", { ...events, to: "2027-07-01" }],
    ["get_events", { ...events, from: "2027-06-30", to: "2026-07-01" }],
    ["get_events", { league_id: "153", timezone: "UTC" }],
    ["get_events", { ...events, match_id: "9001" }],
  ];
  for (const [action, params] of bad) await rejects(fixture.client.request(action, params), "request_invalid", false);
  await rejects(fixture.client.request("constructor" as ProviderAction, { league_id: "153" }), "request_invalid", false);
  await rejects(fixture.client.request("get_teams", { league_id: 153 } as unknown as Record<string, string>), "request_invalid", false);
  assert.equal(fixture.attempts.length, 0);
  assert.equal(fixture.calls(), 0);
});

test("approved requests for both leagues and optional fixed match scope work", async () => {
  const fixture = mock();
  for (const league_id of ["153", "164"]) {
    await fixture.client.request("get_teams", { league_id });
    await fixture.client.request("get_standings", { league_id });
    await fixture.client.request("get_statistics", { league_id, match_id: "9001" });
    await fixture.client.request("get_events", { league_id, match_id: "9001", timezone: "UTC" });
  }
  assert.equal(fixture.attempts.length, 8);
  assert.equal(fixture.calls(), 8);
});

test("shared rate-limit error propagates unchanged without a network attempt", async () => {
  const limited = new RateLimitError(new Date(Date.now() + 10_000));
  let calls = 0;
  const client = new ProviderClient({ reserveRequest: async () => { throw limited; } }, KEY, async () => { calls++; return new Response("[]"); });
  await assert.rejects(client.request("get_teams", { league_id: "153" }), (error) => error === limited);
  assert.equal(calls, 0);
});

test("budget infrastructure failures are sanitized without a network attempt", async () => {
  const client = new ProviderClient({ reserveRequest: async () => { throw new Error(KEY); } }, KEY, async () => { throw new Error("must not run"); });
  await rejects(client.request("get_teams", { league_id: "153" }), "request_budget_unavailable", true);
});

test("failed transport consumes one reservation and is never retried or exposed", async () => {
  const fixture = mock(async () => { throw new Error(`https://apiv3.apifootball.com/?APIkey=${KEY}`); });
  await rejects(fixture.client.request("get_teams", { league_id: "153" }), "transport_failed", true);
  assert.equal(fixture.attempts.length, 1);
  assert.equal(fixture.calls(), 1);
});

test("HTTP retry classes and bounded Retry-After preserve request accounting", async () => {
  for (const [status, code, retryable] of [
    [401, "http_rejected", false], [404, "http_rejected", false],
    [429, "http_rate_limit", true], [500, "http_unavailable", true], [503, "http_unavailable", true],
  ] as const) {
    const fixture = mock(async () => new Response(KEY, { status, headers: { "retry-after": "999999999999" } }));
    const before = Date.now();
    await assert.rejects(fixture.client.request("get_teams", { league_id: "153" }), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      assert.equal(error.message.includes(KEY), false);
      if (retryable) {
        assert.ok(error.retryAt);
        assert.ok(error.retryAt.getTime() - before >= 1000);
        assert.ok(error.retryAt.getTime() - Date.now() <= 3_600_000);
      }
      return true;
    });
    assert.equal(fixture.attempts.length, 1);
    assert.equal(fixture.calls(), 1);
  }
  const dated = mock(async () => new Response("{}", { status: 429, headers: { "retry-after": new Date(Date.now() + 20_000).toUTCString() } }));
  await assert.rejects(dated.client.request("get_teams", { league_id: "153" }), (error: unknown) => {
    assert.ok(error instanceof ProviderError && error.retryAt);
    assert.ok(error.retryAt.getTime() > Date.now() + 15_000);
    assert.ok(error.retryAt.getTime() < Date.now() + 25_000);
    return true;
  });
});

test("redirect responses are rejected and never followed", async () => {
  const fixture = mock(async () => new Response(null, { status: 302, headers: { location: `https://example.invalid/${KEY}` } }));
  await rejects(fixture.client.request("get_teams", { league_id: "153" }), "redirect_rejected", false);
  assert.equal(fixture.calls(), 1);
});

test("technical provider JSON errors are sanitized before archiving", async () => {
  for (const [body, code, retryable] of [
    [{ error: 401, message: "Invalid authorization" }, "provider_rejected", false],
    [{ error: "429", message: "Too many requests" }, "provider_rate_limit", true],
    [{ error: { code: 503, message: "Temporarily unavailable" } }, "provider_unavailable", true],
    [[{ error: 500 }], "provider_unavailable", true],
    [{ errors: ["request limit exceeded"] }, "provider_rate_limit", true],
  ] as const) {
    const fixture = mock(async () => new Response(JSON.stringify(body)));
    await rejects(fixture.client.request("get_teams", { league_id: "153" }), code, retryable);
    assert.equal(fixture.attempts.length, 1);
  }
});

test("malformed successful JSON remains byte-for-byte text for archive and quarantine", async () => {
  for (const body of ["{ broken JSON", "", " [\n", "not football data"]) {
    const fixture = mock(async () => new Response(body));
    const result = await fixture.client.request("get_teams", { league_id: "153" });
    assert.equal(result.text, body);
    assert.equal(result.contentSha256, createHash("sha256").update(body).digest("hex"));
  }
});

test("a body echoing the actual credential is rejected", async () => {
  const fixture = mock(async () => new Response(JSON.stringify({ provider: KEY })));
  await rejects(fixture.client.request("get_teams", { league_id: "153" }), "credential_echo", false);
});

test("stream cap works without trustworthy Content-Length and cancels oversized bodies", async () => {
  let cancellations = 0;
  const bytes = new Uint8Array(8 * 1024 * 1024 + 1);
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); },
    cancel() { cancellations++; },
  });
  const fixture = mock(async () => new Response(body, { headers: { "content-length": "1" } }));
  await rejects(fixture.client.request("get_teams", { league_id: "153" }), "response_too_large", false);
  assert.equal(cancellations, 1);
  assert.equal(fixture.attempts.length, 1);
  const exact = mock(async () => new Response(" ".repeat(8 * 1024 * 1024)));
  assert.equal((await exact.client.request("get_teams", { league_id: "153" })).text.length, 8 * 1024 * 1024);
});

test("streamed cap counts bytes across chunks and announced excess cancels early", async () => {
  let cancelled = false;
  const fixture = mock(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024));
      controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
    }, cancel() { cancelled = true; },
  })));
  await rejects(fixture.client.request("get_teams", { league_id: "153" }), "response_too_large", false);
  assert.equal(cancelled, true);
  let earlyCancelled = false;
  const announced = mock(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { earlyCancelled = true; } }), { headers: { "content-length": "8388609" } }));
  await rejects(announced.client.request("get_teams", { league_id: "153" }), "response_too_large", false);
  assert.equal(earlyCancelled, true);
});

test("stream reader errors reveal no transport details", async () => {
  const fixture = mock(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error(`stream failed ${KEY}`)); },
  })));
  await rejects(fixture.client.request("get_teams", { league_id: "153" }), "transport_failed", true);
  assert.equal(fixture.attempts.length, 1);
});

test("deadline covers both fetching and stalled body reads", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const beforeHeaders = mock(async () => new Promise<Response>(() => undefined));
  const request = beforeHeaders.client.request("get_teams", { league_id: "153" });
  const rejected = rejects(request, "request_timeout", true);
  await Promise.resolve();
  context.mock.timers.tick(30_000);
  await rejected;
  let cancelled = false;
  const body = mock(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
  const streamed = body.client.request("get_teams", { league_id: "153" });
  const streamRejected = rejects(streamed, "request_timeout", true);
  // Allow the successful fetch result to reach its first pending reader call.
  for (let index = 0; index < 5; index++) await Promise.resolve();
  context.mock.timers.tick(30_000);
  await streamRejected;
  assert.equal(cancelled, true);
});

test("invalid credential configuration errors never echo the supplied value", () => {
  for (const key of ["", ` ${KEY}`, `${KEY}\n`, "a".repeat(513)]) {
    assert.throws(() => new ProviderClient({ reserveRequest: async () => undefined }, key), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "configuration_invalid");
      assert.equal(error.message.includes(KEY), false);
      return true;
    });
  }
});
