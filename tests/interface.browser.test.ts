import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { createWebHarness } from "./support/web";

const web = createWebHarness();
let browser: Browser;
const names = ["goalkeepers", "defenders", "midfielders", "forwards"].map((position) => `Synthetic demo ${position}`);

before(async () => {
  await web.start();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
});
after(async () => { await browser?.close(); await web.stop(); });

async function withPage(run: (page: Page) => Promise<void>) {
  await web.resetAuth();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).origin === web.origin ? route.continue() : route.abort());
  try { await run(page); assert.deepEqual(errors, [], "browser journeys must not raise uncaught client errors"); }
  finally { await context.close(); }
}

async function login(page: Page, role: "viewer" | "admin" = "viewer") {
  await page.goto(`${web.origin}/login`);
  await page.getByLabel("Email address").fill(`${role}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${web.origin}/overview`);
  await page.getByRole("heading", { name: "The game, in context." }).waitFor();
}

async function noOverflow(page: Page) {
  const bounds = await page.evaluate(() => ({ viewport: window.innerWidth, content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
  assert(bounds.content <= bounds.viewport + 1, `page content ${bounds.content}px exceeds viewport ${bounds.viewport}px at ${new URL(page.url()).pathname}`);
}

test("browser sign-in redirects protected routes and keeps administrator access server-enforced", { timeout: 60_000 }, async () => withPage(async (page) => {
  await page.goto(`${web.origin}/players/8001`);
  await page.waitForURL(`${web.origin}/login`);
  await page.getByLabel("Email address").fill("viewer@example.test");
  await page.getByLabel("Password", { exact: true }).fill("incorrect-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("We could not sign you in. Check your email and password.", { exact: true }).waitFor();
  await login(page);
  assert.equal(await page.getByRole("link", { name: "Operations", exact: true }).count(), 0);
  await page.goto(`${web.origin}/admin`);
  await page.getByRole("heading", { name: "Administrator access required." }).waitFor();
  const denied = await page.request.post(`${web.origin}/api/admin/imports`, {
    headers: { origin: web.origin, "x-user-role": "admin" }, data: { requestId: randomUUID() },
  });
  assert.equal(denied.status(), 403);
  await page.goto(`${web.origin}/account`);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL(`${web.origin}/login`);
  assert.equal((await page.request.get(`${web.origin}/api/me`)).status(), 401);
}));

test("catalogue filters, empty results and paging use real query-backed player records", { timeout: 60_000 }, async () => withPage(async (page) => {
  await login(page);
  await page.getByRole("region", { name: "Coverage summary" }).waitFor();
  let releaseOptions: () => void = () => undefined;
  const delayedOptions = new Promise<void>((resolve) => { releaseOptions = resolve; });
  const holdOptions = async (route: import("playwright").Route) => { await delayedOptions; await route.continue(); };
  await page.route("**/api/clubs", holdOptions);
  await page.route("**/api/competitions", holdOptions);
  try {
    await page.goto(`${web.origin}/players?leagueId=153&clubId=3072&pageSize=2`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Competition", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Competition", { exact: true }).inputValue(), "153");
    assert.equal(await page.getByLabel("Club", { exact: true }).inputValue(), "3072");
  } finally { releaseOptions(); }
  await page.getByLabel("Competition", { exact: true }).locator('option[value="153"]').filter({ hasText: /^Championship$/ }).waitFor({ state: "attached" });
  await page.getByLabel("Club", { exact: true }).locator('option[value="3072"]').filter({ hasText: "Synthetic demo club 01" }).waitFor({ state: "attached" });
  assert.equal(await page.getByLabel("Competition", { exact: true }).inputValue(), "153");
  assert.equal(await page.getByLabel("Club", { exact: true }).inputValue(), "3072");
  await page.unroute("**/api/clubs", holdOptions);
  await page.unroute("**/api/competitions", holdOptions);
  await page.goto(`${web.origin}/players?pageSize=2&page=99`);
  await page.getByRole("heading", { name: "This page is beyond the current results.", exact: true }).waitFor();
  await page.getByRole("button", { name: "Return to first page", exact: true }).click();
  await page.getByText("Page 1 of 2", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has("page"), false);
  await page.goto(`${web.origin}/players?pageSize=2`);
  await page.getByRole("heading", { name: "Find your next player." }).waitFor();
  await page.getByText("Page 1 of 2", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: /^Synthetic demo / }).count(), 2);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByText("Page 2 of 2", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("page"), "2");
  assert.equal(await page.getByRole("heading", { name: /^Synthetic demo / }).count(), 2);
  await page.getByLabel("Search players", { exact: true }).fill("No matching synthetic player");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await page.getByRole("heading", { name: "Nothing here yet." }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("q"), "No matching synthetic player");
  await page.getByLabel("Search players", { exact: true }).fill("");
  await page.getByLabel("Competition", { exact: true }).selectOption("153");
  await page.getByLabel("Club", { exact: true }).selectOption("3072");
  await page.getByLabel("Position", { exact: true }).selectOption("GK");
  await page.getByLabel("Forecast availability", { exact: true }).selectOption("available");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await page.getByRole("heading", { name: names[0], exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: /^Synthetic demo / }).count(), 1);
  assert.equal(new URL(page.url()).searchParams.get("position"), "GK");
  await noOverflow(page);
}));

