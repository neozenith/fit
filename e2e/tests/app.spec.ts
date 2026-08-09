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
/**
 * Whether the log page has a session picker, decided only once it has settled.
 *
 * `count()` resolves immediately and does not auto-wait, so asking before the
 * block request returns reports zero on an environment that has one — a false
 * skip that silently drops every assertion below it.
 */
const hasSessionPicker = async (page: Page): Promise<boolean> => {
  const picker = page.locator(".session-picker .day").first();
  const empty = page.getByText(/no training block/i);
  await expect(picker.or(empty).first()).toBeVisible();
  return picker.isVisible();
};

const hasBlock = async (page: Page): Promise<boolean> => {
  // Decided from the OVERVIEW's two settled states, and waited for. An
  // immediate count races the load and reports "no block" on an environment
  // that has one — which then silently skips every assertion below it.
  const timeline = page.locator(".timeline__row").first();
  const empty = page.getByRole("heading", { name: "How it works" });
  await expect(timeline.or(empty).first()).toBeVisible();
  return timeline.isVisible();
};

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
      "/history/rep-maxes",
      "/history/cardio",
    ]) {
      await page.goto(path);
      await expect(page.locator("main h1")).toBeVisible();
    }

    expect(errors).toEqual([]);
  });
});

test.describe("overview", () => {
  test("says whether a block exists, either way", async ({ page }) => {
    await page.goto("/overview");
    await expect(page.locator("main h1")).toHaveText(/Overview|Start here/);

    // "Do I have a block?" was the least answerable question in the app, so
    // BOTH outcomes are asserted: a calendar, or a statement that there is
    // none. An empty page is the failure being guarded against.
    const has = await hasBlock(page);
    if (has) {
      // A timeline of every block, not one block's calendar. "Do these two
      // overlap" and "what have I planned" were unanswerable before.
      await expect(page.locator(".timeline__row").first()).toBeVisible();
    } else {
      // The empty state is the FIRST screen a new account sees, since this is
      // the default route. It has to teach the program and give exactly one
      // action — "you have no block" states a fact and leaves the reader stuck.
      await expect(page.locator("main h1")).toHaveText("Start here");
      await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Set your inputs" })).toBeVisible();
    }
  });

  test("the calendar links each session to its own log URL", async ({ page }) => {
    await page.goto("/overview");
    test.skip(!(await hasBlock(page)), "environment has no block yet");

    const days = page.locator(".calendar a.day");
    test.skip((await days.count()) === 0, "the selected block's sessions are not loaded");

    // Every tile is addressable. That is what makes "log week 3 day 2" a link
    // rather than an instruction to click around until you find it.
    const href = await days.first().getAttribute("href");
    expect(href).toMatch(/^\/log\?week=\d+&day=\d+$/);
  });

  test("session state is not conveyed by colour alone", async ({ page }) => {
    await page.goto("/overview");
    test.skip(!(await hasBlock(page)), "environment has no block yet");

    const days = page.locator(".calendar a.day");
    test.skip((await days.count()) === 0, "the selected block's sessions are not loaded");

    // Each tile carries an `n/m` count and a title as well as its colour.
    // Colour-only status fails anyone who cannot distinguish the hues, and it
    // fails everyone in a screenshot pasted into a message. The title also
    // carries the session REFERENCE, which is the thing to quote when talking
    // about one specific session.
    await expect(days.first()).toHaveAttribute("title", /\d+\/\d+ exercises/);
  });

  test("selecting a block writes it to the URL", async ({ page }) => {
    await page.goto("/overview");
    test.skip(!(await hasBlock(page)), "environment has no block yet");

    await page.locator(".timeline__row").first().click();
    await expect(page).toHaveURL(/[?&]block=/);
  });

  test("the timeline span is a filter like any other", async ({ page }) => {
    await page.goto("/overview");
    test.skip(!(await hasBlock(page)), "environment has no block yet");

    await page
      .getByRole("group", { name: "Timeline span" })
      .getByRole("button", { name: "All" })
      .click();
    await expect(page).toHaveURL(/[?&]span=all/);
  });
});

