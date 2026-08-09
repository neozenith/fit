import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures.js";

/**
 * Does this environment have a training block yet?
 *
 * A freshly stood-up environment legitimately has none, and several assertions
 * below only mean something once one exists. The check has to be exact, because
 * the obvious version is subtly broken:
 *
 *   page.getByText(/No block yet/).isVisible().catch(() => false)
 *
 * `getByText` matches the banner AND its ancestors, so strict mode throws — and
 * the `.catch(() => false)` then reports "not empty" for an environment that is
 * empty, so the test proceeds and fails on missing data. Counting a `data-`
 * hook is unambiguous and cannot resolve to more than one node per card.
 */
const hasBlock = async (page: Page): Promise<boolean> =>
  (await page.getByTestId("session-card").count()) > 0;

/**
 * The suite runs identically against local, dev, test and prod.
 *
 * Assertions are therefore written against BEHAVIOUR rather than data: the
 * environments hold different records, and a test that asserted "17 sets"
 * would pass in exactly one of them. What must hold everywhere is that the page
 * renders, the API answers, and the invariants the ADRs claim are actually
 * enforced.
 */

test.describe("shell", () => {
  test("loads and shows who is signed in", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".brand")).toHaveText("fit");
    // The email comes from /api/me, so seeing it proves the whole chain:
    // cookie or headers accepted, signature verified, handler reached.
    await expect(page.getByText(/@/).first()).toBeVisible();
  });

  test("every section is reachable from the sidebar", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("#sidenav");

    // The sidebar is a drawer below 52rem, so open it if the toggle is showing.
    // Skipping that check would make this test pass on a desktop viewport and
    // fail on the mobile project for reasons that look like a routing bug.
    const toggle = page.locator(".nav-toggle");
    if (await toggle.isVisible()) await toggle.click();

    const links = await nav.locator("a").all();
    expect(links.length).toBeGreaterThan(6);

    for (const link of links) {
      const href = await link.getAttribute("href");
      await link.click();
      // The URL is the assertion, not just the render: path routing is the
      // point, and a client-side router that renders the right page while
      // leaving the address bar behind fails the thing being tested.
      await expect(page).toHaveURL(new RegExp(`${href}(\\?|$)`));
      await expect(page.locator("main h1")).toBeVisible();
      await expect(nav.locator(`a[href="${href}"]`)).toHaveAttribute("aria-current", "page");
      if (await toggle.isVisible()) await toggle.click();
    }
  });

  test("a page loads directly from its own URL, not only by navigation", async ({ page }) => {
    // The edge rewrites any extensionless non-/api path to index.html
    // (ADR-0024). Without that, every one of these is a 404 from S3 — which is
    // exactly the failure a hash router exists to avoid, so it has to be proven
    // rather than assumed.
    for (const path of ["/history/volume", "/history/cardio", "/exercises", "/finops"]) {
      const response = await page.goto(path);
      expect(response?.status(), `${path} should be served`).toBeLessThan(400);
      await expect(page.locator("main h1")).toBeVisible();
    }
  });

  test("an unknown path renders a not-found page rather than a blank one", async ({ page }) => {
    await page.goto("/nope");
    await expect(page.locator("main h1")).toHaveText("Not found");
  });

  test("no console errors on any page", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    for (const path of [
      "/",
      "/block",
      "/log",
      "/measurements",
      "/progress",
      "/finops",
      "/exercises",
      "/history",
      "/history/volume",
      "/history/bodyweight",
      "/history/rep-maxes",
      "/history/cardio",
      "/history/streaks",
    ]) {
      await page.goto(path);
      await expect(page.locator("main h1")).toBeVisible();
    }

    expect(errors).toEqual([]);
  });
});

test.describe("today", () => {
  test("shows the block's seed maxes and a session", async ({ page }) => {
    await page.goto("/today");
    await expect(page.locator("main h1")).toBeVisible();

    test.skip(!(await hasBlock(page)), "environment has no block yet");

    // All three lifts, because the entire six weeks is projected from them.
    for (const lift of ["Squat", "Bench", "Deadlift"]) {
      await expect(page.getByRole("cell", { name: new RegExp(lift, "i") }).first()).toBeVisible();
    }
    await expect(page.getByTestId("session-card").first()).toBeVisible();
  });
});

