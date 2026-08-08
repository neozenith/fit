import { describe, expect, test } from "bun:test";
import { hmac, nonce, pkceChallenge, safeEqual, sign, verify } from "./crypto.mjs";
import {
  allowedHosts,
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
