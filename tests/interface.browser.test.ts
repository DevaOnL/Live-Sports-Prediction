import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type { BestStatistic } from "../src/server/scouting/highlights";
import type { ComparisonData } from "../src/lib/contracts";
import { formatNumber } from "../src/lib/presentation";
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
  await noOperationsNavigation(page);
}

async function noOperationsNavigation(page: Page) {
  const navigation = page.getByRole("navigation", { name: /^(Main|Workspace) navigation$/ });
  assert.equal(await navigation.count(), 1);
  assert.equal(await navigation.getByRole("link", { name: "Operations", exact: true }).count(), 0);
  assert.equal(await navigation.locator('a[href^="/admin"]').count(), 0);
}

async function openOperations(page: Page) {
  await page.getByRole("link", { name: "Account settings", exact: true }).click();
  await page.waitForURL(`${web.origin}/account`);
  await noOperationsNavigation(page);
  const operations = page.getByRole("main").getByRole("link", { name: "Operations", exact: true });
  assert.equal(await operations.getAttribute("href"), "/admin");
  await operations.click();
  await page.waitForURL(`${web.origin}/admin`);
  await page.getByRole("heading", { name: "Operations", exact: true }).waitFor();
}

async function noOverflow(page: Page) {
  const bounds = await page.evaluate(() => ({ viewport: window.innerWidth, content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
  assert(bounds.content <= bounds.viewport + 1, `page content ${bounds.content}px exceeds viewport ${bounds.viewport}px at ${new URL(page.url()).pathname}`);
}

async function mastheadFits(page: Page) {
  await noOperationsNavigation(page);
  const bounds = await page.locator(".site-masthead").evaluate((masthead) => ({
    viewport: innerWidth,
    targets: [...masthead.querySelectorAll<HTMLAnchorElement>("a")].map((link) => {
      const box = link.getBoundingClientRect();
      return { name: link.getAttribute("aria-label") ?? link.textContent, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }),
  }));
  for (const [index, target] of bounds.targets.entries()) {
    assert(target.left >= -0.25 && target.right <= bounds.viewport + 0.25, `${target.name} fits the ${bounds.viewport}px masthead`);
    for (const other of bounds.targets.slice(index + 1)) {
      assert(target.right <= other.left || other.right <= target.left || target.bottom <= other.top || other.bottom <= target.top,
        `${target.name} and ${other.name} have separate click targets at ${bounds.viewport}px`);
    }
  }
}

test("browser sign-in redirects protected routes and keeps administrator access server-enforced", { timeout: 60_000 }, async () => withPage(async (page) => {
  await page.goto(web.origin);
  assert.equal(await page.locator("h1").count(), 1);
  await noOperationsNavigation(page);
  assert.deepEqual(await page.locator(".league-summary h3").allTextContents(), ["Premier League", "La Liga"]);
  assert.match(await page.locator(".match-ticker").innerText(), /PREMIER LEAGUE.*LA LIGA/s);
  assert.doesNotMatch(await page.locator(".match-ticker").innerText(), /CHAMPIONSHIP|LIGUE 2/);
  await page.evaluate(() => sessionStorage.setItem("football-comparison", JSON.stringify([
    { id: "8001", name: "Retired comparison selection", position: "GK" },
  ])));
  await page.reload();
  assert.equal(await page.getByRole("complementary", { name: "Comparison selection" }).count(), 0);
  assert.equal(await page.locator('a[href^="/design"]').count(), 0);
  await page.locator('.home-hero img').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".home-hero img")].every((image) => image.complete && image.naturalWidth > 0));
  const homeVisual = await page.evaluate(() => {
    const masthead = document.querySelector(".site-masthead")!;
    const hero = document.querySelector(".home-hero")!;
    return { masthead: getComputedStyle(masthead).backgroundColor, hero: getComputedStyle(hero).backgroundImage,
      images: [...hero.querySelectorAll<HTMLImageElement>("img")].map((image) => new URL(image.currentSrc).origin) };
  });
  assert(homeVisual.images.length > 0 && homeVisual.images.every((origin) => origin === web.origin));
  assert(await page.locator('a[href="/players"]').count() > 0);
  assert(await page.locator('a[href="/compare"]').count() > 0);
  await noOverflow(page);
  await page.locator('a[href="/login"]').first().click();
  await page.waitForURL(`${web.origin}/login`);
  await page.goBack();
  await page.locator(".home-hero").waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".home-hero img")].every((image) => image.complete && image.naturalWidth > 0));
  assert.deepEqual(await page.evaluate(() => ({
    masthead: getComputedStyle(document.querySelector(".site-masthead")!).backgroundColor,
    hero: getComputedStyle(document.querySelector(".home-hero")!).backgroundImage,
    images: [...document.querySelectorAll<HTMLImageElement>(".home-hero img")].map((image) => new URL(image.currentSrc).origin),
  })), homeVisual, "the production homepage keeps its visual styling after browser navigation");
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
  await page.getByRole("link", { name: "Account settings", exact: true }).click();
  await page.waitForURL(`${web.origin}/account`);
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await noOperationsNavigation(page);
  assert.equal(await page.getByRole("main").getByRole("link", { name: "Operations", exact: true }).count(), 0);
  assert.equal(await page.getByRole("main").locator('a[href^="/admin"]').count(), 0);
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
    await page.locator("summary").filter({ hasText: /^Filter players/ }).click();
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
  await page.locator("summary").filter({ hasText: /^Filter players/ }).click();
  await page.getByLabel("Search players", { exact: true }).fill("No matching synthetic player");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await page.getByRole("heading", { name: "Nothing here yet." }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("q"), "No matching synthetic player");
  await page.locator("summary").filter({ hasText: /^Filter players/ }).click();
  await page.getByLabel("Search players", { exact: true }).fill("");
  await page.getByLabel("Competition", { exact: true }).selectOption("153");
  await page.getByLabel("Club", { exact: true }).selectOption("3072");
  await page.getByLabel("Position", { exact: true }).selectOption("GK");
  await page.getByLabel("Model results", { exact: true }).selectOption("ready");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await page.getByRole("heading", { name: names[0], exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: /^Synthetic demo / }).count(), 1);
  assert.equal(new URL(page.url()).searchParams.get("position"), "GK");
  await noOverflow(page);
}));

