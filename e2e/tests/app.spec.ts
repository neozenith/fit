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

  test("every section is reachable", async ({ page }) => {
    await page.goto("/");
    for (const label of ["Today", "Block", "Log", "Body", "Progress", "Cost"]) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
      // A rendered heading is the proof the page mounted rather than throwing —
      // a React error boundary would leave the nav highlighted and the body empty.
      await expect(page.locator("main h1")).toBeVisible();
    }
  });

  test("no console errors on any page", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    for (const hash of ["", "#/block", "#/log", "#/measurements", "#/progress", "#/finops"]) {
      await page.goto(`/${hash}`);
      await expect(page.locator("main h1")).toBeVisible();
    }

    expect(errors).toEqual([]);
  });
});

test.describe("today", () => {
  test("shows the block's seed maxes and a session", async ({ page }) => {
    await page.goto("/#/today");
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
    await page.goto("/#/block");
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
    await page.goto("/#/block");
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
    await page.goto("/#/block");
    test.skip(!(await hasBlock(page)), "environment has no block yet");
    await page.getByRole("button", { name: "Week 5", exact: true }).click();
    // `x1-4` is the measurement the next block is seeded from — if it is
    // missing, the recursion has no input.
    await expect(page.getByText("x1-4").first()).toBeVisible();
  });
});

test.describe("log", () => {
  test("pre-fills from the prescription", async ({ page }) => {
    await page.goto("/#/log");
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
    await page.goto("/#/measurements");
    await expect(page.locator("#kind")).toBeVisible();
    await expect(page.getByText(/Median, not mean/i)).toBeVisible();
  });
});

test.describe("progress", () => {
  test("renders the estimated one-rep max panel", async ({ page }) => {
    await page.goto("/#/progress");
    await expect(page.getByRole("heading", { name: /Estimated one-rep max/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Best to date/i })).toBeVisible();
  });
});

test.describe("cost", () => {
  test("either shows a breakdown or says why it cannot", async ({ page }) => {
    await page.goto("/#/finops");
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
    for (const hash of ["", "#/block", "#/log", "#/progress", "#/finops"]) {
      await page.goto(`/${hash}`);
      await expect(page.locator("main h1")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow on /${hash}`).toBeLessThanOrEqual(1);
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
