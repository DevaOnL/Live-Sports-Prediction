import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicApiError } from "../src/server/api/error";
import { enforceOrigin, HttpError, keys, optionalNumber, query, readJson, response } from "../src/server/web/http";

const origin = "http://127.0.0.1:3000";
const request = (method: string, headers: Record<string, string> = {}, body?: string) => new Request(origin, {
  method, headers: { host: "127.0.0.1:3000", ...headers }, body,
});

test("only branded application errors can expose a client message", () => {
  assert(isPublicApiError(new HttpError(409, "REVISION_CONFLICT", "Reload before correcting.")));
  assert(!isPublicApiError(Object.assign(new Error("private database diagnostic"), { status: 400, code: "INVALID_REQUEST" })));
  assert(!isPublicApiError(new HttpError(503, "DATABASE_ERROR", "private database diagnostic")));
});

test("mutations require the canonical origin and host despite spoofed forwarding headers", () => {
  enforceOrigin(request("GET"), origin);
  enforceOrigin(request("POST", { origin }), origin);
  for (const headers of ([{}, { origin: "null" }, { origin: "https://foreign.example" },
    { origin, host: "foreign.example", "x-forwarded-host": "127.0.0.1:3000" }] as Record<string, string>[])) {
    assert.throws(() => enforceOrigin(request("POST", headers), origin), (error) => error instanceof HttpError && error.status === 403);
  }
  assert.throws(() => enforceOrigin(request("GET", { origin: "https://foreign.example" }), origin), HttpError);
});

test("body limits inspect actual bytes even when a declared length is misleading", async () => {
  const oversized = JSON.stringify({ text: "x".repeat(16_385) });
  for (const length of [undefined, "1", String(oversized.length)]) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (length) headers["content-length"] = length;
    await assert.rejects(readJson(request("POST", headers, oversized)), (error) => error instanceof HttpError && error.status === 413);
  }
});

test("JSON parsing rejects invalid encodings, arrays, scalars and non-JSON forms", async () => {
  for (const body of ["[]", "null", "3", "\"text\"", "{broken"]) {
    await assert.rejects(readJson(request("POST", { "content-type": "application/json" }, body)), HttpError);
  }
  await assert.rejects(readJson(request("POST", { "content-type": "text/plain" }, "{}")), (error) => error instanceof HttpError && error.status === 415);
  const bad = new Request(origin, { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([0xff]) });
  await assert.rejects(readJson(bad), HttpError);
  assert.deepEqual(await readJson(request("POST", { "content-type": "application/json; charset=utf-8" }, '{"minutes":0,"rating":null}')), { minutes: 0, rating: null });
});

test("query parsing rejects duplicate scalar values and unknown parameters", () => {
  for (const suffix of ["?page=1&page=2", "?role=admin", "?page=1&sort=raw_sql"]) {
    assert.throws(() => query(new Request(origin + suffix), ["page"]), HttpError);
  }
  assert.deepEqual(query(new Request(origin + "?playerId=1&playerId=2"), ["playerId"], ["playerId"]).getAll("playerId"), ["1", "2"]);
  for (const value of ["0", "-1", "1e2", "1.5", "", "9999999999"]) assert.throws(() => optionalNumber(value), HttpError);
  assert.equal(optionalNumber("50"), 50);
  assert.equal(optionalNumber(null), undefined);
});

test("body keys cannot introduce client roles or prototype fields", () => {
  assert.throws(() => keys({ email: "viewer@example.test", role: "admin" }, ["email", "password"], ["email", "password"]), HttpError);
  assert.throws(() => keys(JSON.parse('{"__proto__":{"admin":true}}'), []), HttpError);
});

test("session-sensitive JSON is never cacheable or content-sniffable", async () => {
  const result = response({ value: null });
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("vary"), "Cookie");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await result.json(), { value: null });
});