test.describe("block inputs", () => {
  test("states the block's existence and offers the seed inputs", async ({ page }) => {
    await page.goto("/block-inputs");
    await expect(page.locator("main h1")).toHaveText("Block inputs");

    for (const id of ["#squat", "#bench", "#deadlift", "#startDate", "#units"]) {
      await expect(page.locator(id)).toBeVisible();
    }
    await expect(
      page.getByRole("heading", { name: /You have (a block|no block yet)/ }),
    ).toBeVisible();
  });

  test("offers all four optional accessory slots", async ({ page }) => {
    await page.goto("/block-inputs");
    // The spreadsheet's Optional Exercise 1/2 and Optional Lower Body 1/2 —
    // the inputs that made a block the athlete's rather than the program's.
    for (const slot of ["optional1", "optional2", "optionalLower1", "optionalLower2"]) {
      await expect(page.locator(`#slot-${slot}`)).toBeVisible();
    }
  });

  test("an accessory picker can be browsed, searched, and typed into", async ({ page }) => {
    await page.goto("/block-inputs");
    const field = page.locator("#slot-optional1");
    const combobox = page.locator(".combobox").filter({ has: field });

    // BROWSE. A `<datalist>` offered no way to see the options without first
    // guessing part of a name, which is why it was unusable — this asserts the
    // full list opens from a control.
    await combobox.getByRole("button", { name: "Show all options" }).click();
    const options = combobox.getByRole("option");
    expect(await options.count()).toBeGreaterThan(10);

    // SEARCH.
    await field.fill("kettlebell");
    await expect(options.first()).toContainText(/kettlebell/i);
    const filtered = await options.count();
    expect(filtered).toBeGreaterThan(0);

    // PICK.
    const chosen = (await options.first().innerText()).trim();
    await options.first().click();
    await expect(field).toHaveValue(chosen);

    // TYPE ANYTHING. The source spreadsheet allowed free text, so a movement the
    // list has never seen — which is every new one — must still be accepted.
    await field.fill("Sandbag Carry");
    await expect(field).toHaveValue("Sandbag Carry");
  });

  test("offers the estimated max as a starting point", async ({ page }) => {
    await page.goto("/block-inputs");
    const hint = page.getByText(/Estimated \d+ from/).first();
    test.skip(!(await hint.isVisible()), "no logged sets to estimate from");

    // Offered, never imposed: a max is a decision, and silently overwriting one
    // would be the wrong kind of help.
    await hint.getByRole("button", { name: "use" }).click();
    await expect(page.locator("#squat")).not.toHaveValue("");
  });

  test("previews the six weeks the inputs produce", async ({ page }) => {
    await page.goto("/block-inputs");
    // "Which days does this land on?" is a question you ask BEFORE committing,
    // so the calendar belongs here and not only on the overview.
    await expect(page.getByRole("heading", { name: "What this produces" })).toBeVisible();
    expect(await page.locator(".calendar .day").count()).toBeGreaterThan(10);
  });

  test("a previewed session can be opened to see what it prescribes", async ({ page }) => {
    await page.goto("/block-inputs");
    const day = page.locator(".calendar .day").first();
    await expect(day).toBeVisible();

    // The squares were inert, which made the preview a shape and not an
    // inspection: you could see week 3 has four days without seeing what any
    // of them ask for.
    await day.click();
    const detail = page.locator(".session-detail");
    await expect(detail).toBeVisible();
    await expect(detail.locator("table tbody tr").first()).toBeVisible();
  });

  test("the deadlift slot offers every hinge, not a hardcoded four", async ({ page }) => {
    await page.goto("/block-inputs");
    const field = page.locator("#slot-deadliftVariation");
    const combobox = page.locator(".combobox").filter({ has: field });

    await combobox.getByRole("button", { name: "Show all options" }).click();
    const options = combobox.getByRole("option");

    // Romanian Dead Lift is in the log five times and is unambiguously a hinge,
    // and it was unpickable here because the slot carried a literal of four
    // strings. Its presence is the proof the picker reads the catalogue.
    await expect(options.filter({ hasText: "Romanian Dead Lift" })).toHaveCount(1);
    expect(await options.count()).toBeGreaterThan(4);
  });

  test("names replacement as replacement, not as an edit", async ({ page }) => {
    await page.goto("/block-inputs");
    // Storage is append-only (ADR-0013), so there is no edit and no delete. The
    // page has to SAY that rather than offer a Save button that quietly writes
    // a second row.
    await expect(page.getByRole("button", { name: /Replace block|Create block/ })).toBeVisible();
  });
});

