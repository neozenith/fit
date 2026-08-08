import { test as base, expect } from "@playwright/test";
import { type EnvName, mintSession } from "./auth.js";

/**
 * An authenticated page, per test.
 *
 * The mint happens per test rather than once in a global setup, because a
 * session lasts ten minutes by design (ADR-0011) and a suite that grew past
 * that would start failing halfway through in a way that looks like a flaky
 * application rather than an expired credential.
 */
export const test = base.extend<{ env: EnvName }>({
  /*
   * Playwright PARSES the first parameter's destructuring pattern to discover
   * which fixtures this one depends on, and rejects a plain identifier at
   * runtime with "First argument must use the object destructuring pattern".
   * This fixture depends on none of them — the environment comes from project
   * metadata — so the empty pattern is the only form that both compiles and
   * runs, and the rule has to be suppressed rather than satisfied.
   */
  // biome-ignore lint/correctness/noEmptyPattern: required by Playwright's fixture parser, see above
  env: async ({}, use, testInfo) => {
    await use((testInfo.project.metadata as { env: EnvName }).env);
  },

  context: async ({ context, env, baseURL }, use) => {
    const session = await mintSession(env);

    if (env === "local") {
      // No edge locally, so the API is given the identity headers directly.
      // This is the ONLY place that works — see auth.ts.
      await context.setExtraHTTPHeaders(session.headers);
      await use(context);
      return;
    }

    // The cookie domain comes from the PROJECT'S OWN baseURL, and nothing else.
    //
    // An earlier version derived it from `context.pages()[0]?.url()` with a
    // hardcoded fallback. On a fresh context there are no pages, so every
    // environment fell through to that fallback — the cookie was set on the
    // production hostname and simply never sent to dev or test. The API tests
    // still passed (they build their own requests), so the failure showed up
    // only as "the page did not render", which points at the application
    // rather than at the credential.
    if (!baseURL) {
      throw new Error(
        `No baseURL for project '${env}'. The session cookie has no domain to bind to, ` +
          "and would silently not be sent.",
      );
    }

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

    await use(context);
  },
});

export { expect };