test("player detail separates five selected matches, reported observations, units and stale saved targets", { timeout: 60_000 }, async () => withPage(async (page) => {
  await login(page);
  await page.goto(`${web.origin}/players/8001`);
  await page.getByRole("heading", { name: names[0], exact: true }).waitFor();
  const selected = page.getByRole("region", { name: "Selected five-match window", exact: true });
  await selected.getByText("5 of 5 selected", { exact: true }).waitFor();
  assert.equal(await selected.locator("ol > li").count(), 5);
  assert.equal(await selected.getByText("97 min", { exact: true }).count(), 4);
  const observed = page.getByRole("table", { name: "Recent observed appearances and reported match statistics" });
  assert.equal(await observed.getByRole("row").count(), 8);
  assert.equal(await observed.getByRole("cell", { name: "97", exact: true }).count(), 4);
  await page.getByRole("heading", { name: "Forecast rating", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Adjusted form index", exact: true }).waitFor();
  assert((await page.getByRole("main").innerText()).includes("per 90 minutes"));
  await page.getByText("The saved target kickoff has passed. These saved projections need a new evaluation before use for a future match.", { exact: true }).waitFor();
  await page.getByText("Revision and source evidence", { exact: true }).click();
  await page.getByText("Canonical input hash", { exact: true }).waitFor();
  await noOverflow(page);
  await page.goto(`${web.origin}/players/8004`);
  await page.getByRole("heading", { name: names[3], exact: true }).waitFor();
  const goals = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Goals", exact: true }) }).first();
  assert((await goals.innerText()).includes("—"), "missing goals must stay unavailable rather than become zero");
}));

test("comparison preserves two-to-four selections in URLs and requires explicit cross-position opt-in", { timeout: 90_000 }, async () => withPage(async (page) => {
  await login(page);
  await page.goto(`${web.origin}/players?pageSize=4`);
  for (const name of names.slice(0, 2)) await page.getByRole("button", { name: `Add ${name} to comparison`, exact: true }).click();
  await page.getByRole("link", { name: "Compare players", exact: true }).click();
  await page.getByRole("heading", { name: "Check your selection.", exact: true }).waitFor();
  assert.deepEqual(new URL(page.url()).searchParams.getAll("playerId"), ["8001", "8002"]);
  assert.equal(await page.getByLabel("Allow cross-position comparison", { exact: true }).isChecked(), false);
  await page.getByLabel("Allow cross-position comparison", { exact: true }).check();
  await page.getByRole("button", { name: "Compare selected players", exact: true }).click();
  await page.getByRole("region", { name: "Aligned comparison results", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("allowCrossPosition"), "true");
  assert.equal(await page.getByRole("article", { name: /^Evidence for Synthetic demo / }).count(), 2);
  await page.goto(`${web.origin}/players?pageSize=4`);
  for (const name of names.slice(2)) await page.getByRole("button", { name: `Add ${name} to comparison`, exact: true }).click();
  await page.getByRole("link", { name: "Compare players", exact: true }).click();
  await page.getByLabel("Allow cross-position comparison", { exact: true }).check();
  await page.getByRole("button", { name: "Compare selected players", exact: true }).click();
  await page.getByRole("region", { name: "Aligned comparison results", exact: true }).waitFor();
  assert.deepEqual(new URL(page.url()).searchParams.getAll("playerId"), ["8001", "8002", "8003", "8004"]);
  assert.equal(await page.getByRole("article", { name: /^Evidence for Synthetic demo / }).count(), 4);
  await page.reload();
  await page.getByRole("region", { name: "Aligned comparison results", exact: true }).waitFor();
  assert.equal(await page.getByRole("article", { name: /^Evidence for Synthetic demo / }).count(), 4);
  await noOverflow(page);
}));

test("loading, recoverable service errors, missing records and expired sessions remain actionable", { timeout: 60_000 }, async () => withPage(async (page) => {
  await login(page);
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/overview", async (route) => {
    await waiting;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "Synthetic unavailable response" } }) });
  });
  try {
    await page.goto(`${web.origin}/overview`, { waitUntil: "domcontentloaded" });
    await page.getByRole("status").filter({ hasText: "Loading the latest saved evidence…" }).first().waitFor();
  } finally { release(); }
  await page.getByRole("heading", { name: "We could not load this view.", exact: true }).waitFor();
  await page.unroute("**/api/overview");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("region", { name: "Coverage summary", exact: true }).waitFor();
  await page.route("**/api/overview", async (route) => {
    const response = await route.fetch();
    const empty = await response.json();
    empty.data.counts.players = 0;
    empty.data.counts.forecasts = { available: 0, partial: 0, unavailable: 0, uncomputed: 0 };
    await route.fulfill({ response, json: empty });
  });
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await page.getByText("No players have been imported yet. An administrator can request an import; forecasts need covered match history before they can be evaluated.", { exact: true }).waitFor();
  await page.unroute("**/api/overview");
  await page.goto(`${web.origin}/players/999999`);
  await page.getByRole("heading", { name: "This record is unavailable.", exact: true }).waitFor();
  await page.goto(`${web.origin}/overview`);
  await page.getByRole("region", { name: "Coverage summary", exact: true }).waitFor();
  await web.administrator.query('UPDATE auth.session SET "createdAt"=clock_timestamp()-interval \'2 hours\',"expiresAt"=clock_timestamp()-interval \'1 hour\' WHERE "userId"=$1', [web.viewerId]);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await page.getByRole("heading", { name: "Your session has ended.", exact: true }).first().waitFor();
  await page.getByRole("link", { name: "Sign in again", exact: true }).first().click();
  await page.waitForURL(`${web.origin}/login`);
}));