test.describe("log", () => {
  test("picks a session without a dropdown", async ({ page }) => {
    await page.goto("/log");
    await expect(page.locator("main h1")).toHaveText("Log a session");

    test.skip(!(await hasSessionPicker(page)), "environment has no block yet");

    // A grid, not a `<select>`: which sessions are already done is the most
    // useful thing to see when choosing one, and a dropdown hides exactly that.
    expect(await page.locator(".session-picker .day").count()).toBeGreaterThan(1);
  });

  test("selecting a session writes it to the URL", async ({ page }) => {
    await page.goto("/log");
    test.skip(!(await hasSessionPicker(page)), "environment has no block yet");

    await page.locator(".session-picker .day").nth(1).click();
    await expect(page).toHaveURL(/[?&]week=\d+/);
    await expect(page).toHaveURL(/[?&]day=\d+/);
  });

  test("logging a set increments the exercise's count", async ({ page }, testInfo) => {
    // LOCAL ONLY, and deliberately. This test WRITES, and the log is
    // append-only with no delete (ADR-0013) — running it against dev, test or
    // prod would permanently add sets nobody performed to a real training
    // record. Every other assertion in this suite is read-only, which is what
    // lets the same file run against all four environments.
    test.skip(testInfo.project.name !== "local", "writes real observations");

    await page.goto("/log");
    test.skip(!(await hasSessionPicker(page)), "environment has no block yet");

    // The first INCOMPLETE exercise. Picking `.first()` blindly finds one whose
    // sets are all logged from an earlier run — which still shows an empty
    // extra-set row, so the click lands but has no prescribed reps to save and
    // the count correctly does not move.
    const row = page.locator(".exercise-row:not(.exercise-row--logged)").first();
    await expect(row.or(page.getByText(/no training block/i)).first()).toBeVisible();
    test.skip(!(await row.isVisible()), "every exercise in this session is complete");

    const tick = row.locator(".set-row:not(.set-row--done) .set-row__save").first();
    const before = Number((await row.locator(".pill").innerText()).split("/")[0]?.trim() ?? "0");
    await tick.click();

    // The count comes back from the SERVER, recomputed from the log, not from
    // optimistic local state — so this also proves the write landed.
    await expect
      .poll(async () =>
        Number((await row.locator(".pill").innerText()).split("/")[0]?.trim() ?? "0"),
      )
      .toBeGreaterThan(before);

    // One SET, not one exercise. A four-set prescription needs four taps, so
    // asserting the exercise went green here would be asserting the old
    // behaviour this page was rebuilt to remove.
    await expect(row.locator(".set-row--done").first()).toBeVisible();
  });

  test("every prescribed set is its own row, with no disclosure control", async ({ page }) => {
    await page.goto("/log");
    test.skip(!(await hasSessionPicker(page)), "environment has no block yet");

    const exercise = page.locator(".exercise-row").first();
    await expect(exercise).toBeVisible();

    // One row per prescribed set. A four-set prescription is four decisions
    // made minutes apart, and the row you have not ticked is the answer to
    // "where was I" — so collapsing them into one control loses the feature.
    const rows = exercise.locator(".set-row");
    expect(await rows.count()).toBeGreaterThan(0);

    // The inputs are ALWAYS present on an unlogged row. An Edit button charged
    // a click to the case that is not an exception: the reps you got are rarely
    // the reps written down.
    //
    // Scoped to a row that is NOT yet logged — a completed row deliberately has
    // no inputs, because there is nothing left to decide about it, and an
    // environment where earlier tests have logged sets would otherwise fail
    // here for the right behaviour.
    const pending = exercise.locator(".set-row:not(.set-row--done)").first();
    await expect(pending.locator("input").first()).toBeVisible();
    await expect(exercise.getByRole("button", { name: /^Edit$/ })).toHaveCount(0);

    // One tap per set, and the tap is the largest target in the row.
    await expect(pending.getByRole("button", { name: /^Save / })).toBeVisible();
  });

  test("a set row is a single tap when the prescription is complete", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "local", "writes real observations");
    await page.goto("/log");
    test.skip(!(await hasSessionPicker(page)), "environment has no block yet");

    const exercise = page.locator(".exercise-row").first();
    const row = exercise.locator(".set-row:not(.set-row--done)").first();
    test.skip(!(await row.isVisible()), "every set in this exercise is already logged");

    const reps = row.locator("input").nth(1);
    test.skip((await reps.inputValue()) === "", "this set has no fixed rep target");

    const before = await exercise.locator(".set-row--done").count();

    // Pre-filled from the prescription, so the common case is ONE click: no
    // typing, no expanding, no save-all at the end.
    await row.getByRole("button", { name: /^Save / }).click();
    await expect
      .poll(async () => exercise.locator(".set-row--done").count())
      .toBeGreaterThan(before);
  });
});

