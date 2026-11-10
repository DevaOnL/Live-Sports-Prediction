import assert from "node:assert/strict";
import type { ProviderAction } from "../../src/server/ingestion/types";

export type WorkerFixtures = {
  teams: Record<string, unknown[]>;
  events: Record<string, Record<string, unknown>[]>;
  standings: Record<string, unknown[]>;
  statistics: Record<string, { player_statistics: Record<string, unknown>[] }>;
};
export type ProviderCommand =
  | { type: "configure"; token: string; fixtures: WorkerFixtures }
  | { type: "hold"; token: string; action: ProviderAction }
  | { type: "release"; token: string }
  | { type: "rating"; token: string; fixtureId: string; playerId: string; rating: string };
export type ProviderMessage =
  | { type: "ready" }
  | { type: "ack"; token: string }
  | { type: "request"; action: ProviderAction; leagueId: string; fixtureId: string | null; held: boolean }
  | { type: "unexpected" };

// This preload is never imported by production code. There is deliberately no
// original-fetch fallback: every source request stays inside this child process.
assert.equal(process.env.NODE_ENV, "test");
assert.equal(typeof process.send, "function", "worker fixture preload requires parent IPC");
assert.match(process.env.POSTGRES_DB ?? "", /_test$/);
assert.match(process.env.MONGO_DB ?? "", /_test$/);
assert(process.env.APIFOOTBALL_API_KEY === "synthetic-worker-process-only", "fixture preload requires a synthetic provider key");
assert(!Object.keys(process.env).some((key) => /BOOTSTRAP|MIGRATOR/.test(key)));

// Freeze only the worker's wall clock. Native timers, database leases and the
// parent's deadlines remain real; the supplied offset preserves elapsed time
// when the actual worker process is restarted later in the same test.
const NativeDate = Date;
const realStart = NativeDate.now();
const frozenStart = Number(process.env.WORKER_FIXTURE_CLOCK_MS);
const reference = NativeDate.UTC(2026, 10, 10, 12);
assert(Number.isSafeInteger(frozenStart) && frozenStart >= reference && frozenStart < reference + 300_000, "fixture clock must stay within the fixed test reference");
const frozenNow = () => frozenStart + NativeDate.now() - realStart;
globalThis.Date = new Proxy(NativeDate, {
  construct(target, argumentsList, newTarget) {
    return Reflect.construct(target, argumentsList.length ? argumentsList : [frozenNow()], newTarget);
  },
  apply() { return new NativeDate(frozenNow()).toString(); },
  get(target, property, receiver) { return property === "now" ? frozenNow : Reflect.get(target, property, receiver); },
});

let fixtures: WorkerFixtures | undefined;
let configured!: () => void;
const configuration = new Promise<void>((resolve) => { configured = resolve; });
let heldAction: ProviderAction | null = null;
const releases = new Set<() => void>();
const send = (message: ProviderMessage) => { process.send?.(message); };
process.on("message", (message: ProviderCommand) => {
  if (message.type === "configure") {
    fixtures = message.fixtures;
    configured();
  } else if (message.type === "hold") heldAction = message.action;
  else if (message.type === "release") {
    heldAction = null;
    for (const release of releases) release();
    releases.clear();
  } else if (message.type === "rating") {
    assert(fixtures);
    const row = fixtures.statistics[message.fixtureId].player_statistics.find((item) => item.player_key === message.playerId);
    assert(row);
    row.player_rating = message.rating;
  } else throw new Error("Invalid fixture control message");
  send({ type: "ack", token: message.token });
});
process.channel?.unref();

globalThis.fetch = async (input, options) => {
  await configuration;
  try {
    assert(fixtures);
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://apiv3.apifootball.com");
    assert.equal(url.pathname, "/");
    assert.equal(options?.method, "GET");
    assert.equal(url.searchParams.get("APIkey"), "synthetic-worker-process-only");
    assert([...url.searchParams.keys()].every((key) => ["action", "APIkey", "league_id", "match_id", "from", "to", "timezone"].includes(key)));
    const action = url.searchParams.get("action") as ProviderAction;
    const leagueId = url.searchParams.get("league_id")!;
    const fixtureId = url.searchParams.get("match_id");
    assert(["153", "164"].includes(leagueId));
    let payload: unknown;
    if (action === "get_teams") payload = fixtures.teams[leagueId];
    else if (action === "get_events") {
      assert.equal(url.searchParams.get("timezone"), "UTC");
      payload = fixtures.events[leagueId];
    } else if (action === "get_standings") payload = fixtures.standings[leagueId];
    else {
      assert.equal(action, "get_statistics");
      assert(fixtureId && fixtures.statistics[fixtureId]);
      payload = fixtures.statistics[fixtureId];
    }
    assert(payload);
    const held = action === heldAction;
    send({ type: "request", action, leagueId, fixtureId, held });
    if (held) await new Promise<void>((resolve, reject) => {
      const signal = options?.signal;
      const release = () => { signal?.removeEventListener("abort", abort); releases.delete(release); resolve(); };
      const abort = () => { releases.delete(release); reject(new Error("Synthetic source wait aborted")); };
      releases.add(release);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  } catch {
    send({ type: "unexpected" });
    throw new Error("Synthetic source request rejected locally");
  }
};
send({ type: "ready" });
