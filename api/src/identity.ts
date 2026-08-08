import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The origin half of ADR-0009.
 *
 * The edge authenticator is the only thing that authenticates. This module's
 * entire job is to answer one question — "was this request signed by the edge,
 * recently, for this address?" — and to trust nothing else about it.
 *
 * There is no login code here, no session store, and no identity provider
 * dependency. That is the point.
 */

export interface Identity {
  email: string;
  /** `"user"` for a human sign-in, `"agent"` for a minted test session (ADR-0011). */
  actor: string;
}

export class UnauthenticatedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UnauthenticatedError";
  }
}

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const sign = (key: string, message: string): string =>
  b64url(createHmac("sha256", key).update(message).digest());

/**
 * Constant-time comparison that tolerates unequal lengths.
 *
 * `timingSafeEqual` throws when the buffers differ in length, which would both
 * crash the handler and leak the length through the error path.
 */
const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

/**
 * Verify the identity headers the edge injected.
 *
 * The signature covers `email.exp` as one string. Signing them separately, or
 * signing only the email, would let a header pair captured from one response be
 * recombined with a different address or replayed past its expiry — the exact
 * two attacks the binding exists to prevent.
 *
 * Throws rather than returning null: an unauthenticated request is not a case
 * the caller should be able to forget to handle.
 */
export const verifyIdentity = (
  headers: Record<string, string | undefined>,
  sessionKey: string,
  now: number = Date.now(),
): Identity => {
  const email = headers["x-auth-email"];
  const exp = headers["x-auth-exp"];
  const signature = headers["x-auth-sig"];

  if (!email || !exp || !signature) {
    throw new UnauthenticatedError("request carries no edge-signed identity");
  }

  const expiry = Number(exp);
  if (!Number.isFinite(expiry)) {
    throw new UnauthenticatedError("identity expiry is not a number");
  }

  // Expiry is checked BEFORE the signature deliberately: it is the cheaper
  // check, and a valid signature on an expired header is still a rejection, so
  // there is nothing to gain by proving the signature first.
  if (expiry * 1000 <= now) {
    throw new UnauthenticatedError("identity has expired");
  }

  if (!safeEqual(signature, sign(sessionKey, `${email}.${expiry}`))) {
    throw new UnauthenticatedError("identity signature does not verify");
  }

  return { email: email.toLowerCase(), actor: headers["x-auth-actor"] ?? "user" };
};

/**
 * The partition key for every item this user owns.
 *
 * Keyed by user from day one even though exactly one user is admitted
 * (ADR-0018), so multi-user later is a policy change rather than a migration.
 */
export const userKey = (identity: Identity): string => `USER#${identity.email}`;