test("catalogue defaults to ready results and exposes hidden records only through an explicit filter or toggle", { timeout: 60_000 }, async () => withPage(async (page) => {
  await login(page);
  const playersResponse = () => page.waitForResponse((response) => new URL(response.url()).pathname === "/api/players" && response.status() === 200);
  const first = playersResponse();
  await page.goto(`${web.origin}/players`);
  const ready = await first;
  assert.equal(new URL(ready.url()).searchParams.get("availability"), "ready");
  assert((await ready.json()).data.items.every((item: { forecast: { status: string } }) => ["available", "partial"].includes(item.forecast.status)));
  const reveal = page.getByRole("button", { name: "Show hidden", exact: true });
  assert.equal(await reveal.getAttribute("aria-pressed"), "false");
  await page.locator("summary").filter({ hasText: /^Filter players/ }).click();
  const filter = page.getByLabel("Model results", { exact: true });
  assert.equal(await filter.inputValue(), "ready");
  assert.deepEqual(await filter.locator("option").allTextContents(), ["Ready", "Hidden", "All"]);
  await filter.selectOption("hidden");
  const hiddenResponse = playersResponse();
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  const hidden = await hiddenResponse;
  assert.equal(new URL(hidden.url()).searchParams.get("availability"), "hidden");
  assert((await hidden.json()).data.items.every((item: { forecast: { status: string } }) => ["unavailable", "uncomputed"].includes(item.forecast.status)));
  assert.equal(await page.getByRole("button", { name: "Hide hidden", exact: true }).getAttribute("aria-pressed"), "true");
  await page.locator("summary").filter({ hasText: /^Filter players/ }).click();
  await filter.selectOption("all");
  const allResponse = playersResponse();
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  assert.equal(new URL((await allResponse).url()).searchParams.has("availability"), false);
  const reset = playersResponse();
  await page.getByRole("button", { name: "Hide hidden", exact: true }).click();
  assert.equal(new URL((await reset).url()).searchParams.get("availability"), "ready");
  assert.equal(await reveal.getAttribute("aria-pressed"), "false");
  assert.doesNotMatch(await page.getByRole("main").innerText(), /unavailable|uncomputed/i);
}));

