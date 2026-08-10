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

/**
 * Provider marks, inline.
 *
 * INLINE SVG IS NOT A STYLE CHOICE. The chooser is served by the edge function
 * before the SPA exists — on a cold environment the S3 origin may hold nothing
 * at all — so an `<img src>` or an icon font would render as a broken box on
 * exactly the page whose job is to look trustworthy enough to click.
 *
 * Both are the vendors' own marks at their official colours, which is a brand
 * requirement of theirs and not decoration: a recoloured Google "G" is a
 * violation of Google's sign-in branding rules.
 */
const ICONS = {
  google:
    `<svg width="18" height="18" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>` +
    `<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>` +
    `<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>` +
    `<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/></svg>`,
  entra:
    `<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<path d="m3.802 14.032c.388.242 1.033.511 1.715.511.621 0 1.198-.18 1.676-.487l1.807-1.129v4.073c-.286 0-.574-.078-.824-.234l-4.374-2.734Z" fill="#225086"/>` +
    `<path d="m7.853 1.507.353 8.46c-.579.654-.428 1.642.323 2.111 0 0 2.776 1.735 3.126 1.954.388.242 1.033.511 1.715.511.621 0 1.198-.18 1.676-.487l1.807-1.129-4.364-2.728 4.365-4.924V1c-.424 0-.847.169-1.147.507Z" fill="#66ddff"/>` +
    `<polygon points="4.636 10.199 4.688 10.231 9 12.927 9.001 5.276 9 5.275" fill="#cbf8ff"/>` +
    `<path d="m17.324 12.078c.751-.469.902-1.457.323-2.111l-4.921-5.551c-.397-.185-.842-.291-1.313-.291-.925 0-1.752.399-2.302 1.026l-.109.123 4.364 4.924-4.365 2.728v4.073c.287 0 .573-.078.823-.234l7.5-4.688Z" fill="#074793"/>` +
    `<path d="m9.001 1v4.275l.109-.123c.55-.627 1.377-1.026 2.302-1.026.472 0 .916.107 1.313.291l-2.579-2.909c-.299-.338-.723-.507-1.146-.507Z" fill="#0294e4"/>` +
    `<polygon points="13.365 10.199 9.001 5.276 9.001 12.926" fill="#96bcc2"/></svg>`,
};

export const PROFILES = {
  entra: {
    label: "Microsoft",
    icon: ICONS.entra,
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
    icon: ICONS.google,
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
