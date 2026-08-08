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
  env: async ({}, use, testInfo) => {
    await use((testInfo.project.metadata as { env: EnvName }).env);
  },

  context: async ({ context, env }, use) => {
    const session = await mintSession(env);

    if (env === "local") {
      // No edge locally, so the API is given the identity headers directly.
      // This is the ONLY place that works — see auth.ts.
      await context.setExtraHTTPHeaders(session.headers);
    } else {
      const url = new URL(context.pages()[0]?.url() ?? "https://fit.jpeak.ai");
      await context.addCookies([
        {
          name: "__session",
          value: session.cookie,
          domain: new URL(process.env["PW_BASE_URL"] ?? url.origin).hostname,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    }

    await use(context);
  },
});

export { expect };
