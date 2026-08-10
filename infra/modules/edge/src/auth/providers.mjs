import { createPublicKey, createVerify } from "node:crypto";
import { b64urlDecode } from "./crypto.mjs";

/**
 * The provider surface. Everything provider-specific lives in `PROFILES` and
 * nowhere else — adding an IdP is one entry here plus its SSM shells
 * (ADR-0035), not a refactor of the flow.
 *
 * Every function here takes `p`, the config for ONE provider
 * (`config.providers.entra`), never the whole config. That is what keeps a
 * profile unable to read another provider's client id or secret by accident —
 * the flat `cfg.clientId` of the single-provider design would have silently
 * resolved to whichever provider happened to load last.
 */

export const PROFILES = {
  entra: {
    label: "Microsoft",
    /**
     * A provider is offered only when its own credentials are present. The
     * tenant id is the discriminator that cannot be defaulted — an EntraID
     * flow without one has no issuer to check against, so half-seeding an
     * environment hides the provider rather than producing a broken button.
     */
    configured: (p) => Boolean(p.tenantId && p.clientId),

    authorizeUrl: (p) => `https://login.microsoftonline.com/${p.tenantId}/oauth2/v2.0/authorize`,
    tokenUrl: (p) => `https://login.microsoftonline.com/${p.tenantId}/oauth2/v2.0/token`,
    jwksUrl: (p) => `https://login.microsoftonline.com/${p.tenantId}/discovery/v2.0/keys`,
    // v2.0 tokens carry this exact issuer; the v1.0 endpoint issues a different
    // one, and accepting both would accept tokens minted for a different app model.
    issuers: (p) => [`https://login.microsoftonline.com/${p.tenantId}/v2.0`],
    scopes: "openid profile email",
    // Entra honours response_mode; asking for `query` keeps the code out of a
    // fragment the edge could not read.
    authParams: () => ({ response_mode: "query" }),

    /**
     * Entra supports RP-initiated logout, so signing out here also ends the
     * session at the provider — otherwise "sign out and try another account"
     * silently signs back in as the same person.
     */
    logoutUrl: (p, returnTo) =>
      `https://login.microsoftonline.com/${p.tenantId}/oauth2/v2.0/logout` +
      `?post_logout_redirect_uri=${encodeURIComponent(returnTo)}`,

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
     * internet (ADR-0010, carried forward by ADR-0035).
     */
    admit: (claims, p, allowedUsers) => {
      if (claims.tid !== p.tenantId) {
        return { ok: false, reason: "token was issued by a different directory" };
      }
      const email = PROFILES.entra.emailFrom(claims);
      if (!email) return { ok: false, reason: "token carries no usable email claim" };
      if (!allowedUsers.includes(email)) {
        return { ok: false, reason: "address is not on the allow-list" };
      }
      return { ok: true, email };
    },
  },

  google: {
    label: "Google",
    configured: (p) => Boolean(p.clientId),

    authorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: () => "https://oauth2.googleapis.com/token",
    jwksUrl: () => "https://www.googleapis.com/oauth2/v3/certs",
    /**
     * Google mints BOTH spellings and has done for years — the bare-host form
     * is the older one and still appears. Accepting exactly these two is not a
     * loosening: neither is a different app model, unlike Entra's v1.0/v2.0
     * split, and pinning only one produces intermittent failures that depend on
     * which endpoint served the token.
     */
    issuers: () => ["https://accounts.google.com", "accounts.google.com"],
    scopes: "openid email profile",
    /**
     * `select_account` every time. Google silently reuses the single signed-in
     * session otherwise, which makes "sign out and try another account"
     * impossible to act on — and Google offers no RP-initiated logout to fix it
     * from the other end (see `logoutUrl`).
     */
    authParams: () => ({ prompt: "select_account" }),

    /**
     * NO provider logout, deliberately. Google's only sign-out endpoints are
     * account-wide (`/Logout`) or revoke the grant entirely — the first signs
     * the user out of Gmail as a side effect of leaving this app, and the
     * second forces a fresh consent screen on the next visit. Clearing our own
     * cookies is the correct scope; `prompt=select_account` covers the account
     * switch that logout would otherwise have provided.
     */
    logoutUrl: null,

    emailFrom: (claims) => (claims.email || "").toLowerCase(),

    /**
     * `email_verified` is the Google analogue of Entra's `tid` check, and it is
     * load-bearing for the same reason. A Google Workspace administrator can
     * create an account with an arbitrary `email` claim; only `email_verified`
     * separates an address Google vouches for from one it merely carries. Both
     * checks, always.
     */
    admit: (claims, _p, allowedUsers) => {
      if (claims.email_verified !== true && claims.email_verified !== "true") {
        return { ok: false, reason: "Google has not verified that address" };
      }
      const email = PROFILES.google.emailFrom(claims);
      if (!email) return { ok: false, reason: "token carries no usable email claim" };
      if (!allowedUsers.includes(email)) {
        return { ok: false, reason: "address is not on the allow-list" };
      }
      return { ok: true, email };
    },
  },
};

/**
 * The providers this environment can actually offer, in a stable order.
 *
 * Derived from what is seeded rather than from a list, so an environment that
 * has only ever had one provider behaves exactly as it did before a second was
 * added — no chooser, no dead button (ADR-0035).
 */
export const availableIdps = (config) =>
  Object.keys(PROFILES).filter((idp) => {
    const p = config.providers?.[idp];
    return Boolean(p) && PROFILES[idp].configured(p) && p.secretSeeded;
  });

// --- JWKS --------------------------------------------------------------------

const jwksCache = new Map();
const JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * Fetch and cache a provider's signing keys.
 *
 * The cache is per sandbox, keyed by URL so two providers never share an entry,
 * and lives an hour. Both Microsoft and Google rotate on a multi-day cadence
 * and publish replacements well ahead of use, so an hour is comfortably inside
 * the overlap window; a cache miss on a genuinely new key costs one extra HTTPS
 * round trip on one request.
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
 *
 * `p` is ONE provider's config. The audience is checked against that provider's
 * client id, so a token minted for the Google client cannot be presented as an
 * Entra login and vice versa.
 */
export const verifyIdToken = async (idToken, profile, p, expectedNonce) => {
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

  // Never trust the token's own `alg`. RS256 is what both providers issue, and
  // pinning it here is what makes an `alg: none` or HS256-with-the-public-key
  // substitution impossible rather than merely unlikely.
  if (header.alg !== "RS256") return null;

  const keys = await fetchJwks(profile.jwksUrl(p));
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  if (!verifier.verify(jwkToPem(jwk), b64urlDecode(signatureB64))) return null;

  const now = Math.floor(Date.now() / 1000);
  // 60 seconds of skew: enough for ordinary clock drift between a provider's
  // signer and a CloudFront edge, far too little to be useful for replay.
  if (typeof claims.exp !== "number" || claims.exp + 60 < now) return null;
  if (typeof claims.iat === "number" && claims.iat - 60 > now) return null;
  if (!profile.issuers(p).includes(claims.iss)) return null;
  if (claims.aud !== p.clientId) return null;
  // Binds the token to THIS login attempt. Without it, a token obtained in any
  // other session for the same app is replayable here.
  if (expectedNonce && claims.nonce !== expectedNonce) return null;

  return claims;
};