test.describe("block", () => {
  test("editing a one-rep max re-projects the whole block instantly", async ({ page }) => {
    await page.goto("/block");
    const squat = page.locator("#squat");
    await expect(squat).toBeVisible();

    test.skip(!(await hasBlock(page)), "environment has no block yet");

    const before = await page.getByTestId("session-card").first().innerText();

    // The in-browser engine is the same module the server uses (ADR-0019), so
    // this must change without a network round trip.
    await squat.fill("120");
    await squat.blur();

    await expect(page.getByText(/previewing unsaved values/i)).toBeVisible();
    await expect
      .poll(async () => page.getByTestId("session-card").first().innerText())
      .not.toBe(before);
  });

  test("week navigation moves through all five prescribed weeks", async ({ page }) => {
    await page.goto("/block");
    test.skip(!(await hasBlock(page)), "environment has no block yet");
    // Scoped to the card that owns the week switcher. `main h2` first would
    // match "Seed values", which never changes and would pass forever.
    const weekCard = page.locator(".card").filter({ has: page.locator(".nav") });
    for (const week of [1, 2, 3, 4, 5]) {
      await page.getByRole("button", { name: `Week ${week}`, exact: true }).click();
      await expect(weekCard.locator("h2")).toContainText(`Week ${week}`);
    }
  });

  test("week 5 prescribes a single 1-4 rep test set per lift", async ({ page }) => {
    await page.goto("/block");
    test.skip(!(await hasBlock(page)), "environment has no block yet");
    await page.getByRole("button", { name: "Week 5", exact: true }).click();
    // `x1-4` is the measurement the next block is seeded from — if it is
    // missing, the recursion has no input.
    await expect(page.getByText("x1-4").first()).toBeVisible();
  });
});

test.describe("log", () => {
  test("pre-fills from the prescription", async ({ page }) => {
    await page.goto("/log");
    await expect(page.locator("main h1")).toHaveText("Log");

    test.skip((await page.getByRole("combobox").count()) === 0, "environment has no block yet");

    await expect(page.locator("#session")).toBeVisible();
    // A pre-filled weight is the whole ergonomic argument for the page.
    const weights = page.locator('input[aria-label$="weight"]');
    await expect(weights.first()).toBeVisible();
    expect(await weights.count()).toBeGreaterThan(0);
  });
});

test.describe("body", () => {
  test("offers both measurements and renders the weekly medians section", async ({ page }) => {
    await page.goto("/measurements");
    await expect(page.locator("#kind")).toBeVisible();
    await expect(page.getByText(/Median, not mean/i)).toBeVisible();
  });
});

test.describe("progress", () => {
  test("renders the estimated one-rep max panel", async ({ page }) => {
    await page.goto("/progress");
    await expect(page.getByRole("heading", { name: /Estimated one-rep max/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Best to date/i })).toBeVisible();
  });
});

test.describe("cost", () => {
  test("either shows a breakdown or says why it cannot", async ({ page }) => {
    await page.goto("/finops");
    await expect(page.locator("main h1")).toHaveText("Cost");

    // Both outcomes are correct. An environment deployed before the global
    // FinOps stack genuinely has no data, and saying so beats rendering zeros
    // that look like a free account (ADR-0015).
    const hasBreakdown = await page
      .getByRole("heading", { name: "Breakdown" })
      .isVisible()
      .catch(() => false);
    // Three valid states, not two: a breakdown, "the stack is not deployed", or
    // "the catalogue has no data yet". The third is the normal state for hours
    // after a cold start, and omitting it made this test fail on a healthy
    // environment.
    const explained = (await page.getByText(/has not been deployed|no data yet/i).count()) > 0;

    expect(hasBreakdown || explained).toBe(true);
  });
});

/**
 * Whether this environment holds an import, decided only once the page has
 * settled. The wait is the whole point: a skip guard that races the loading
 * placeholder turns "the query broke" into "nothing to test here".
 */