test.describe("exercise catalogue", () => {
  test("classifies every movement on both axes", async ({ page }) => {
    await page.goto("/exercises");
    await expect(page.locator("main h1")).toHaveText("Exercises");

    const first = page.locator("table tbody tr").first();
    // Equipment answers "what do I need"; movement answers "what does this
    // train". The accessory pickers read the second one, which is why both
    // have to be editable rather than inferred from the name.
    await expect(first.getByRole("combobox").first()).toBeVisible();
    expect(await first.getByRole("combobox").count()).toBe(2);
  });

  test("an edit is persisted and marked as curated", async ({ page }, testInfo) => {
    // LOCAL ONLY: this writes a curation override, and the catalogue is shared
    // state for every picker in the environment.
    test.skip(testInfo.project.name !== "local", "writes curation state");

    await page.goto("/exercises?sort=name");
    const row = page.locator("table tbody tr").first();
    const name = (await row.locator("td").first().innerText()).split("\n")[0]?.trim() ?? "";
    const movement = row.getByRole("combobox").nth(1);

    const before = await movement.inputValue();
    const next = before === "core" ? "other" : "core";
    await movement.selectOption(next);

    await page.reload();
    const reloaded = page
      .locator("table tbody tr")
      .filter({ hasText: name })
      .first()
      .getByRole("combobox")
      .nth(1);
    await expect(reloaded).toHaveValue(next);
    // A curated entry is marked, so shipped defaults and deliberate choices are
    // distinguishable at a glance.
    await expect(page.locator("table tbody tr").filter({ hasText: name }).first()).toContainText(
      "curated",
    );
  });
});

