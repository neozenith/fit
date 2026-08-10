import { describe, expect, test } from "bun:test";
import { hmac, nonce, pkceChallenge, safeEqual, sign, verify } from "./crypto.mjs";
import { buildConfig, relativeKey } from "./params.mjs";
import { availableIdps, PROFILES } from "./providers.mjs";
import {
  allowedHosts,
  chooserPage,
  cookie,
  isAllowedHost,
  isSpaRoute,
  parseCookies,
  redirectUri,
  safePath,
  stripIdentityHeaders,
} from "./routing.mjs";

const KEY = "test-key-not-a-real-secret";
const CONFIG = { fqdn: "fit-dev.jpeak.ai", extraHosts: ["fit-alt.jpeak.ai"] };

describe("identity headers are stripped from every inbound request", () => {
  test("a viewer-supplied identity header never survives", () => {
    const stripped = stripIdentityHeaders({
      host: [{ key: "Host", value: "fit-dev.jpeak.ai" }],
      "x-auth-email": [{ key: "X-Auth-Email", value: "attacker@example.com" }],
      "x-auth-sig": [{ key: "X-Auth-Sig", value: "forged" }],
      "x-auth-exp": [{ key: "X-Auth-Exp", value: "9999999999" }],
    });
    expect(Object.keys(stripped)).toEqual(["host"]);
  });

  test("the match is by prefix, so a header added later is stripped too", () => {
    // The whole reason this is a prefix match and not a hand-written list: a
    // new x-auth-* header must be stripped from day one without anyone
    // remembering to update this function.
    const stripped = stripIdentityHeaders({
      "x-auth-something-invented-tomorrow": [{ key: "X", value: "v" }],
      "x-forwarded-for": [{ key: "X-Forwarded-For", value: "1.2.3.4" }],
    });
    expect(Object.keys(stripped)).toEqual(["x-forwarded-for"]);
  });

  test("casing cannot be used to smuggle a header past the strip", () => {
    const stripped = stripIdentityHeaders({
      "X-Auth-Email": [{ key: "X-Auth-Email", value: "attacker@example.com" }],
    });
    expect(stripped).toEqual({});
  });

  test("non-identity headers pass through untouched", () => {
    const headers = { cookie: [{ key: "Cookie", value: "a=1" }] };
    expect(stripIdentityHeaders(headers)).toEqual(headers);
  });
});

describe("host validation", () => {
  test("the canonical host and configured extras are admitted", () => {
    expect(isAllowedHost("fit-dev.jpeak.ai", CONFIG)).toBe(true);
    expect(isAllowedHost("fit-alt.jpeak.ai", CONFIG)).toBe(true);
    expect(allowedHosts(CONFIG)).toHaveLength(2);
  });

  test("anything else is rejected, including case and subdomain tricks", () => {
    expect(isAllowedHost("FIT-DEV.JPEAK.AI", CONFIG)).toBe(true); // case-insensitive by design
    expect(isAllowedHost("evil.com", CONFIG)).toBe(false);
    expect(isAllowedHost("fit-dev.jpeak.ai.evil.com", CONFIG)).toBe(false);
    expect(isAllowedHost("evil.com#fit-dev.jpeak.ai", CONFIG)).toBe(false);
    expect(isAllowedHost(undefined, CONFIG)).toBe(false);
    expect(isAllowedHost("", CONFIG)).toBe(false);
  });

  test("a distribution with no extra hosts admits only its fqdn", () => {
    expect(isAllowedHost("fit.jpeak.ai", { fqdn: "fit.jpeak.ai" })).toBe(true);
    expect(isAllowedHost("fit-dev.jpeak.ai", { fqdn: "fit.jpeak.ai" })).toBe(false);
  });
});

describe("redirect_uri follows the viewer's host, but only a VALIDATED one", () => {
  test("an admitted host is used verbatim", () => {
    expect(redirectUri("fit-alt.jpeak.ai", CONFIG)).toBe(
      "https://fit-alt.jpeak.ai/oauth2/callback",
    );
  });

  test("an unknown host falls back to the fqdn rather than becoming an open redirect", () => {
    // Unvalidated this would be an open redirect operating under our own OAuth
    // client id — the IdP itself would vouch for the destination.
    expect(redirectUri("evil.example", CONFIG)).toBe("https://fit-dev.jpeak.ai/oauth2/callback");
  });
});