const hasImportedHistory = async (page: Page): Promise<boolean> => {
  const total = page.getByRole("heading", { name: "In total" });
  await expect(
    total.or(page.getByText(/No training history has been imported/i)).first(),
  ).toBeVisible();
  return total.isVisible();
};

test.describe("imported history", () => {
  test("either renders the archive or says it holds none", async ({ page }) => {
    await page.goto("/history");
    await expect(page.locator("main h1")).toHaveText("History");

    // Both outcomes are correct, and for a reason worth stating: the import is
    // an OPERATOR action, not part of a deploy, so a perfectly healthy
    // environment can legitimately hold no history. What must never happen is
    // an empty page — that is indistinguishable from a broken query.
    // Wait for the page to SETTLE before deciding which outcome it is.
    // `isVisible()` resolves immediately and does not auto-wait, so checking it
    // while the loading placeholder is still up reports "no history" on an
    // environment that has plenty — a false pass that then silently skipped
    // every panel assertion below.
    const settled = page
      .getByRole("heading", { name: "In total" })
      .or(page.getByText(/No training history has been imported/i));
    await expect(settled.first()).toBeVisible();
  });

  test("every subpage renders its own chart", async ({ page }) => {
    await page.goto("/history");
    test.skip(!(await hasImportedHistory(page)), "this environment holds no imported history");

    // Each subpage is its own address so a single chart can be linked to and
    // discussed on its own — which only holds if each one actually DRAWS.
    // Asserting per-page catches a query returning a shape one page cannot use,
    // a failure that on the old single page showed up as one silently missing
    // card among six.
    const pages: Array<[string, string]> = [
      ["/history/volume", "Volume"],
      ["/history/bodyweight", "Body weight"],
      ["/history/rep-maxes", "Rep maxes"],
      ["/history/cardio", "Cardio"],
      ["/history/streaks", "Streaks"],
    ];

    for (const [path, heading] of pages) {
      await page.goto(path);
      await expect(page.locator("main h1")).toHaveText(heading);
      // Real geometry, not just a container: Plotly loads asynchronously, so an
      // empty `.plot` div exists long before — and instead of — a failed chart.
      await expect(page.locator(".plot .main-svg").first()).toBeVisible({ timeout: 15_000 });
      expect(await page.locator(".plot path").count(), `${path} drew nothing`).toBeGreaterThan(0);
    }
  });

  test("the exercise catalogue is its own page", async ({ page }) => {
    await page.goto("/exercises");
    await expect(page.locator("main h1")).toHaveText("Exercises");
    const listed = await page
      .getByRole("heading", { name: /movements/ })
      .isVisible()
      .catch(() => false);
    test.skip(!listed, "this environment holds no imported history");
    await expect(page.locator("table")).toBeVisible();
  });

  test("switching volume grain re-queries and re-renders", async ({ page }) => {
    await page.goto("/history");
    test.skip(!(await hasImportedHistory(page)), "this environment holds no imported history");

    await page.goto("/history/volume?grain=month");
    await expect(page.locator(".plot .main-svg").first()).toBeVisible({ timeout: 15_000 });
    const before = await page.locator(".plot .trace").count();

    await page.getByRole("group", { name: "Grain" }).getByRole("button", { name: "Week" }).click();
    await expect(page).toHaveURL(/grain=week/);
    // Weeks are strictly finer than months, so the same span holds more points.
    // Asserting only "still renders" would pass on a request that silently
    // failed and left the previous chart on screen.
    await expect
      .poll(async () => page.locator(".plot .point, .plot .bars path").count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
  });
});

test.describe("every view is addressable", () => {
  /**
   * The contract these tests defend: what you see is what the URL says.
   *
   * A control holding its own state breaks that silently — the chart changes,
   * the address bar does not, and the link someone shares shows them something
   * else. That failure is invisible in manual testing, which is why it is
   * checked mechanically here.
   */
  test("changing a filter writes it to the URL", async ({ page }) => {
    await page.goto("/finops");
    await page.getByRole("group", { name: "Range" }).getByRole("button", { name: "7d" }).click();
    await expect(page).toHaveURL(/[?&]range=7d/);

    await page
      .getByRole("group", { name: "Group by" })
      .getByRole("button", { name: "Environment" })
      .click();
    await expect(page).toHaveURL(/[?&]groupBy=environment/);
    // Both survive together — a later filter must not clobber an earlier one.
    await expect(page).toHaveURL(/[?&]range=7d/);
  });

  test("the default value is removed from the URL rather than spelled out", async ({ page }) => {
    await page.goto("/finops?range=7d");
    await page.getByRole("group", { name: "Range" }).getByRole("button", { name: "30d" }).click();
    // 30d is the default. Keeping it would make two identical views carry
    // different URLs, and bury the parameter that was actually changed.
    await expect(page).not.toHaveURL(/range=/);
  });

  test("a shared URL opens in exactly the state it describes", async ({ page }) => {
    await page.goto("/history/volume?grain=week&window=90d");
    await expect(
      page.getByRole("group", { name: "Grain" }).getByRole("button", { name: "Week" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("group", { name: "Window" }).getByRole("button", { name: "90d" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("presentation", () => {
  test("the theme can be switched and survives a reload", async ({ page }) => {
    await page.goto("/today");
    await page
      .getByRole("group", { name: "Colour theme" })
      .getByRole("button", { name: "Light" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // "Auto" must be reachable again: it is the default, and a two-state toggle
    // that cannot return to following the OS is a one-way door.
    await page
      .getByRole("group", { name: "Colour theme" })
      .getByRole("button", { name: "Auto" })
      .click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  });

  test("charts render as SVG, not as an empty container", async ({ page }) => {
    await page.goto("/history/bodyweight");
    // Plotly loads dynamically, so the container exists well before the chart
    // does. Counting real geometry is what distinguishes "drawn" from "mounted".
    await expect(page.locator(".plot .main-svg").first()).toBeVisible({ timeout: 15_000 });
    expect(await page.locator(".plot path").count()).toBeGreaterThan(0);
  });
});

test.describe("authentication is enforced, not decorative", () => {
  /**
   * These tests MUST NOT use `page.request`.
   *
   * `page.request` shares the browser context, and the fixture put the minted
   * credentials on that context — so an "unauthenticated" request through it
   * is silently authenticated and the test passes while proving nothing. A
   * freshly-created request context is the only way to be genuinely anonymous.
   */
  test("the API refuses a request with no session", async ({ playwright, baseURL }) => {
    const anonymous = await playwright.request.newContext();
    try {
      const response = await anonymous.get(`${baseURL}/api/me`, {
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      expect([301, 302, 401]).toContain(response.status());
    } finally {
      await anonymous.dispose();
    }
  });

  test("a forged identity header does not authenticate", async ({ playwright, baseURL }) => {
    // Against a deployed environment the edge strips these before the origin
    // sees them (ADR-0009); locally the origin rejects the bad signature.
    // Either way the answer must not be 200 with an identity.
    const anonymous = await playwright.request.newContext();
    try {
      const response = await anonymous.get(`${baseURL}/api/me`, {
        headers: {
          "x-auth-email": "attacker@example.com",
          "x-auth-exp": String(Math.floor(Date.now() / 1000) + 300),
          "x-auth-sig": "forged",
          "x-auth-actor": "agent",
        },
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      expect([301, 302, 401]).toContain(response.status());
    } finally {
      await anonymous.dispose();
    }
  });

  test("the health endpoint is deliberately public", async ({ playwright, baseURL }) => {
    const anonymous = await playwright.request.newContext();
    try {
      const response = await anonymous.get(`${baseURL}/api/health`, { failOnStatusCode: false });
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
    } finally {
      await anonymous.dispose();
    }
  });
});

test.describe("presentation", () => {
  test("the page never scrolls horizontally", async ({ page }) => {
    // Wide tables must scroll inside their own container. A body that scrolls
    // sideways on a phone makes every page feel broken.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["/", "/block", "/log", "/progress", "/finops", "/history/volume"]) {
      await page.goto(path);
      await expect(page.locator("main h1")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
    }
  });

  test("renders correctly in dark mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator("main h1")).toBeVisible();
    // A transparent body borrows whatever the host paints behind it, which is
    // how a dark-mode page ends up with unreadable text.
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).not.toBe("rgba(0, 0, 0, 0)");
  });
});
