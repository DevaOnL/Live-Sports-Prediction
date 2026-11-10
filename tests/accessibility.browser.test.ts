import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { JobQueue } from "../src/server/ingestion/jobs";
import { createWebHarness } from "./support/web";

const web = createWebHarness();
const widths = [390, 768, 1440];
let browser: Browser;

before(async () => {
  await web.start();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
});
after(async () => { await browser?.close(); await web.stop(); });

async function journey(width: number, run: (page: Page) => Promise<void>) {
  await web.resetAuth();
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).origin === web.origin ? route.continue() : route.abort());
  try { await run(page); assert.deepEqual(errors, [], "accessible journeys must not raise uncaught browser errors"); }
  finally { await context.close(); }
}

function contrast(first: number[], second: number[]) {
  const luminance = (rgb: number[]) => rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  const a = luminance(first); const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function focusControl(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await control.focus();
  const focus = await control.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const offset = parseFloat(style.outlineOffset);
    const width = parseFloat(style.outlineWidth);
    const distance = offset + width / 2;
    // A solid outer shadow can supply the actual background underneath the ring,
    // including where the wordmark extends beyond its black header.
    const shadow = style.boxShadow.match(/^(rgba?\([^)]+\)) 0px 0px 0px ([\d.]+)px$/);
    const samples = shadow && Number(shadow[2]) >= offset + width ? [shadow[1]] : [
      [box.left - distance, box.top + box.height / 2], [box.right + distance, box.top + box.height / 2],
      [box.left + box.width / 2, box.top - distance], [box.left + box.width / 2, box.bottom + distance],
    ].filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight).map(([x, y]) => {
      for (const underneath of document.elementsFromPoint(x, y)) {
        const color = getComputedStyle(underneath).backgroundColor;
        if (color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
      }
      return "rgb(255, 255, 255)";
    });
    return { visible: element.matches(":focus-visible"), active: document.activeElement === element,
      name: element.getAttribute("aria-label") ?? element.textContent ?? element.tagName,
      outline: style.outlineStyle, width, color: style.outlineColor, backgrounds: samples };
  });
  assert(focus.active && focus.visible && focus.outline !== "none" && focus.width >= 2, `${focus.name} has visible keyboard focus`);
  assert(focus.backgrounds.length > 0, `${focus.name} has an on-screen focus indicator`);
  const foreground = focus.color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  for (const background of focus.backgrounds) {
    const ratio = contrast(foreground, background.match(/[\d.]+/g)!.slice(0, 3).map(Number));
    assert(ratio >= 3, `${focus.name} focus contrast is ${ratio.toFixed(2)}:1 against ${background}`);
  }
}

async function activate(control: Locator, page: Page) {
  await focusControl(control);
  await page.keyboard.press("Enter");
}

async function disclose(summary: Locator, page: Page) {
  assert.equal(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open), false);
  await activate(summary, page);
  assert.equal(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open), true,
    "native disclosures open through the keyboard");
}

async function semantics(page: Page) {
  const result = await page.evaluate(() => {
    const targets = [...document.querySelectorAll<HTMLElement>("a[href],button,input:not([type=hidden]),select,textarea,summary")]
      .filter((element) => element.checkVisibility() && !(element as HTMLButtonElement).disabled && !element.classList.contains("skip-link"));
    return { headings: document.querySelectorAll("h1").length, main: document.querySelectorAll("main").length,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1,
      unnamed: targets.filter((element) => !(element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") ||
        (element as HTMLInputElement).labels?.length || element.textContent?.trim())).map((element) => element.outerHTML),
      small: targets.flatMap((element) => {
        const input = element as HTMLInputElement;
        const target = ["checkbox", "radio"].includes(input.type) && input.labels?.[0] ? input.labels[0] : element;
        const box = target.getBoundingClientRect();
        return box.width < 43.5 || box.height < 43.5 ? [{ name: element.getAttribute("aria-label") ?? element.textContent, width: box.width, height: box.height }] : [];
      }),
      tables: [...document.querySelectorAll("table")].filter((table) => table.checkVisibility())
        .map((table) => ({ caption: table.caption?.textContent?.trim(), missingScopes: table.querySelectorAll("th:not([scope])").length })),
    };
  });
  assert.equal(result.headings, 1, "each page has one primary heading");
  assert.equal(result.main, 1, "each page exposes one main landmark");
  assert.equal(result.overflow, false, "expanded content stays within the page; wide tables scroll locally");
  assert.deepEqual(result.unnamed, [], "visible controls have accessible names");
  assert.deepEqual(result.small, [], "visible enabled targets provide at least 44 pixels in each dimension");
  for (const table of result.tables) {
    assert(table.caption, "data tables have descriptive captions");
    assert.equal(table.missingScopes, 0, "table headers identify their row or column scope");
  }
}

