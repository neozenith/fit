import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { UnauthenticatedError, userKey, verifyIdentity } from "./identity.js";

const KEY = "test-key";
const NOW = 1_800_000_000_000; // fixed instant, so no test depends on wall clock

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Mints headers exactly as the edge authenticator does. */
const edgeHeaders = (email: string, expSeconds: number, key = KEY, actor?: string) => ({
  "x-auth-email": email,
  "x-auth-exp": String(expSeconds),
  "x-auth-sig": b64url(createHmac("sha256", key).update(`${email}.${expSeconds}`).digest()),
  ...(actor ? { "x-auth-actor": actor } : {}),
});

const validExp = Math.floor(NOW / 1000) + 300;

describe("a request signed by the edge is accepted", () => {
  test("the email is returned, lowercased", () => {
    const id = verifyIdentity(edgeHeaders("Person@Example.com", validExp), KEY, NOW);
    expect(id.email).toBe("person@example.com");
  });

  test("a human session is the default actor", () => {
    expect(verifyIdentity(edgeHeaders("a@b.com", validExp), KEY, NOW).actor).toBe("user");
  });

  test("an agent-minted session is distinguishable in the audit trail", () => {
    const id = verifyIdentity(edgeHeaders("a@b.com", validExp, KEY, "agent"), KEY, NOW);
    expect(id.actor).toBe("agent");
  });
});

describe("every unsigned or mis-signed request is rejected", () => {
  test("no headers at all", () => {
    expect(() => verifyIdentity({}, KEY, NOW)).toThrow(UnauthenticatedError);
  });

  test.each([
    ["x-auth-email"],
    ["x-auth-exp"],
    ["x-auth-sig"],
  ])("a request missing %s is rejected", (missing) => {
    const headers: Record<string, string | undefined> = edgeHeaders("a@b.com", validExp);
    delete headers[missing];
    expect(() => verifyIdentity(headers, KEY, NOW)).toThrow(UnauthenticatedError);
  });

  test("a forged signature", () => {
    expect(() =>
      verifyIdentity({ ...edgeHeaders("a@b.com", validExp), "x-auth-sig": "forged" }, KEY, NOW),
    ).toThrow(/does not verify/);
  });

  test("a signature made with a different key", () => {
    expect(() => verifyIdentity(edgeHeaders("a@b.com", validExp, "other-key"), KEY, NOW)).toThrow(
      /does not verify/,
    );
  });

  test("an expired identity, even with a perfectly valid signature", () => {
    const expired = Math.floor(NOW / 1000) - 1;
    expect(() => verifyIdentity(edgeHeaders("a@b.com", expired), KEY, NOW)).toThrow(/expired/);
  });

  test("a non-numeric expiry", () => {
    expect(() =>
      verifyIdentity({ ...edgeHeaders("a@b.com", validExp), "x-auth-exp": "soon" }, KEY, NOW),
    ).toThrow(/not a number/);
  });
});

describe("the signature binds email and expiry together", () => {
  test("a signature cannot be moved onto a different address", () => {
    // The attack: capture a valid header set, keep the signature and expiry,
    // swap the address. Signing the two separately would permit exactly this.
    const captured = edgeHeaders("victim@example.com", validExp);
    expect(() =>
      verifyIdentity({ ...captured, "x-auth-email": "attacker@example.com" }, KEY, NOW),
    ).toThrow(/does not verify/);
  });

  test("a signature cannot be moved onto a later expiry", () => {
    const captured = edgeHeaders("a@b.com", validExp);
    expect(() =>
      verifyIdentity({ ...captured, "x-auth-exp": String(validExp + 86400) }, KEY, NOW),
    ).toThrow(/does not verify/);
  });
});

describe("partition keys", () => {
  test("every item is scoped to its user from day one (ADR-0018)", () => {
    expect(userKey({ email: "a@b.com", actor: "user" })).toBe("USER#a@b.com");
  });
});
