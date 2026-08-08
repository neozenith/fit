import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signing primitives shared by the session cookie, the transaction cookie and
 * the identity headers. One key signs all of them, so one rotation revokes all
 * of them — see ADR-0011.
 */

/** URL-safe base64 without padding, so a value survives a cookie and a query string. */
export const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const b64urlDecode = (str) =>
  Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export const hmac = (key, message) => b64url(createHmac("sha256", key).update(message).digest());

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak length
 * — so unequal lengths return false before it is reached, and the comparison
 * that does run is over equal-length buffers.
 */
export const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

/**
 * Sign a JSON payload into a `<base64url-payload>.<signature>` token.
 *
 * Deliberately not a JWT. A JWT carries its algorithm in a header the verifier
 * is expected to honour, which is the root of the entire `alg: none` family of
 * bugs. Here the algorithm is not negotiable because it is not transmitted.
 */
export const sign = (key, payload) => {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(key, body)}`;
};

/**
 * Verify and decode a token produced by `sign`.
 *
 * Returns `null` for anything that is not a valid, unexpired token. Every
 * failure path returns the same `null` — a caller cannot distinguish "bad
 * signature" from "expired" from "malformed", and so cannot be used as an
 * oracle for either.
 */
export const verify = (key, token, { now = Date.now() } = {}) => {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, hmac(key, body))) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8"));
  } catch {
    return null;
  }

  // `exp` is seconds since epoch, matching the OIDC convention the ID token
  // itself uses — mixing seconds and milliseconds here would produce a session
  // valid for 50,000 years, which is exactly the kind of bug that never
  // announces itself.
  if (typeof payload?.exp !== "number" || payload.exp * 1000 <= now) return null;
  return payload;
};

export const nonce = (bytes = 32) => b64url(randomBytes(bytes));

/** PKCE S256 challenge for a verifier. */
export const pkceChallenge = (verifier) => b64url(createHash("sha256").update(verifier).digest());