test("scouting highlights expose observed strengths on cards and profiles with honest ranks and missing-data states", { timeout: 60_000 }, async () => withPage(async (page) => {
  await login(page);
  // Cohort selection is verified by API integration tests; these response variants
  // exercise display behavior without manufacturing ranked records in the database.
  const statistic = (id: string, cutoffAt: string): BestStatistic => id === "8001" || id === "8002" ? {
    status: "available", metric: id === "8001" ? "saves" : "tackles", total: id === "8001" ? 15 : 10,
    per90: id === "8001" ? 3 : 2, minutes: 450, matches: 5, percentile: id === "8001" ? 85 : 60,
    cohortSize: 20, standout: id === "8001", leagueId: "153", season: "2026/27", position: id === "8001" ? "GK" : "DEF",
    fixtureIds: ["900001", "900002", "900003", "900004", "900005"], cutoffAt,
  } : { status: "unavailable", reason: "missing_statistics" };
  await page.route((url) => url.origin === web.origin && url.pathname === "/api/players", async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const body = await response.json();
    assert.equal(body.data.items.length, 4);
    for (const player of body.data.items) player.bestStatistic = statistic(player.id, body.data.source.cutoffAt);
    await route.fulfill({ response, json: body });
  });
  await page.route((url) => url.origin === web.origin && ["/api/players/8001", "/api/players/8004"].includes(url.pathname), async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const body = await response.json();
    body.data.player.bestStatistic = statistic(body.data.player.id, body.data.source.cutoffAt);
    await route.fulfill({ response, json: body });
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${web.origin}/players?pageSize=4`);
  const elite = page.getByRole("article").filter({ has: page.getByRole("heading", { name: names[0], exact: true }) });
  const ordinary = page.getByRole("article").filter({ has: page.getByRole("heading", { name: names[1], exact: true }) });
  const missing = page.getByRole("article").filter({ has: page.getByRole("heading", { name: names[3], exact: true }) });
  const eliteStatistic = elite.getByRole("region", { name: "Best statistic", exact: true });
  await eliteStatistic.getByText("15", { exact: true }).waitFor();
  await eliteStatistic.getByText("Saves", { exact: true }).waitFor();
  await eliteStatistic.getByText("Last 5 · 3 per 90 min", { exact: true }).waitFor();
  assert.equal(await page.getByText("Top 20%", { exact: true }).count(), 1);
  assert.equal(await ordinary.getByText("Top 20%", { exact: true }).count(), 0);
  await ordinary.getByRole("region", { name: "Best statistic", exact: true }).getByText("10", { exact: true }).waitFor();
  const ordering = await elite.locator(".best-statistic").evaluate((element) =>
    Boolean(element.compareDocumentPosition(element.closest(".player-evaluation")!.querySelector(":scope > details.provenance-details")!) & Node.DOCUMENT_POSITION_FOLLOWING));
  assert(ordering, "the scouting highlight precedes evaluation details on each player card");
  await eliteStatistic.getByText("Statistic details", { exact: true }).click();
  await eliteStatistic.getByText(/20 eligible players in the same position \(goalkeeper\)/).waitFor();
  await eliteStatistic.getByText(/above at least 85%/).waitFor();
  await eliteStatistic.getByText(/As of .*UTC/).waitFor();
  const unavailable = missing.getByRole("region", { name: "Best statistic", exact: true });
  assert.equal(await unavailable.count(), 0, "missing scouting highlights are hidden by default");
  await page.getByRole("button", { name: "Show hidden", exact: true }).click();
  await unavailable.getByText("Not recorded", { exact: true }).waitFor();
  assert.equal(await unavailable.locator(".best-statistic-value").count(), 0, "missing observations cannot render a zero statistic");
  await unavailable.getByText("Recorded details", { exact: true }).click();
  await unavailable.getByText("The relevant statistics are incomplete across the five appearances.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Hide hidden", exact: true }).click();
  assert.equal(await unavailable.count(), 0);
  await noOverflow(page);
  await elite.getByRole("link", { name: "View player", exact: false }).click();
  await page.waitForURL(`${web.origin}/players/8001`);
  await page.getByRole("heading", { name: names[0], exact: true }).waitFor();
  const profileStatistic = page.locator(".profile-hero").getByRole("region", { name: "Best statistic", exact: true });
  await profileStatistic.getByText("15", { exact: true }).waitFor();
  await profileStatistic.getByText("Top 20%", { exact: true }).waitFor();
  await profileStatistic.getByText("Statistic details", { exact: true }).click();
  await profileStatistic.getByText(/450 minutes played/).waitFor();
  await noOverflow(page);
  await page.goto(`${web.origin}/players/8004`);
  await page.getByRole("heading", { name: names[3], exact: true }).waitFor();
  const missingProfileStatistic = page.locator(".profile-hero").getByRole("region", { name: "Best statistic", exact: true });
  assert.equal(await missingProfileStatistic.count(), 0);
  await page.getByRole("button", { name: "Show hidden", exact: true }).click();
  await missingProfileStatistic.getByText("Not recorded", { exact: true }).waitFor();
  assert.equal(await missingProfileStatistic.locator(".best-statistic-value").count(), 0);
  assert.equal(await missingProfileStatistic.getByText("Top 20%", { exact: true }).count(), 0);
  await missingProfileStatistic.getByText("Recorded details", { exact: true }).click();
  await missingProfileStatistic.getByText("The relevant statistics are incomplete across the five appearances.", { exact: true }).waitFor();
  await noOverflow(page);
}));

test("native source identifiers survive login, comparison reloads and correction forms with profile attribution", { timeout: 90_000 }, async () => withPage(async (page) => {
  const playerId = `Player:${randomUUID()}`, fixtureId = `Game:${randomUUID()}`;
  const name = "Synthetic current source player";
  const sourceUrl = "https://sorare.com/football/players/synthetic-current-source-player";
  const playerApiPath = `/api/players/${encodeURIComponent(playerId)}`;
  const profileRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/players/")) profileRequests.push(pathname);
  });
  let profileReads = 0;
  let correctionMetrics: Record<string, number | null> = {};
  // Source-aware reads and writes have database integration coverage. These
  // variants exercise native-ID rendering against the isolated legacy demo.
  await page.route((url) => url.origin === web.origin && decodeURIComponent(url.pathname) === `/api/players/${playerId}`, async (route) => {
    const response = await route.fetch({ url: `${web.origin}/api/players/8001` });
    assert.equal(response.status(), 200);
    profileReads++;
    const body = await response.json();
    const observed = body.data.observedAppearances.find((appearance: { fixtureId: string }) => appearance.fixtureId === "900005");
    assert(observed);
    correctionMetrics = { minutes: observed.minutes, rating: observed.rating, ...observed.metrics };
    body.data.player.id = playerId;
    body.data.player.name = name;
    body.data.player.sourceUrl = sourceUrl;
    body.data.player.forecast.status = "uncomputed";
    body.data.forecast = null;
    body.data.observedAppearances = [{ ...observed, fixtureId }];
    await route.fulfill({ response, json: body });
  });
  const playerPath = `/players/${encodeURIComponent(playerId)}`;
  await page.goto(`${web.origin}/login?next=${encodeURIComponent(playerPath)}`);
  await page.getByLabel("Email address").fill("admin@example.test");
  await page.getByLabel("Password", { exact: true }).fill(web.password);
  const profileRequest = page.waitForRequest((request) => new URL(request.url()).pathname.startsWith("/api/players/"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(web.origin + playerPath);
  assert.equal(new URL((await profileRequest).url()).pathname, playerApiPath,
    "native profile requests encode the source identifier exactly once after sign-in");
  await page.getByRole("heading", { name, exact: true }).waitFor();
  const source = page.getByRole("link", { name: "Player source · Sorare", exact: false });
  assert.equal(await source.getAttribute("href"), sourceUrl);
  assert.equal(await source.getAttribute("rel"), "noopener noreferrer");
  await page.locator(".profile-hero").getByRole("button", { name: `Add ${name} to comparison`, exact: true }).click();
  await page.reload();
  await page.locator(".profile-hero").getByRole("button", { name: `Remove ${name} from comparison`, exact: true }).waitFor();
  assert(profileRequests.every((path) => path === playerApiPath), "native profile reloads retain the exact source identifier");
  await page.evaluate(({ playerId, fixtureId, name }) => sessionStorage.setItem("football-comparison-current", JSON.stringify([
    { id: playerId, name, position: "GK" }, { id: playerId, name, position: "GK" },
    { id: fixtureId, name: "Wrong identifier kind", position: "GK" },
    { id: `${playerId}/extra`, name: "Malformed identifier", position: "GK" },
    { id: "9007199254740993", name: "Unsafe numeric identifier", position: "GK" },
    { id: "8002", name: "Retained legacy selection", position: "DEF" },
  ])), { playerId, fixtureId, name });
  await page.reload();
  const selection = page.getByRole("complementary", { name: "Comparison selection", exact: true });
  await selection.getByText("2 of 4 players selected", { exact: true }).waitFor();
  const comparisonHref = await selection.getByRole("link", { name: "Compare players", exact: false }).getAttribute("href");
  assert.deepEqual(new URL(comparisonHref!, web.origin).searchParams.getAll("playerId"), [playerId, "8002"]);
  assert.equal(await selection.locator(".selection-chip").count(), 2);
  await page.route((url) => url.origin === web.origin && url.pathname === "/api/players", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.items = [{ ...body.data.items[0], id: playerId, name, sourceUrl }];
    body.data.pagination = { ...body.data.pagination, total: 1, page: 1, pages: 1 };
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${web.origin}/players`);
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
  const view = card.getByRole("link", { name: "View player", exact: false });
  await view.waitFor();
  assert.equal(await view.getAttribute("href"), playerPath);
  assert.equal(await card.getByRole("button", { name: `Remove ${name} from comparison`, exact: true }).getAttribute("aria-pressed"), "true");
  await page.setViewportSize({ width: 390, height: 900 });
  await view.click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
  await noOverflow(page);
  await page.goto(`${web.origin}/players/8001`);
  await page.getByRole("heading", { name: names[0], exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Player source · Sorare", exact: false }).count(), 0);
  await openOperations(page);
  assert.notEqual(await page.getByLabel("Player ID", { exact: true }).getAttribute("inputmode"), "numeric");
  assert.notEqual(await page.getByLabel("Fixture ID", { exact: true }).getAttribute("inputmode"), "numeric");
  await page.getByLabel("Player ID", { exact: true }).fill(fixtureId);
  await page.getByLabel("Fixture ID", { exact: true }).fill(fixtureId);
  const readsBeforeInvalid = profileReads;
  await page.getByRole("button", { name: "Load appearance", exact: true }).click();
  await page.getByText("Provide valid player and fixture identifiers.", { exact: true }).waitFor();
  assert.equal(profileReads, readsBeforeInvalid);
  await page.getByLabel("Player ID", { exact: true }).fill(playerId);
  await page.getByLabel("Fixture ID", { exact: true }).fill(playerId);
  await page.getByRole("button", { name: "Load appearance", exact: true }).click();
  await page.getByText("Provide valid player and fixture identifiers.", { exact: true }).waitFor();
  assert.equal(profileReads, readsBeforeInvalid);
  await page.getByLabel("Fixture ID", { exact: true }).fill(fixtureId);
  await page.getByRole("button", { name: "Load appearance", exact: true }).click();
  await page.getByLabel("Expected revision", { exact: true }).waitFor();
  await page.route("**/api/admin/appearances", async (route) => {
    assert.equal(route.request().method(), "PATCH");
    const command = route.request().postDataJSON();
    assert.equal(command.playerId, playerId);
    assert.equal(command.fixtureId, fixtureId);
    assert.deepEqual(command.changes, { goals: 3 });
    await route.fulfill({ status: 200, json: { data: { requestId: command.requestId, playerId, fixtureId, revisionId: randomUUID(),
      previousRevisionId: command.expectedRevisionId, sourceRevisionId: randomUUID(), provider: "manual", providerMaySupersede: true,
      metrics: { ...correctionMetrics, goals: 3 } } } });
  });
  await page.getByLabel("Edit goals", { exact: true }).check();
  await page.getByLabel("Goals", { exact: true }).fill("3");
  await page.getByLabel("Reason", { exact: true }).fill("Synthetic native identifier render regression");
  await page.getByRole("button", { name: "Apply correction", exact: true }).click();
  await page.getByText("Correction saved as a manual revision. The audit trail retains the reason and before/after values.", { exact: true }).waitFor();
  assert.equal((await web.administrator.query("SELECT count(*)::integer AS count FROM sports.provider_requests")).rows[0].count, 0);
}));

test("player detail separates five selected matches, reported observations, units and stale saved targets", { timeout: 60_000 }, async () => withPage(async (page) => {
  await login(page);
  await page.goto(`${web.origin}/players/8001`);
  await page.getByRole("heading", { name: names[0], exact: true }).waitFor();
  const selected = page.getByRole("region", { name: "Selected five-match window", exact: true });
  await selected.getByText("5 of 5 selected", { exact: true }).waitFor();
  assert.equal(await selected.locator("ol > li").count(), 5);
  assert.equal(await selected.getByText("97 min", { exact: true }).count(), 4);
  await page.locator("summary").filter({ hasText: /^Observed appearances$/ }).click();
  const observed = page.getByRole("table", { name: "Recent observed appearances and reported match statistics" });
  assert.equal(await observed.getByRole("row").count(), 8);
  assert.equal(await observed.getByRole("cell", { name: "97", exact: true }).count(), 4);
  await page.getByRole("heading", { name: "Forecast rating", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Adjusted form index", exact: true }).waitFor();
  assert((await page.getByRole("main").innerText()).includes("per 90 minutes"));
  await page.getByText("Target passed", { exact: true }).waitFor();
  await page.locator("summary").filter({ hasText: /^Freshness details$/ }).click();
  await page.getByText("The saved target kickoff has passed. These saved projections need a new evaluation before use for a future match.", { exact: true }).waitFor();
  await page.getByText("Revision and source evidence", { exact: true }).click();
  await page.getByText("Canonical input hash", { exact: true }).waitFor();
  await noOverflow(page);
  await page.goto(`${web.origin}/players/8004`);
  await page.getByRole("heading", { name: names[3], exact: true }).waitFor();
  const goals = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Goals", exact: true }) }).first();
  assert.equal(await goals.count(), 0, "missing goals are omitted by default");
  await page.getByRole("button", { name: "Show hidden", exact: true }).click();
  await goals.getByText("Not recorded", { exact: true }).waitFor();
  assert.equal(await goals.locator(".metric-value").count(), 0, "missing goals cannot become zero");
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
  assert.equal(await page.getByRole("complementary", { name: "Comparison selection", exact: true }).count(), 0, "the redundant tray must not cover comparison values");
  assert.equal(new URL(page.url()).searchParams.get("allowCrossPosition"), "true");
  assert.equal(await page.getByRole("article", { name: /^Evidence for Synthetic demo / }).count(), 2);
  const firstEvidence = page.getByRole("article", { name: `Evidence for ${names[0]}`, exact: true });
  await firstEvidence.locator("summary").filter({ hasText: /^Selected matches & forecast evidence$/ }).click();
  const selected = firstEvidence.getByRole("region", { name: "Selected five-match window", exact: true });
  await selected.getByText("5 of 5 selected", { exact: true }).waitFor();
  assert.equal(await selected.locator("ol > li").count(), 5);
  await firstEvidence.locator("summary").filter({ hasText: /^Comparison and revision evidence$/ }).click();
  await firstEvidence.getByText("Canonical input hash", { exact: true }).waitFor();
  await firstEvidence.getByText("Shared cutoff", { exact: true }).waitFor();
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

test("comparison exposes partial observed ratings without hiding available ratings, zero values or count forecasts", { timeout: 90_000 }, async () => {
  const original = (await web.administrator.query<{ player_id: string; fixture_id: string; rating: string | null }>(`SELECT a.player_id,a.fixture_id,a.rating
    FROM sports.appearances a JOIN sports.players p ON p.id=a.player_id JOIN sports.fixtures f ON f.id=a.fixture_id
    WHERE p.provider_id='8002' AND f.provider_id IN ('900002','900003')`)).rows;
  assert.equal(original.length, 2);
  const schedule = (await web.administrator.query<{ id: string; kickoff_at: string | null }>("SELECT id,kickoff_at::text FROM sports.fixtures WHERE status='scheduled'")).rows;
  assert(schedule.length > 0);
  try {
    // Keep this rating-coverage scenario independent of the seed's calendar dates.
    await web.administrator.query("UPDATE sports.fixtures SET kickoff_at=transaction_timestamp()+interval '30 days' WHERE status='scheduled'");
    await web.administrator.query(`UPDATE sports.appearances a SET rating=CASE WHEN f.provider_id='900002' THEN 0 ELSE NULL END
      FROM sports.players p,sports.fixtures f WHERE p.id=a.player_id AND f.id=a.fixture_id
      AND p.provider_id='8002' AND f.provider_id IN ('900002','900003')`);
    await withPage(async (page) => {
      await login(page);
      const query = "playerId=8002&playerId=8003&allowCrossPosition=true";
      const response = await page.request.get(`${web.origin}/api/compare?${query}`);
      assert.equal(response.status(), 200);
      const data: ComparisonData = (await response.json()).data;
      assert.equal(data.players[0].result.historyStatus, "ready");
      assert.equal(data.players[0].result.forecastRating.status, "unavailable");
      assert.equal(data.players[0].result.adjustedFormIndex.status, "unavailable");
      assert.equal(data.players[0].result.projected90.tackles?.status, "available");
      assert.equal(data.players[1].result.forecastRating.status, "available");
      await page.goto(`${web.origin}/compare?${query}`);
      const table = page.getByRole("table", { name: "Recorded match ratings, aligned player forecasts and adjusted form indexes with explicit units", exact: true });
      await table.waitFor();
      const partial = table.getByRole("group", { name: `Observed match ratings for ${names[1]}`, exact: true });
      await partial.getByText("4 of 5 match ratings", { exact: true }).waitFor();
      assert.equal(await partial.getByRole("listitem").count(), 4);
      assert.equal(await partial.locator(".match-rating-missing").count(), 0);
      assert((await partial.locator(".match-rating").allTextContents()).some((value) => value.includes("0 out of 10")), "an observed zero rating is present, not missing");
      await table.getByRole("group", { name: `Observed match ratings for ${names[2]}`, exact: true }).getByText("5 of 5 match ratings", { exact: true }).waitFor();
      for (const [name, expected] of [["Forecast rating", data.players[1].result.forecastRating.value], ["Adjusted form index", data.players[1].result.adjustedFormIndex.value]] as const) {
        const cells = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: new RegExp(`^${name}`) }) }).getByRole("cell");
        assert.equal((await cells.nth(0).innerText()).trim(), "", "missing comparison values leave an empty cell");
        assert.equal(await cells.nth(1).locator(".comparison-value").innerText(), formatNumber(expected));
      }
      const counts = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: /^Tackles/ }) }).getByRole("cell");
      assert.equal(await counts.nth(0).locator(".comparison-value").innerText(), formatNumber(data.players[0].result.projected90.tackles?.value));
      assert.equal(await page.getByText(/^Rating and form need all five match ratings/).count(), 0);
      await page.getByRole("button", { name: "Show hidden", exact: true }).click();
      assert.equal(await partial.getByRole("listitem").count(), 5);
      assert.equal(await partial.locator(".match-rating-missing").count(), 1);
      assert.match(await partial.locator(".match-rating-missing").innerText(), /3 Aug.*Not recorded/s);
      for (const name of ["Forecast rating", "Adjusted form index"]) {
        const cells = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: new RegExp(`^${name}`) }) }).getByRole("cell");
        assert.equal(await cells.nth(0).locator(".comparison-empty").innerText(), "Not recorded");
      }
      await page.getByText("Rating and form need all five match ratings. Count forecasts use their own recorded statistics.", { exact: true }).waitFor();
      assert.doesNotMatch(await page.getByRole("main").innerText(), /unavailable|uncomputed/i);
      await page.getByRole("button", { name: "Hide hidden", exact: true }).click();
      assert.equal(await partial.getByRole("listitem").count(), 4);
      assert.equal(await page.getByRole("complementary", { name: "Comparison selection", exact: true }).count(), 0);
      for (const width of [390, 768, 1440]) { await page.setViewportSize({ width, height: 900 }); await noOverflow(page); }
      await page.goto(`${web.origin}/players`);
      await page.getByRole("complementary", { name: "Comparison selection", exact: true }).waitFor();
      await page.getByRole("button", { name: `Remove ${names[1]} from comparison`, exact: true }).first().waitFor();
    });
  } finally {
    for (const row of original) await web.administrator.query("UPDATE sports.appearances SET rating=$3 WHERE player_id=$1 AND fixture_id=$2", [row.player_id, row.fixture_id, row.rating]);
    await web.administrator.query(`UPDATE sports.fixtures f SET kickoff_at=v.kickoff_at::timestamptz
      FROM unnest($1::uuid[],$2::text[]) AS v(id,kickoff_at) WHERE f.id=v.id`, [schedule.map((row) => row.id), schedule.map((row) => row.kickoff_at)]);
  }
});

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
    await page.getByRole("status").filter({ hasText: "Loading…" }).first().waitFor();
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
  await page.getByText("No players imported yet. An administrator can request an import.", { exact: true }).waitFor();
  await page.unroute("**/api/overview");
  await page.goto(`${web.origin}/players/999999`);
  await page.getByRole("heading", { name: "This record could not be found.", exact: true }).waitFor();
  assert.doesNotMatch(await page.getByRole("main").innerText(), /unavailable|uncomputed/i);
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
  await openOperations(page);
  await page.getByLabel("Player ID", { exact: true }).fill("8001");
  await page.getByLabel("Fixture ID", { exact: true }).fill("900005");
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
  await page.getByText("Committed batches · Validation issues retain uncertainty", { exact: true }).waitFor();
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
      if (route === "/admin") await openOperations(page);
      else await page.goto(web.origin + route);
      await page.getByRole("heading", { name: heading, exact: true }).waitFor();
      await page.getByRole("status").filter({ hasText: "Loading…" }).first().waitFor({ state: "hidden" });
      if (width === 390) await page.getByRole("link", { name: "Account settings", exact: true }).waitFor();
      await noOverflow(page);
      await mastheadFits(page);
      if (process.env.BROWSER_EVIDENCE_DIR && width !== 768) {
        await mkdir(process.env.BROWSER_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
        const name = route.split("?")[0].replaceAll("/", "-").replace(/^-/, "");
        await page.screenshot({ path: join(process.env.BROWSER_EVIDENCE_DIR, `${name}-${width}.png`), fullPage: true, animations: "disabled" });
      }
    }
  }
  for (const width of [320, 375, 601]) {
    await page.setViewportSize({ width, height: 900 });
    await openOperations(page);
    await mastheadFits(page);
  }
}));