async function keyboardLogin(page: Page, role: "viewer" | "admin", invalidFirst = false) {
  await page.goto(`${web.origin}/login`);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").textContent(), "Skip to content");
  await activate(page.getByRole("link", { name: "Skip to content", exact: true }), page);
  assert.equal(await page.locator(":focus").getAttribute("id"), "main");
  await focusControl(page.getByLabel("Email address"));
  await page.keyboard.insertText(`${role}@example.test`);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").getAttribute("name"), "password");
  await page.keyboard.insertText(invalidFirst ? "incorrect-password" : web.password);
  await page.keyboard.press("Tab");
  await activate(page.getByRole("button", { name: "Sign in", exact: true }), page);
  if (invalidFirst) {
    const error = page.getByRole("status").filter({ hasText: "We could not sign you in. Check your email and password." });
    await error.waitFor();
    assert.equal(await error.getAttribute("aria-live"), "polite");
    for (const field of ["Email address", "Password"]) {
      assert((await page.getByLabel(field, { exact: true }).getAttribute("aria-describedby"))?.split(/\s+/).includes(await error.getAttribute("id") ?? ""),
        "sign-in failures are associated with both credential fields");
    }
    await focusControl(page.getByLabel("Password", { exact: true }));
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(web.password);
    await page.keyboard.press("Tab");
    await activate(page.getByRole("button", { name: "Sign in", exact: true }), page);
  }
  await page.waitForURL(`${web.origin}/overview`);
  await page.getByRole("region", { name: "Coverage summary", exact: true }).waitFor();
}

test("keyboard readers can sign in, filter and inspect expanded football evidence at all supported widths", { timeout: 120_000 }, async () => {
  for (const width of widths) await journey(width, async (page) => {
    await page.goto(web.origin);
    await page.keyboard.press("Tab");
    await focusControl(page.getByRole("link", { name: "Live Sports Prediction home", exact: true }));
    await focusControl(page.getByRole("link", { name: "Photo credits", exact: false }));
    await semantics(page);
    await keyboardLogin(page, "viewer", true);
    const navigation = page.getByRole("navigation", { name: "Workspace navigation", exact: true });
    assert.equal(await navigation.getByRole("link", { name: "Operations", exact: true }).count(), 0);
    assert.equal(await navigation.getByRole("link", { name: "Overview", exact: true }).getAttribute("aria-current"), "page");
    await focusControl(page.getByRole("link", { name: "Live Sports Prediction home", exact: true }));
    await activate(navigation.getByRole("link", { name: "Players", exact: true }), page);
    await page.getByRole("heading", { name: "Find your next player.", exact: true }).waitFor();
    await disclose(page.locator("summary").filter({ hasText: /^Filter players/ }), page);
    await focusControl(page.getByLabel("Search players", { exact: true }));
    await page.keyboard.insertText("Synthetic demo goalkeepers");
    await focusControl(page.getByLabel("Position", { exact: true }));
    await page.keyboard.press("Home"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    assert.equal(await page.getByLabel("Position", { exact: true }).inputValue(), "GK");
    await semantics(page);
    await activate(page.getByRole("button", { name: "Apply filters", exact: true }), page);
    await page.waitForURL((url) => url.searchParams.get("position") === "GK" && url.searchParams.get("q") === "Synthetic demo goalkeepers");
    const player = page.getByRole("heading", { name: "Synthetic demo goalkeepers", exact: true });
    await player.waitFor();
    assert.equal(new URL(page.url()).searchParams.get("position"), "GK");
    await activate(player.getByRole("link"), page);
    const selected = page.getByRole("region", { name: "Selected five-match window", exact: true });
    await selected.getByText("5 of 5 selected", { exact: true }).waitFor();
    assert.equal(await selected.locator("ol > li").count(), 5);
    await disclose(selected.locator("summary").filter({ hasText: /^Match context and weighting$/ }).first(), page);
    await disclose(page.locator("summary").filter({ hasText: /^Observed appearances$/ }), page);
    assert.equal(await page.getByRole("table", { name: "Recent observed appearances and reported match statistics" }).getByRole("row").count(), 8);
    await disclose(page.locator("summary").filter({ hasText: /^Revision and source evidence$/ }), page);
    await page.getByText("Canonical input hash", { exact: true }).waitFor();
    await semantics(page);
    await page.goto(`${web.origin}/compare?playerId=8001&playerId=8002&allowCrossPosition=true`);
    await page.getByRole("region", { name: "Aligned comparison results", exact: true }).waitFor();
    for (const name of ["Synthetic demo goalkeepers", "Synthetic demo defenders"]) {
      const evidence = page.getByRole("article", { name: `Evidence for ${name}`, exact: true });
      await disclose(evidence.locator("summary").filter({ hasText: /^Selected matches & forecast evidence$/ }), page);
      assert.equal(await evidence.getByRole("region", { name: "Selected five-match window", exact: true }).locator("ol > li").count(), 5);
      await disclose(evidence.locator("summary").filter({ hasText: /^Comparison and revision evidence$/ }), page);
      await evidence.getByText("Shared cutoff", { exact: true }).waitFor();
    }
    await semantics(page);
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/overview", async (route) => {
      await pending;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "Synthetic unavailable response" } }) });
    });
    try {
      await page.goto(`${web.origin}/overview`, { waitUntil: "domcontentloaded" });
      const loading = page.getByRole("status").filter({ hasText: /^Loading…$/ }).first();
      await loading.waitFor(); assert.equal(await loading.getAttribute("aria-live"), "polite");
    } finally { release(); }
    const failure = page.locator('.state-panel[role="alert"]');
    await failure.getByRole("heading", { name: "We could not load this view.", exact: true }).waitFor();
    assert((await failure.textContent())?.includes("temporarily unavailable"));
    await page.unroute("**/api/overview");
    await activate(failure.getByRole("button", { name: "Try again", exact: true }), page);
    await page.getByRole("region", { name: "Coverage summary", exact: true }).waitFor();
    assert.equal(await failure.count(), 0);
    await semantics(page);
  });
});

