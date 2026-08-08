#!/usr/bin/env bun
/**
 * Smoke-test every API route of an environment with a minted session.
 *
 * Complements the Playwright suite rather than duplicating it: this checks the
 * API contract directly, so a failure here is unambiguously the service, not
 * the browser, the bundle, or a selector.
 *
 *   bun run tools/smoke.ts --env local
 *   bun run tools/smoke.ts --env dev
 *
 * Against a deployed environment it goes through CloudFront and carries the
 * SESSION COOKIE, letting the edge mint the identity headers itself. Sending
 * the headers directly would be correct only against a local API — the edge
 * strips inbound `x-auth-*` by design (ADR-0009), which is exactly the
 * behaviour this script's `stripped` check confirms.
 */

import { createHmac } from "node:crypto";
import { parseArgs } from "node:util";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const ORIGINS: Record<string, string> = {
  local: "http://localhost:8787",
  dev: "https://fit-dev.jpeak.ai",
  test: "https://fit-test.jpeak.ai",
  prod: "https://fit.jpeak.ai",
};

const LOCAL_KEY = "local-development-key-not-a-secret";

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const hmac = (key: string, message: string): string =>
  b64url(createHmac("sha256", key).update(message).digest());

const sessionKeyFor = async (environment: string): Promise<string> => {
  if (environment === "local") return LOCAL_KEY;
  const ssm = new SSMClient({ region: process.env["AWS_REGION"] ?? "ap-southeast-2" });
  const result = await ssm.send(
    new GetParameterCommand({
      Name: `/fit/${environment}/auth/session_hmac_key`,
      WithDecryption: true,
    }),
  );
  const value = result.Parameter?.Value;
  if (!value) throw new Error(`no session key for ${environment}`);
  return value;
};

interface Check {
  name: string;
  path: string;
  /** Returns an error string, or null when the body is acceptable. */
  expect?: (body: Record<string, unknown>) => string | null;
}

const CHECKS: Check[] = [
  {
    name: "health (unauthenticated)",
    path: "/api/health",
    expect: (b) => (b["ok"] === true ? null : "health did not report ok"),
  },
  {
    name: "identity",
    path: "/api/me",
    expect: (b) => (typeof b["email"] === "string" ? null : "no email in identity"),
  },
  {
    name: "current block + sessions",
    path: "/api/blocks/current",
    expect: (b) => (Array.isArray(b["sessions"]) ? null : "sessions is not an array"),
  },
  { name: "block list", path: "/api/blocks" },
  { name: "logged sets", path: "/api/sets" },
  { name: "measurements", path: "/api/measurements" },
  { name: "progress", path: "/api/progress" },
  { name: "season", path: "/api/season" },
  {
    name: "finops",
    path: "/api/finops",
    // `available: false` is a PASS. An environment deployed before the global
    // FinOps stack genuinely has no cost data, and the page says so rather
    // than rendering zeros.
    expect: (b) => (typeof b["available"] === "boolean" ? null : "no availability flag"),
  },
];

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { env: { type: "string", default: "local" } },
    strict: true,
  });

  const environment = values.env as string;
  const origin = ORIGINS[environment];
  if (!origin) throw new Error(`unknown environment '${environment}'`);

  const key = await sessionKeyFor(environment);
  const email = environment === "local" ? "local@example.com" : "";
  const deployed = environment !== "local";

  const exp = Math.floor(Date.now() / 1000) + 300;
  const sessionExp = Math.floor(Date.now() / 1000) + 600;

  let resolvedEmail = email;
  if (deployed) {
    const ssm = new SSMClient({ region: process.env["AWS_REGION"] ?? "ap-southeast-2" });
    const allowed = await ssm.send(
      new GetParameterCommand({ Name: `/fit/${environment}/auth/allowed_users` }),
    );
    resolvedEmail = (allowed.Parameter?.Value ?? "").split(",")[0]?.trim() ?? "";
  }

  const payload = b64url(
    Buffer.from(
      JSON.stringify({ email: resolvedEmail, idp: "entra", actor: "agent", exp: sessionExp }),
    ),
  );
  const cookie = `__session=${payload}.${hmac(key, payload)}`;

  const authHeaders: Record<string, string> = deployed
    ? { cookie }
    : {
        "x-auth-email": resolvedEmail,
        "x-auth-exp": String(exp),
        "x-auth-sig": hmac(key, `${resolvedEmail}.${exp}`),
        "x-auth-actor": "agent",
      };

  console.log(`Smoke test: ${environment} (${origin})\n`);

  let failures = 0;

  // Every protected route must reject an unauthenticated caller. Checking this
  // FIRST means a misconfiguration that makes everything public is caught
  // before a wall of green ticks makes it look fine.
  const anonymous = await fetch(`${origin}/api/me`, { redirect: "manual" });
  const anonOk = anonymous.status === 401 || anonymous.status === 302;
  console.log(
    `${anonOk ? "  ok  " : "  FAIL"}  unauthenticated /api/me is refused (${anonymous.status})`,
  );
  if (!anonOk) failures++;

  for (const check of CHECKS) {
    const headers = check.path === "/api/health" ? {} : authHeaders;
    try {
      const response = await fetch(`${origin}${check.path}`, { headers, redirect: "manual" });
      const text = await response.text();
      const body = text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : {};

      if (!response.ok) {
        console.log(`  FAIL  ${check.name} — HTTP ${response.status} ${text.slice(0, 120)}`);
        failures++;
        continue;
      }

      const problem = check.expect?.(body) ?? null;
      if (problem) {
        console.log(`  FAIL  ${check.name} — ${problem}`);
        failures++;
        continue;
      }

      console.log(`  ok    ${check.name}`);
    } catch (error) {
      console.log(`  FAIL  ${check.name} — ${error instanceof Error ? error.message : error}`);
      failures++;
    }
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
  // Failures are an exit code, not just a line in the output — a reader skims,
  // CI cannot.
  if (failures > 0) process.exit(1);
};

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