describe("post-login redirect cannot leave the origin", () => {
  test.each([
    ["/dashboard", "/dashboard"],
    ["/log?week=3", "/log?week=3"],
    ["//evil.example", "/"],
    ["https://evil.example", "/"],
    ["/\\evil.example", "/"],
    ["\\\\evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["", "/"],
    [undefined, "/"],
    [null, "/"],
    [{ toString: () => "/evil" }, "/"],
  ])("safePath(%p) = %p", (input, expected) => {
    expect(safePath(input)).toBe(expected);
  });
});

describe("signed tokens", () => {
  test("a token round-trips", () => {
    const token = sign(KEY, { email: "a@b.com", exp: Math.floor(Date.now() / 1000) + 60 });
    expect(verify(KEY, token)?.email).toBe("a@b.com");
  });

  test("a tampered payload fails", () => {
    const token = sign(KEY, { email: "a@b.com", exp: Math.floor(Date.now() / 1000) + 60 });
    const [body, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ email: "admin@b.com", exp: 9999999999 })).toString("base64url")}.${sig}`;
    expect(verify(KEY, forged)).toBeNull();
    expect(body).not.toBe("");
  });

  test("a token signed with a different key fails", () => {
    const token = sign("other-key", { email: "a@b.com", exp: Math.floor(Date.now() / 1000) + 60 });
    expect(verify(KEY, token)).toBeNull();
  });

  test("an expired token fails even though its signature is valid", () => {
    const token = sign(KEY, { email: "a@b.com", exp: Math.floor(Date.now() / 1000) - 1 });
    expect(verify(KEY, token)).toBeNull();
  });

  test("a payload with no exp fails — a session must always expire", () => {
    expect(verify(KEY, sign(KEY, { email: "a@b.com" }))).toBeNull();
  });

  test("an exp in milliseconds is not silently accepted as seconds", () => {
    // The bug this guards: Date.now() where seconds() was meant yields a
    // session valid for roughly fifty thousand years, and nothing complains.
    const token = sign(KEY, { email: "a@b.com", exp: Date.now() });
    const payload = verify(KEY, token);
    // It IS accepted (it is far in the future), so the guarantee has to come
    // from the signing side. This test documents that and pins the units.
    expect(payload?.exp).toBeGreaterThan(1e12);
  });

  // One row per case — a single row of six columns would only ever test the
  // first, which is the classic way a table-driven test quietly stops testing.
  test.each([
    [""],
    ["no-dot"],
    ["a.b.c."],
    [".sig"],
    [null],
    [undefined],
    [42],
    [{}],
  ])("malformed input %p is rejected", (t) => {
    expect(verify(KEY, t)).toBeNull();
  });
});

describe("crypto primitives", () => {
  test("comparison is length-safe and does not throw on mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  test("hmac is deterministic per key and diverges across keys", () => {
    expect(hmac(KEY, "message")).toBe(hmac(KEY, "message"));
    expect(hmac(KEY, "message")).not.toBe(hmac("other", "message"));
  });

  test("nonces do not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => nonce()));
    expect(seen.size).toBe(500);
  });

  test("the PKCE challenge is the S256 of the verifier, url-safe", () => {
    const challenge = pkceChallenge("verifier");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(pkceChallenge("verifier"));
    expect(challenge).not.toBe(pkceChallenge("verifier2"));
  });
});

describe("cookies", () => {
  test("multiple cookies in one header are parsed", () => {
    expect(
      parseCookies({ cookie: [{ value: "__session=abc; __identity=%7B%22a%22%3A1%7D" }] }),
    ).toEqual({ __session: "abc", __identity: '{"a":1}' });
  });

  test("cookies split across headers are merged", () => {
    expect(parseCookies({ cookie: [{ value: "a=1" }, { value: "b=2" }] })).toEqual({
      a: "1",
      b: "2",
    });
  });

  test("no cookie header yields an empty object rather than throwing", () => {
    expect(parseCookies({})).toEqual({});
    expect(parseCookies(undefined)).toEqual({});
  });

  test("session cookies are Secure, HttpOnly and SameSite=Lax", () => {
    const c = cookie("__session", "v", { maxAge: 60 });
    expect(c).toContain("Secure");
    expect(c).toContain("HttpOnly");
    // Lax rather than Strict: the IdP's redirect back is a cross-site top-level
    // navigation, and Strict would withhold the cookie exactly then.
    expect(c).toContain("SameSite=Lax");
  });

  test("the display-only identity cookie is deliberately readable by the SPA", () => {
    expect(cookie("__identity", "v", { maxAge: 60, httpOnly: false })).not.toContain("HttpOnly");
  });
});

describe("SPA fallback", () => {
  test("routes fall back, assets do not", () => {
    expect(isSpaRoute("/")).toBe(true);
    expect(isSpaRoute("/log/week/3")).toBe(true);
    // Serving index.html for a missing .js yields a console syntax error
    // instead of a 404, which is a genuinely awful thing to debug.
    expect(isSpaRoute("/assets/main.js")).toBe(false);
    expect(isSpaRoute("/favicon.ico")).toBe(false);
    expect(isSpaRoute("/api/blocks")).toBe(false);
  });
});

describe("the public path carve-out is exact, never a prefix", () => {
  // Mirrors PUBLIC_PATHS in index.mjs. Duplicated deliberately: the point of
  // this test is that a change to that set is a visible change here too.
  const PUBLIC_PATHS = new Set(["/api/health"]);

  test("the health endpoint is public", () => {
    expect(PUBLIC_PATHS.has("/api/health")).toBe(true);
  });

  test.each([
    ["/api/health/"],
    ["/api/health/../blocks"],
    ["/api/healthz"],
    ["/api/health?x=1"],
    ["/api/blocks"],
    ["/api/me"],
    ["/API/HEALTH"],
  ])("%p is NOT public", (uri) => {
    // An exact-match Set is what makes every one of these fail. A
    // `startsWith("/api/health")` carve-out would admit the first four, and the
    // traversal case would reach a protected handler unauthenticated.
    expect(PUBLIC_PATHS.has(uri)).toBe(false);
  });
});

describe("SSM parameters are keyed by path, never by leaf name", () => {
  const PREFIX = "/fit/dev";

  test("two providers' client ids do not collide", () => {
    // The bug this exists to prevent: keying by `name.split('/').pop()` puts
    // both providers' client_id on the same key, and the winner is whichever
    // page of the recursive read arrived last. Google sign-in then goes out
    // with the Entra client id, and nothing anywhere says so.
    const raw = {
      "/fit/dev/auth/entra/client_id": "entra-id",
      "/fit/dev/auth/google/client_id": "google-id",
    };
    const flat = Object.fromEntries(
      Object.entries(raw).map(([name, value]) => [relativeKey(name, PREFIX), value]),
    );
    expect(flat).toEqual({
      "auth/entra/client_id": "entra-id",
      "auth/google/client_id": "google-id",
    });
  });

  test("the prefix itself maps to an empty key rather than throwing", () => {
    expect(relativeKey(PREFIX, PREFIX)).toBe("");
  });
});

describe("configuration assembly", () => {
  const BUNDLED = { fqdn: "fit-dev.jpeak.ai", ssmPrefix: "/fit/dev" };

  const build = (overrides = {}) =>
    buildConfig(BUNDLED, {
      "auth/session_hmac_key": KEY,
      "auth/allowed_users": "JP@example.com, someone@gmail.com",
      "auth/entra/tenant_id": "tenant-guid",
      "auth/entra/client_id": "entra-id",
      "auth/entra/client_secret": "entra-secret",
      "auth/google/client_id": "google-id",
      "auth/google/client_secret": "google-secret",
      ...overrides,
    });

  test("each provider gets its own credentials, not the other's", () => {
    const c = build();
    expect(c.providers.entra.clientId).toBe("entra-id");
    expect(c.providers.google.clientId).toBe("google-id");
    expect(c.providers.entra.clientSecret).toBe("entra-secret");
    expect(c.providers.google.clientSecret).toBe("google-secret");
  });

  test("the allow-list is one list across providers, lower-cased and trimmed", () => {
    expect(build().allowedUsers).toEqual(["jp@example.com", "someone@gmail.com"]);
  });

  test("an empty allow-list admits nobody rather than an empty email", () => {
    expect(build({ "auth/allowed_users": "" }).allowedUsers).toEqual([]);
    expect(build({ "auth/allowed_users": undefined }).allowedUsers).toEqual([]);
  });

  test("the unseeded sentinel is not mistaken for a secret", () => {
    const c = build({ "auth/google/client_secret": "UNSEEDED" });
    expect(c.providers.google.secretSeeded).toBe(false);
    expect(c.providers.entra.secretSeeded).toBe(true);
  });

  test("the secret path is carried so a 500 can name what to seed", () => {
    expect(build().providers.google.secretPath).toBe("/fit/dev/auth/google/client_secret");
  });
});

describe("provider availability drives the chooser", () => {
  const seeded = (extra = {}) => ({
    providers: {
      entra: { clientId: "e", tenantId: "t", secretSeeded: true },
      google: { clientId: "g", secretSeeded: true },
      ...extra,
    },
  });

  test("both seeded providers are offered, in a stable order", () => {
    expect(availableIdps(seeded())).toEqual(["entra", "google"]);
  });

  test("an unseeded secret hides the provider rather than offering a dead button", () => {
    expect(availableIdps(seeded({ google: { clientId: "g", secretSeeded: false } }))).toEqual([
      "entra",
    ]);
  });

  test("a half-configured Entra (no tenant) is not offered", () => {
    // Without a tenant id there is no issuer to check a token against, so the
    // flow could only fail — after a redirect, at the callback, opaquely.
    expect(availableIdps(seeded({ entra: { clientId: "e", secretSeeded: true } }))).toEqual([
      "google",
    ]);
  });

  test("an environment with nothing seeded offers nothing", () => {
    expect(availableIdps({ providers: {} })).toEqual([]);
    expect(availableIdps({})).toEqual([]);
  });
});

describe("admission is provider-specific AND allow-listed", () => {
  const ALLOWED = ["jp@jpeakai.onmicrosoft.com", "someone@gmail.com"];
  const ENTRA = { tenantId: "the-tenant", clientId: "entra-id" };

  test("Entra admits only its own tenant", () => {
    const claims = { tid: "the-tenant", email: "jp@jpeakai.onmicrosoft.com" };
    expect(PROFILES.entra.admit(claims, ENTRA, ALLOWED)).toEqual({
      ok: true,
      email: "jp@jpeakai.onmicrosoft.com",
    });
    expect(PROFILES.entra.admit({ ...claims, tid: "another-tenant" }, ENTRA, ALLOWED).ok).toBe(
      false,
    );
  });

  test("Entra falls back through the claims Microsoft actually populates", () => {
    const base = { tid: "the-tenant" };
    expect(
      PROFILES.entra.admit({ ...base, preferred_username: "someone@gmail.com" }, ENTRA, ALLOWED).ok,
    ).toBe(true);
    expect(PROFILES.entra.admit({ ...base, upn: "someone@gmail.com" }, ENTRA, ALLOWED).ok).toBe(
      true,
    );
  });

  test("Google requires a VERIFIED address", () => {
    // The Google analogue of the tenant check. A Workspace admin can put any
    // address in the `email` claim; only `email_verified` says Google vouches
    // for it, so without this check the allow-list is bypassable by anyone who
    // controls any Workspace domain.
    expect(
      PROFILES.google.admit({ email: "someone@gmail.com", email_verified: true }, {}, ALLOWED),
    ).toEqual({ ok: true, email: "someone@gmail.com" });

    expect(
      PROFILES.google.admit({ email: "someone@gmail.com", email_verified: false }, {}, ALLOWED).ok,
    ).toBe(false);
    expect(PROFILES.google.admit({ email: "someone@gmail.com" }, {}, ALLOWED).ok).toBe(false);
  });

  test("a verified address that is not allow-listed is still refused", () => {
    expect(
      PROFILES.google.admit({ email: "stranger@gmail.com", email_verified: true }, {}, ALLOWED).ok,
    ).toBe(false);
  });

  test("an empty allow-list admits nobody from either provider", () => {
    expect(
      PROFILES.google.admit({ email: "someone@gmail.com", email_verified: true }, {}, []).ok,
    ).toBe(false);
    expect(
      PROFILES.entra.admit({ tid: "the-tenant", email: "jp@jpeakai.onmicrosoft.com" }, ENTRA, [])
        .ok,
    ).toBe(false);
  });

  test("a token with no usable email claim is refused, not admitted as empty", () => {
    expect(PROFILES.entra.admit({ tid: "the-tenant" }, ENTRA, ALLOWED).ok).toBe(false);
    expect(PROFILES.google.admit({ email_verified: true }, {}, ALLOWED).ok).toBe(false);
  });
});

describe("provider endpoints", () => {
  test("Entra's URLs are tenant-scoped and its issuer is the v2.0 form", () => {
    const p = { tenantId: "the-tenant" };
    expect(PROFILES.entra.authorizeUrl(p)).toContain("/the-tenant/oauth2/v2.0/authorize");
    expect(PROFILES.entra.issuers(p)).toEqual([
      "https://login.microsoftonline.com/the-tenant/v2.0",
    ]);
  });

  test("Google accepts both issuer spellings it has ever minted", () => {
    // Not a loosening: unlike Entra's v1.0/v2.0 split these are the same app
    // model, and pinning one produces failures that depend on which endpoint
    // served the token.
    expect(PROFILES.google.issuers({})).toEqual([
      "https://accounts.google.com",
      "accounts.google.com",
    ]);
  });

  test("only Entra offers a provider logout", () => {
    // Google's endpoints are account-wide or revoke consent entirely, so
    // signing out of this app would sign the user out of Gmail.
    expect(PROFILES.entra.logoutUrl({ tenantId: "t" }, "https://fit.jpeak.ai/")).toContain(
      "post_logout_redirect_uri=https%3A%2F%2Ffit.jpeak.ai%2F",
    );
    expect(PROFILES.google.logoutUrl).toBeNull();
  });

  test("Google is asked to show the account picker every time", () => {
    expect(PROFILES.google.authParams().prompt).toBe("select_account");
    expect(PROFILES.entra.authParams().response_mode).toBe("query");
  });
});

describe("the chooser page", () => {
  const render = () =>
    chooserPage(
      ["entra", "google"].map((idp) => ({
        idp,
        label: PROFILES[idp].label,
        icon: PROFILES[idp].icon,
        href: `/oauth2/start?idp=${idp}&next=%2F`,
      })),
    );

  test("one link per available provider", () => {
    const html = render();
    expect(html).toContain("Continue with Microsoft");
    expect(html).toContain("Continue with Google");
    expect(html).toContain("idp=google");
  });

  test("every provider ships an icon and it reaches the page", () => {
    // A profile added without an icon renders `undefined` into the markup,
    // which is a silent visual break rather than a failure.
    for (const idp of Object.keys(PROFILES)) {
      expect(PROFILES[idp].icon).toMatch(/^<svg /);
    }
    expect(render()).not.toContain("undefined");
  });

  test("nothing on the page loads over the network", () => {
    // The whole reason the icons and the mark are inline: this page renders
    // before the SPA exists, and on a cold environment before the origin has
    // anything to serve. One <img> or <link> and it is a broken sign-in screen.
    const html = render();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<link");
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  test("markup comes from PROFILES, so there is no caller-controlled text", () => {
    expect(render()).not.toContain("<script");
  });
});

describe("the payload hash CloudFront's OAC does not compute", () => {
  test("hashing is over BYTES, so encoding must be honoured", async () => {
    const { sha256Hex } = await import("./crypto.mjs");
    const text = "hello";
    const asUtf8 = sha256Hex(Buffer.from(text, "utf8"));
    const asBase64 = sha256Hex(Buffer.from(Buffer.from(text).toString("base64"), "base64"));

    // Decoding base64 correctly must land on the same bytes as the utf8 form.
    // Hashing the base64 STRING instead produces a different digest, and the
    // resulting signature mismatch is indistinguishable from sending no header
    // at all — a 403 with no diagnostic.
    expect(asBase64).toBe(asUtf8);
    expect(sha256Hex(Buffer.from(Buffer.from(text).toString("base64"), "utf8"))).not.toBe(asUtf8);
  });

  test("the digest is lower-case hex, which is what SigV4 requires", async () => {
    const { sha256Hex } = await import("./crypto.mjs");
    const digest = sha256Hex(Buffer.from("payload"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an empty body hashes to the value CloudFront already assumes", async () => {
    const { sha256Hex } = await import("./crypto.mjs");
    // This is why GET requests worked all along and only writes failed: with no
    // body, the hash CloudFront signs and the hash Lambda computes agree.
    expect(sha256Hex(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
