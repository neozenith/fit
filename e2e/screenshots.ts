#!/usr/bin/env bun
/**
 * Capture a screenshot of every page, in both themes, for an environment.
 *
 *   bun run e2e/screenshots.ts --env local
 *   bun run e2e/screenshots.ts --env dev --out tmp/shots
 *
 * Separate from the Playwright suite on purpose: the suite ASSERTS, this
 * OBSERVES. Mixing them would mean either a test that fails on a pixel or a
 * screenshot run that fails on an assertion — and the reason to look at a
 * screenshot is usually that something is wrong, which is exactly when you do
 * not want the capture aborting halfway through.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { BASE_URLS, type EnvName, mintSession } from "./auth.js";

const PAGES = [
  ["overview", "/overview"],
  ["block-inputs", "/block-inputs"],
  ["log", "/log"],
  ["body", "/measurements"],
  ["progress", "/progress"],
  ["exercises", "/exercises"],
  ["history", "/history"],
  ["history-volume", "/history/volume"],
  ["history-rep-maxes", "/history/rep-maxes"],
  ["history-cardio", "/history/cardio"],
  ["cost", "/finops"],
] as const;

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      env: { type: "string", default: "local" },
      out: { type: "string", default: "tmp/screenshots" },
    },
    strict: true,
  });

  const env = values.env as EnvName;
  const baseURL = BASE_URLS[env];
  if (!baseURL) throw new Error(`unknown environment '${env}'`);

  const session = await mintSession(env);
  const browser = await chromium.launch();

  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: scheme,
      // Deterministic device scale, so a screenshot taken on a retina laptop is
      // byte-comparable with one taken in CI.
      deviceScaleFactor: 1,
    });

    if (env === "local") {
      await context.setExtraHTTPHeaders(session.headers);
    } else {
      await context.addCookies([
        {
          name: "__session",
          value: session.cookie,
          domain: new URL(baseURL).hostname,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    }

    const page = await context.newPage();
    const dir = join(values.out as string, env, scheme);
    await mkdir(dir, { recursive: true });

    for (const [name, route] of PAGES) {
      await page.goto(`${baseURL}${route}`);
      // Wait for the heading rather than a fixed delay: every page fetches on
      // mount, and a timer either flakes or wastes time depending on the day.
      await page.waitForSelector("main h1", { state: "visible" });
      // One extra beat for charts, which render after their data resolves.
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
      console.log(`  ${join(dir, `${name}.png`)}`);
    }

    await context.close();
  }

  await browser.close();
  console.log(`\nCaptured ${PAGES.length * 2} screenshots for ${env}.`);
};

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