test("administrator queue retries preserve request identity, correction conflicts reload, and audit records are visible", { timeout: 90_000 }, async () => withPage(async (page) => {
  await login(page, "admin");
  await page.goto(`${web.origin}/admin?playerId=8001&fixtureId=900005`);
  await page.getByRole("heading", { name: "Operations", exact: true }).waitFor();
  let requestId = "";
  let eventId = "";
  const loseResponse = async (route: import("playwright").Route) => {
    if (route.request().method() !== "POST") return route.continue();
    requestId = route.request().postDataJSON().requestId;
    const result = await route.fetch();
    assert.equal(result.status(), 202);
    eventId = (await result.json()).data.eventId;
    await route.abort("failed");
  };
  await page.route("**/api/admin/imports", loseResponse);
  await page.getByRole("button", { name: "Queue source import", exact: true }).click();
  await page.getByRole("button", { name: "Retry same import request", exact: true }).waitFor();
  await page.unroute("**/api/admin/imports", loseResponse);
  await page.getByRole("button", { name: "Retry same import request", exact: true }).click();
  await page.getByText("Accepted for processing. This confirms queue acceptance; it does not confirm completion.", { exact: true }).waitFor();
  assert.match(requestId, /^[0-9a-f-]{36}$/i);
  assert.equal((await web.administrator.query("SELECT count(*)::integer AS count FROM sports.outbox WHERE event_type='source.sync'")).rows[0].count, 1);
  assert.equal((await web.administrator.query("SELECT count(*)::integer AS count FROM sports.audit_log WHERE id=$1", [requestId])).rows[0].count, 1);
  const jobId = randomUUID();
  await web.administrator.query(`INSERT INTO sports.jobs(id,outbox_id,kind,deduplication_key,payload,status,attempts,max_attempts,last_error,completed_at)
    VALUES ($1,$2,'source.sync',$3,'{}','failed',1,5,'processing_failed',clock_timestamp())`, [jobId, eventId, `synthetic-browser:${jobId}`]);
  await page.getByRole("button", { name: "Refresh operational views", exact: true }).click();
  const retried = page.waitForResponse((response) => response.url() === `${web.origin}/api/admin/jobs/${jobId}/retry` && response.request().method() === "POST");
  await page.getByRole("button", { name: `Retry job ${jobId}`, exact: true }).click();
  assert.equal((await retried).status(), 202);
  await page.getByRole("row").filter({ hasText: jobId }).getByText("Ready", { exact: true }).waitFor();
  assert.equal((await web.administrator.query("SELECT status FROM sports.jobs WHERE id=$1", [jobId])).rows[0].status, "ready");
  await page.getByRole("button", { name: "Load appearance", exact: true }).click();
  const revision = page.getByLabel("Expected revision", { exact: true });
  await revision.waitFor();
  const staleRevision = await revision.inputValue();
  const concurrent = await page.request.patch(`${web.origin}/api/admin/appearances`, { headers: { origin: web.origin }, data: {
    requestId: randomUUID(), playerId: "8001", fixtureId: "900005", expectedRevisionId: staleRevision,
    reason: "Synthetic concurrent browser correction", changes: { rating: 8.1 },
  } });
  assert.equal(concurrent.status(), 200);
  await page.getByLabel("Edit rating", { exact: true }).check();
  await page.getByLabel("Rating", { exact: true }).fill("8.2");
  await page.getByLabel("Reason", { exact: true }).fill("Synthetic browser correction after revision reload");
  await page.getByRole("button", { name: "Apply correction", exact: true }).click();
  await page.getByText("Another revision may now be current. Reload appearance before applying a new correction.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Apply correction", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Reload appearance", exact: true }).click();
  await revision.waitFor();
  assert.notEqual(await revision.inputValue(), staleRevision);
  await page.getByLabel("Edit rating", { exact: true }).check();
  await page.getByLabel("Rating", { exact: true }).fill("8.2");
  await page.getByLabel("Reason", { exact: true }).fill("Synthetic browser correction after revision reload");
  await page.getByRole("button", { name: "Apply correction", exact: true }).click();
  await page.getByText("Correction saved as a manual revision. The audit trail retains the reason and before/after values.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Committed imports", exact: true }).click();
  await page.getByText("These batches committed to canonical storage. Validation issues describe retained uncertainty; queue acceptance alone does not create an entry here.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Audit trail", exact: true }).click();
  await page.getByRole("table", { name: /^Committed audit trail/ }).waitFor();
  await page.getByText("View audit evidence", { exact: true }).first().click();
  await page.getByText("Reason: Synthetic browser correction after revision reload", { exact: true }).waitFor();
  assert.equal((await web.administrator.query("SELECT count(*)::integer AS count FROM sports.provider_requests")).rows[0].count, 0);
}));

test("main viewer and administrator journeys fit 390, 768 and 1440 pixel viewports", { timeout: 90_000 }, async () => withPage(async (page) => {
  await login(page, "admin");
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [route, heading] of [["/overview", "The game, in context."], ["/players?pageSize=2", "Find your next player."], ["/players/8001", names[0]], ["/compare?playerId=8001&playerId=8002&allowCrossPosition=true", "Compare the evidence."], ["/admin", "Operations"]]) {
      await page.goto(web.origin + route);
      await page.getByRole("heading", { name: heading, exact: true }).waitFor();
      await page.getByRole("status").filter({ hasText: "Loading the latest saved evidence…" }).first().waitFor({ state: "hidden" });
      if (width === 390) await page.getByRole("link", { name: "Account settings", exact: true }).waitFor();
      await noOverflow(page);
      if (process.env.BROWSER_EVIDENCE_DIR && width !== 768) {
        await mkdir(process.env.BROWSER_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
        const name = route.split("?")[0].replaceAll("/", "-").replace(/^-/, "");
        await page.screenshot({ path: join(process.env.BROWSER_EVIDENCE_DIR, `${name}-${width}.png`), fullPage: true, animations: "disabled" });
      }
    }
  }
}));
