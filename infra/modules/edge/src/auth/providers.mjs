import { createPublicKey, createVerify } from "node:crypto";
import { b64urlDecode } from "./crypto.mjs";

/**
 * The provider surface. Everything provider-specific lives in `PROFILES` and
 * nowhere else — adding a second IdP is one entry here plus its SSM shells
 * (ADR-0010), not a refactor of the flow.
 */

export const PROFILES = {
  entra: {
    label: "Microsoft",
    authorizeUrl: (cfg) =>
      `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize`,
    tokenUrl: (cfg) => `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    jwksUrl: (cfg) => `https://login.microsoftonline.com/${cfg.tenantId}/discovery/v2.0/keys`,
    // v2.0 tokens carry this exact issuer; the v1.0 endpoint issues a different
    // one, and accepting both would accept tokens minted for a different app model.
    issuer: (cfg) => `https://login.microsoftonline.com/${cfg.tenantId}/v2.0`,
    scopes: "openid profile email",

    /**
     * Microsoft puts the address in different claims depending on how the
     * account was created: a work account has `preferred_username`, a personal
     * account may only have `email`, and a guest may only have `upn`. Checking
     * all three in a fixed order is the difference between "works" and "works
     * for the account you happened to test with".
     */
    emailFrom: (claims) =>
      (claims.email || claims.preferred_username || claims.upn || "").toLowerCase(),

    /**
     * BOTH checks, always. The tenant check alone admits every account in the
     * directory, which for a personal application is the same as admitting the
     * internet (ADR-0010).
     */
    admit: (claims, cfg) => {
      if (claims.tid !== cfg.tenantId) {
        return { ok: false, reason: "token was issued by a different directory" };
      }
      const email = PROFILES.entra.emailFrom(claims);
      if (!email) return { ok: false, reason: "token carries no usable email claim" };
      if (!cfg.allowedUsers.includes(email)) {
        return { ok: false, reason: "address is not on the allow-list" };
      }
      return { ok: true, email };
    },
  },
};

// --- JWKS --------------------------------------------------------------------

const jwksCache = new Map();
const JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * Fetch and cache a provider's signing keys.
 *
 * The cache is per sandbox and lives an hour. Microsoft rotates keys on a
 * multi-day cadence and publishes replacements well ahead of use, so an hour is
 * comfortably inside the overlap window; a cache miss on a genuinely new key
 * costs one extra HTTPS round trip on one request.
 */
const fetchJwks = async (url) => {
  const cached = jwksCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.keys;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);
  const { keys } = await response.json();
  jwksCache.set(url, { keys, expires: Date.now() + JWKS_TTL_MS });
  return keys;
};

const jwkToPem = (jwk) => createPublicKey({ key: jwk, format: "jwk" });

/**
 * Verify an ID token end to end: signature, issuer, audience, expiry, nonce.
 *
 * Order matters. The signature is checked FIRST, because every claim after it
 * is attacker-controlled until it passes. Returns `null` on any failure — the
 * caller turns that into one indistinguishable 403.
 */
export const verifyIdToken = async (idToken, profile, cfg, expectedNonce) => {
  const parts = String(idToken).split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let claims;
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString("utf8"));
    claims = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }

  // Never trust the token's own `alg`. RS256 is what the provider issues, and
  // pinning it here is what makes an `alg: none` or HS256-with-the-public-key
  // substitution impossible rather than merely unlikely.
  if (header.alg !== "RS256") return null;

  const keys = await fetchJwks(profile.jwksUrl(cfg));
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  if (!verifier.verify(jwkToPem(jwk), b64urlDecode(signatureB64))) return null;

  const now = Math.floor(Date.now() / 1000);
  // 60 seconds of skew: enough for ordinary clock drift between Microsoft's
  // signer and a CloudFront edge, far too little to be useful for replay.
  if (typeof claims.exp !== "number" || claims.exp + 60 < now) return null;
  if (typeof claims.iat === "number" && claims.iat - 60 > now) return null;
  if (claims.iss !== profile.issuer(cfg)) return null;
  if (claims.aud !== cfg.clientId) return null;
  // Binds the token to THIS login attempt. Without it, a token obtained in any
  // other session for the same app is replayable here.
  if (expectedNonce && claims.nonce !== expectedNonce) return null;

  return claims;
};