test("keyboard administrators can expand operational tables, source gaps and audit evidence without overflow", { timeout: 120_000 }, async () => {
  for (const width of widths) await journey(width, async (page) => {
    await keyboardLogin(page, "admin");
    await activate(page.getByRole("navigation", { name: "Workspace navigation", exact: true }).getByRole("link", { name: "Operations", exact: true }), page);
    await page.getByRole("heading", { name: "Operations", exact: true }).waitFor();
    await disclose(page.locator("summary").filter({ hasText: /^Coverage details$/ }), page);
    await page.getByRole("table", { name: "Approved coverage in canonical storage", exact: true }).waitFor();
    await disclose(page.locator("summary").filter({ hasText: /^Fixture statistics$/ }), page);
    await page.getByLabel("Statistics competition").waitFor();
    await activate(page.getByRole("button", { name: "Queue forecast refresh", exact: true }), page);
    const accepted = page.getByRole("status").filter({ hasText: "Accepted for processing." });
    await accepted.waitFor(); assert.equal(await accepted.getAttribute("aria-live"), "polite");
    await new JobQueue(web.writer, "accessibility-browser", true).dispatch(500);
    const jobId = (await web.administrator.query("SELECT id FROM sports.jobs WHERE kind='forecast.refresh' ORDER BY created_at LIMIT 1")).rows[0].id as string;
    // Simulate a failed local job; no worker or provider request runs here.
    await web.writer.query(`UPDATE sports.jobs SET status='failed',attempts=1,
      last_error='processing_failed',completed_at=clock_timestamp() WHERE id=$1`, [jobId]);
    await activate(page.getByRole("button", { name: "Refresh operational views", exact: true }), page);
    const retry = page.getByRole("button", { name: `Retry job ${jobId}`, exact: true });
    await retry.waitFor(); await activate(retry, page);
    const retried = page.getByRole("status").filter({ hasText: "Retry queued. Check job status for completion." });
    await retried.waitFor(); assert.equal(await retried.getAttribute("aria-live"), "polite");
    const jobs = page.getByRole("table", { name: /^Worker queue/ });
    await jobs.getByRole("row").filter({ hasText: jobId }).getByText("Ready", { exact: true }).waitFor();
    assert.equal(await retried.isVisible(), true, "retry feedback survives the job-list refresh");
    await jobs.locator("summary").filter({ hasText: /^Job details$/ }).first().waitFor();
    await disclose(jobs.locator("summary").filter({ hasText: /^Job details$/ }).first(), page);
    await jobs.getByText(/^Job ID /).first().waitFor();
    await semantics(page);
    await activate(page.getByRole("button", { name: "Committed imports", exact: true }), page);
    await disclose(page.locator("summary").filter({ hasText: /^Inspect validation issues$/ }).first(), page);
    assert(await page.locator("details[open] .compact-list li").count() > 0);
    await semantics(page);
    await activate(page.getByRole("button", { name: "Audit trail", exact: true }), page);
    const audit = page.getByRole("table", { name: /^Committed audit trail/ });
    await disclose(audit.locator("summary").filter({ hasText: /^Record details$/ }).first(), page);
    await audit.getByText(/^Audit ID /).first().waitFor();
    await disclose(audit.locator("summary").filter({ hasText: /^View audit evidence$/ }).first(), page);
    await audit.getByRole("heading", { name: "After", exact: true }).first().waitFor();
    await semantics(page);
    assert.equal((await web.administrator.query("SELECT count(*)::integer AS count FROM sports.provider_requests")).rows[0].count, 0);
  });
});
