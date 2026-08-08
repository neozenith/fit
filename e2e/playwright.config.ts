import { defineConfig, devices } from "@playwright/test";
import { BASE_URLS, type EnvName } from "./auth.js";

/**
 * One project per environment, so the SAME suite runs against local, dev, test
 * and prod:
 *
 *   bun run --cwd e2e test -- --project=local
 *   bun run --cwd e2e test -- --project=prod
 *
 * That the identical assertions run everywhere is the point. A test that only
 * runs locally proves the bundle works; a test that runs against prod proves
 * the deployment does.
 */

const ENVIRONMENTS: EnvName[] = ["local", "dev", "test", "prod"];

export default defineConfig({
  testDir: "./tests",
  // Every test authenticates independently, so parallelism is safe. It is
  // capped in CI because a deployed environment behind CloudFront gains
  // nothing from more concurrency and a flake becomes harder to attribute.
  fullyParallel: true,
  workers: process.env["CI"] ? 2 : undefined,
  // A `.only` left in a file silently narrows CI to one test while still
  // reporting green. Failing the run is the only reliable guard.
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // Generous, because a cold Lambda behind a cold CloudFront edge on the
    // first request of the day is genuinely slower than a warm one.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: ENVIRONMENTS.map((env) => ({
    name: env,
    use: {
      ...devices["Desktop Chrome"],
      baseURL: BASE_URLS[env],
    },
    metadata: { env },
  })),
});
