#!/usr/bin/env bun
/**
 * Mint a short-lived session for agentic testing (ADR-0011).
 *
 * The key is read from the environment's own SSM parameter using the caller's
 * AWS credentials, so access to a test session is exactly access to that
 * parameter — already governed by IAM. Nothing is stored: the cookie is derived
 * at use time and expires in minutes.
 *
 *   make token ENV=dev
 *   bun run tools/mint-token.ts --env prod --minutes 5 --format curl
 */

import { createHmac } from "node:crypto";
import { parseArgs } from "node:util";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const ENVIRONMENTS = ["local", "dev", "test", "prod"] as const;
type Environment = (typeof ENVIRONMENTS)[number];

const HOSTS: Record<Environment, string> = {
  local: "http://localhost:5173",
  dev: "https://fit-dev.jpeak.ai",
  test: "https://fit-test.jpeak.ai",
  prod: "https://fit.jpeak.ai",
};

/**
 * Matches `LOCAL_SESSION_KEY` in the API's const module. Local development has
 * no SSM to read from, and a fixed development key is not a secret — the local
 * stack is not reachable from anywhere.
 */
const LOCAL_KEY = "local-development-key-not-a-secret";

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const hmac = (key: string, message: string): string =>
  b64url(createHmac("sha256", key).update(message).digest());

const printHelp = (): void => {
  console.log(
    [
      "Usage: mint-token --env <local|dev|test|prod> [options]",
      "",
      "Mints a short-lived session cookie and the matching edge-signed identity",
      "headers, so a test run can authenticate without an interactive sign-in.",
      "",
      "Options:",
      "  --env <name>       Target environment (required)",
      "  --email <address>  Identity to mint for (default: the first allowed user)",
      "  --minutes <n>      Lifetime, capped at 60 (default: 10)",
      "  --format <fmt>     cookie | headers | curl | json (default: cookie)",
      "  -h, --help         Show this help",
      "",
      "The minted session is marked `actor=agent`, so it is distinguishable from",
      "a human sign-in everywhere it appears in the audit trail.",
    ].join("\n"),
  );
};

const readSessionKey = async (environment: Environment): Promise<string> => {
  if (environment === "local") return LOCAL_KEY;

  const ssm = new SSMClient({ region: process.env["AWS_REGION"] ?? "ap-southeast-2" });
  const name = `/fit/${environment}/auth/session_hmac_key`;

  const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = result.Parameter?.Value;
  if (!value) throw new Error(`${name} is empty — has the identity stack been applied?`);
  return value;
};

const readAllowedUser = async (environment: Environment): Promise<string> => {
  if (environment === "local") return "local@example.com";

  const ssm = new SSMClient({ region: process.env["AWS_REGION"] ?? "ap-southeast-2" });
  const name = `/fit/${environment}/auth/allowed_users`;
  const result = await ssm.send(new GetParameterCommand({ Name: name }));
  const first = (result.Parameter?.Value ?? "").split(",")[0]?.trim();
  if (!first) throw new Error(`${name} is empty — nobody is admitted to ${environment}`);
  return first;
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      env: { type: "string" },
      email: { type: "string" },
      minutes: { type: "string", default: "10" },
      format: { type: "string", default: "cookie" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const environment = values.env as Environment | undefined;
  if (!environment || !ENVIRONMENTS.includes(environment)) {
    console.error(`error: --env must be one of ${ENVIRONMENTS.join(", ")}`);
    printHelp();
    process.exit(2);
  }

  // Capped hard. A minted session is a bypass of the interactive sign-in, and
  // the only thing keeping that acceptable is that it is worthless within the
  // hour. An uncapped --minutes would quietly turn it into a standing credential.
  const minutes = Math.min(Math.max(Number(values.minutes) || 10, 1), 60);

  const key = await readSessionKey(environment);
  const email = (values.email ?? (await readAllowedUser(environment))).toLowerCase();

  const expSeconds = Math.floor(Date.now() / 1000) + minutes * 60;
  const payload = b64url(
    Buffer.from(JSON.stringify({ email, idp: "entra", actor: "agent", exp: expSeconds })),
  );
  const sessionCookie = `${payload}.${hmac(key, payload)}`;

  // The identity headers the EDGE would inject. Their expiry is the edge's own
  // 300s window, not the session's — an origin-level replay window must stay
  // short even when the session behind it is longer.
  const headerExp = Math.floor(Date.now() / 1000) + 300;
  const headers = {
    "x-auth-email": email,
    "x-auth-exp": String(headerExp),
    "x-auth-sig": hmac(key, `${email}.${headerExp}`),
    "x-auth-actor": "agent",
  };

  const host = HOSTS[environment];

  switch (values.format) {
    case "headers":
      for (const [k, v] of Object.entries(headers)) console.log(`${k}: ${v}`);
      break;
    case "curl":
      // Against a deployed environment the request must go through CloudFront,
      // so it carries the COOKIE and lets the edge mint the headers itself.
      // Sending the headers directly would be stripped at the edge by design.
      console.log(`curl -sS -H 'Cookie: __session=${sessionCookie}' '${host}/api/me' | jq`);
      break;
    case "json":
      console.log(
        JSON.stringify(
          {
            environment,
            email,
            host,
            expiresAt: new Date(expSeconds * 1000).toISOString(),
            sessionCookie,
            headers,
          },
          null,
          2,
        ),
      );
      break;
    default:
      console.log(sessionCookie);
  }

  console.error(`# ${environment} session for ${email}, valid ${minutes} minute(s), actor=agent`);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exit(1);
});