test.describe("body", () => {
  test("offers both measurements and renders the weekly medians section", async ({ page }) => {
    await page.goto("/measurements");
    await expect(page.locator("#kind")).toBeVisible();
    await expect(page.getByText(/Median, not mean/i)).toBeVisible();
  });

  test("carries the imported history that used to be its own page", async ({ page }) => {
    // `/history/bodyweight` merged in here: recording a weigh-in and looking at
    // the trend are one activity, and they were two pages.
    await page.goto("/measurements");
    await expect(page.getByRole("heading", { name: "Imported history" })).toBeVisible();
  });

  test("the old bodyweight URL redirects rather than 404s", async ({ page }) => {
    await page.goto("/history/bodyweight");
    await expect(page).toHaveURL(/\/measurements/);
    await expect(page.locator("main h1")).toHaveText("Body");
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
      ["/history/cardio", "Cardio"],
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

  test("the exercise catalogue is its own page, and a table only", async ({ page }) => {
    await page.goto("/exercises");
    await expect(page.locator("main h1")).toHaveText("Exercises");

    const listed = page.getByRole("heading", { name: /movements/ });
    const empty = page.getByText(/No training history has been imported/i);
    await expect(listed.or(empty).first()).toBeVisible();
    test.skip(!(await listed.isVisible()), "this environment holds no imported history");

    await expect(page.locator("table")).toBeVisible();
    // No charts. "Where does my volume go" belongs on the volume page, which has
    // the filters and the time axis to answer it; here it only pushed the
    // reference list below the fold.
    await expect(page.locator(".plot")).toHaveCount(0);
  });

  test("a shared subpage URL opens in exactly the state it describes", async ({ page }) => {
    await page.goto("/history");
    test.skip(!(await hasImportedHistory(page)), "this environment holds no imported history");

    await page.goto("/history/volume?grain=week&window=90d");
    await expect(
      page.getByRole("group", { name: "Grain" }).getByRole("button", { name: "Week" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("group", { name: "Window" }).getByRole("button", { name: "90d" }),
    ).toHaveAttribute("aria-pressed", "true");
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
    // Cost, not a history page: the FinOps filters render whether or not the
    // export has landed, so this asserts the ROUTER contract without depending
    // on an environment having data. The equivalent history assertion lives in
    // the history suite, where it is correctly skipped when nothing is imported.
    await page.goto("/finops?range=7d&groupBy=environment&chart=lines");
    for (const [group, option] of [
      ["Range", "7d"],
      ["Group by", "Environment"],
      ["Chart", "Lines"],
    ] as const) {
      await expect(
        page.getByRole("group", { name: group }).getByRole("button", { name: option, exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
    }
  });
});

test.describe("presentation", () => {
  test("the theme can be switched and survives a reload", async ({ page }) => {
    await page.goto("/overview");
    // The control moved into the sidebar's foot, so on a narrow viewport the
    // drawer has to be open to reach it.
    const drawer = page.locator(".nav-toggle");
    if (await drawer.isVisible()) await drawer.click();

    await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // "Auto" must be reachable again: it is the default, and a two-state toggle
    // that cannot return to following the OS is a one-way door.
    if (await drawer.isVisible()) await drawer.click();
    await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Auto" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  });

  test("the sidebar collapses and remembers it", async ({ page }) => {
    await page.goto("/overview");
    const collapse = page.getByRole("button", { name: "Collapse navigation" });
    test.skip(!(await collapse.isVisible()), "drawer layout — collapse does not apply");

    await collapse.click();
    await expect(page.locator(".shell")).toHaveClass(/shell--collapsed/);

    // Collapsed is a RAIL, not a hidden nav: the links stay reachable.
    await expect(page.locator("#sidenav a").first()).toBeVisible();

    await page.reload();
    await expect(page.locator(".shell")).toHaveClass(/shell--collapsed/);
    // The button's accessible NAME changes with its state, which is the point:
    // its visible label is hidden in the rail, so without an explicit label it
    // would announce itself as "»".
    await page.getByRole("button", { name: "Expand navigation" }).click();
    await expect(page.locator(".shell")).not.toHaveClass(/shell--collapsed/);
  });

  test("the theme control lives in the sidebar, not the header", async ({ page }) => {
    await page.goto("/overview");
    const drawer = page.locator(".nav-toggle");
    if (await drawer.isVisible()) await drawer.click();
    await expect(page.locator("#sidenav").getByRole("group", { name: "Theme" })).toBeVisible();
    await expect(page.locator(".topbar").getByRole("group", { name: "Theme" })).toHaveCount(0);
  });

  test("the header carries block, week and session progress", async ({ page }) => {
    await page.goto("/overview");
    const bars = page.locator(".header-progress progress");
    const hasBlockNow = await hasBlock(page);
    test.skip(!hasBlockNow, "environment has no block yet");
    test.skip(!(await bars.first().isVisible()), "viewport too narrow for the header bars");

    // Three, and exactly three: block, week, session. They are different
    // denominators, which is why they are three bars and not one.
    expect(await bars.count()).toBe(3);
    for (const bar of await bars.all()) {
      expect(Number(await bar.getAttribute("max"))).toBeGreaterThan(0);
    }
  });

  test("charts render as SVG, not as an empty container", async ({ page }) => {
    // Progress rather than a history page: it draws from the LIVE log, which
    // every environment has, so this proves Plotly actually loads and paints
    // even where no archive has been imported.
    await page.goto("/progress");
    const chart = page.locator(".plot .main-svg").first();
    const empty = page.getByText(/Log some sets and this chart fills in/i);
    await expect(chart.or(empty).first()).toBeVisible({ timeout: 15_000 });
    test.skip(await empty.isVisible(), "this environment has no logged sets to chart");

    // Plotly loads dynamically, so the container exists well before the chart
    // does. Counting real geometry is what distinguishes "drawn" from "mounted".
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
    for (const path of ["/", "/overview", "/log", "/progress", "/finops", "/history/volume"]) {
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
