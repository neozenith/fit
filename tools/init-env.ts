#!/usr/bin/env bun
/**
 * Give a deployed environment its first training block.
 *
 *   bun run tools/init-env.ts --env dev --squat 70 --bench 40 --deadlift 80
 *
 * Goes through the PUBLIC API with a minted session (ADR-0011) rather than
 * writing to DynamoDB directly. That is deliberate: a direct write would bypass
 * the zod validation, the key construction and the accessory defaults, and
 * would happily create an item the application cannot read. This path exercises
 * exactly what a browser exercises.
 *
 * Idempotent by refusal, not by overwrite: if the environment already has a
 * block it stops and says so. Blocks are append-only (ADR-0013), so "run it
 * twice" must not mean "silently start a second cycle".
 */

import { createHmac } from "node:crypto";
import { parseArgs } from "node:util";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const HOSTS: Record<string, string> = {
  dev: "https://fit-dev.jpeak.ai",
  test: "https://fit-test.jpeak.ai",
  prod: "https://fit.jpeak.ai",
  local: "http://localhost:8787",
};

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const hmac = (key: string, message: string): string =>
  b64url(createHmac("sha256", key).update(message).digest());

const ssmValue = async (name: string, decrypt: boolean): Promise<string> => {
  const ssm = new SSMClient({ region: process.env["AWS_REGION"] ?? "ap-southeast-2" });
  const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: decrypt }));
  const value = result.Parameter?.Value;
  if (!value) throw new Error(`${name} is empty`);
  return value;
};

/** The Monday on or before a date, in UTC. */
const mondayOf = (iso: string): string => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      env: { type: "string" },
      squat: { type: "string", default: "70" },
      bench: { type: "string", default: "40" },
      deadlift: { type: "string", default: "80" },
      units: { type: "string", default: "kg" },
      start: { type: "string" },
      force: { type: "boolean", default: false },
    },
    strict: true,
  });

  const env = values.env as string | undefined;
  const host = env ? HOSTS[env] : undefined;
  if (!env || !host) {
    console.error(`error: --env must be one of ${Object.keys(HOSTS).join(", ")}`);
    process.exit(2);
  }

  const key =
    env === "local"
      ? "local-development-key-not-a-secret"
      : await ssmValue(`/fit/${env}/auth/session_hmac_key`, true);
  const email =
    env === "local"
      ? "local@example.com"
      : ((await ssmValue(`/fit/${env}/auth/allowed_users`, false)).split(",")[0] ?? "").trim();

  const exp = Math.floor(Date.now() / 1000) + 600;
  const payload = b64url(Buffer.from(JSON.stringify({ email, idp: "entra", actor: "agent", exp })));
  const cookie = `__session=${payload}.${hmac(key, payload)}`;

  // Local has no edge, so the API is handed the headers directly; deployed
  // environments carry the cookie and let the edge mint them (ADR-0009).
  const headerExp = Math.floor(Date.now() / 1000) + 300;
  const auth: Record<string, string> =
    env === "local"
      ? {
          "x-auth-email": email,
          "x-auth-exp": String(headerExp),
          "x-auth-sig": hmac(key, `${email}.${headerExp}`),
          "x-auth-actor": "agent",
        }
      : { cookie };

  /**
   * Read a JSON body, and say what actually arrived when it is not JSON.
   *
   * A bare `.json()` reports "Failed to parse JSON" and nothing else — not the
   * status, not the URL, not the first bytes. Behind CloudFront that message is
   * actively misleading: a 403 from the origin is rewritten to `index.html`
   * with status **200**, so `response.ok` is true and the "JSON" is a web page.
   */
  const readJson = async <T>(response: Response, what: string): Promise<T> => {
    const body = await response.text();
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(
        `${what}: expected JSON, got HTTP ${response.status} ` +
          `${response.headers.get("content-type") ?? "no content-type"} — ` +
          `${body.slice(0, 200).replace(/\s+/g, " ")}`,
      );
    }
  };

  const existing = await fetch(`${host}/api/blocks`, { headers: auth });
  if (!existing.ok) {
    throw new Error(`could not read blocks: HTTP ${existing.status} ${await existing.text()}`);
  }
  const { blocks } = await readJson<{ blocks: unknown[] }>(existing, "reading blocks");

  if (blocks.length > 0 && !values.force) {
    console.log(
      `${env} already has ${blocks.length} block(s). Nothing done.\n` +
        "Blocks are append-only, so this refuses rather than overwriting. Pass --force to add another.",
    );
    return;
  }

  const startDate = mondayOf(values.start ?? new Date().toISOString().slice(0, 10));

  const response = await fetch(`${host}/api/blocks`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      startDate,
      units: values.units,
      oneRepMax: {
        squat: Number(values.squat),
        bench: Number(values.bench),
        deadlift: Number(values.deadlift),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`create failed: HTTP ${response.status} ${await response.text()}`);
  }

  const { block } = await readJson<{ block: { blockId: string } }>(response, "creating the block");
  console.log(
    `Created block ${block.blockId} in ${env}, starting ${startDate} ` +
      `(squat ${values.squat} / bench ${values.bench} / deadlift ${values.deadlift} ${values.units}).`,
  );
  console.log(`Open it at ${host.replace(":8787", ":5173")}`);
};

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
