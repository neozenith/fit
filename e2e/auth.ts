import { createHmac } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

/**
 * Session minting for the browser tests (ADR-0011).
 *
 * The key comes from the environment's SSM parameter using the runner's own AWS
 * credentials — nothing is checked in, and access to a test session is exactly
 * access to that parameter.
 *
 * The two environments authenticate differently, and the difference is not
 * incidental:
 *
 *   LOCAL   there is no edge, so the API is handed the identity headers
 *           directly. This is the only place that is legitimate.
 *   DEPLOYED the edge STRIPS every inbound `x-auth-*` header before doing
 *           anything else, so sending them would achieve precisely nothing.
 *           The browser carries the signed `__session` cookie instead and the
 *           edge mints the headers itself — the same path a human takes after
 *           signing in.
 */

export type EnvName = "local" | "dev" | "test" | "prod";

export const BASE_URLS: Record<EnvName, string> = {
  local: "http://localhost:5173",
  dev: "https://fit-dev.jpeak.ai",
  test: "https://fit-test.jpeak.ai",
  prod: "https://fit.jpeak.ai",
};

const LOCAL_KEY = "local-development-key-not-a-secret";
const LOCAL_EMAIL = "local@example.com";

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

export interface MintedSession {
  email: string;
  /** Sent as a cookie against a deployed environment. */
  cookie: string;
  /** Sent as headers against the local API, which has no edge in front of it. */
  headers: Record<string, string>;
}

export const mintSession = async (env: EnvName): Promise<MintedSession> => {
  const key =
    env === "local" ? LOCAL_KEY : await ssmValue(`/fit/${env}/auth/session_hmac_key`, true);
  const email =
    env === "local"
      ? LOCAL_EMAIL
      : ((await ssmValue(`/fit/${env}/auth/allowed_users`, false)).split(",")[0] ?? "").trim();

  // Ten minutes: comfortably longer than a full suite run, short enough that a
  // cookie captured from a CI log is worthless by the time anyone reads it.
  const sessionExp = Math.floor(Date.now() / 1000) + 600;
  const payload = b64url(
    Buffer.from(JSON.stringify({ email, idp: "entra", actor: "agent", exp: sessionExp })),
  );

  // The identity headers carry the EDGE's 300s window, not the session's. An
  // origin-level replay window stays short even when the session behind it is
  // longer.
  const headerExp = Math.floor(Date.now() / 1000) + 300;

  return {
    email,
    cookie: `${payload}.${hmac(key, payload)}`,
    headers: {
      "x-auth-email": email,
      "x-auth-exp": String(headerExp),
      "x-auth-sig": hmac(key, `${email}.${headerExp}`),
      "x-auth-actor": "agent",
    },
  };
};
