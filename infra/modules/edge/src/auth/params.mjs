/**
 * Turning a flat SSM read into the authenticator's configuration.
 *
 * Pure, and separated from `config.mjs` for the same reason `routing.mjs` is
 * separated from `index.mjs`: `config.mjs` imports the Terraform-synthesized
 * `config.json`, which does not exist in the source tree, so anything living
 * there cannot be unit-tested at all.
 */

/** Sentinel values written by Terraform for parameters it must never own. */
const UNSEEDED = new Set(["UNSEEDED", "PLACEHOLDER", ""]);

export const isSeeded = (value) => value !== undefined && !UNSEEDED.has(value);

/**
 * Key a parameter by its path RELATIVE to the prefix, not by its leaf name.
 *
 * This is what makes a second provider possible at all. Keying by leaf collapses
 * `/auth/entra/client_id` and `/auth/google/client_id` onto the same `client_id`,
 * and the winner is whichever page of the recursive read arrived last — a Google
 * sign-in attempted with the Entra client id, with nothing in any log saying so.
 */
export const relativeKey = (name, prefix) => name.slice(prefix.length).replace(/^\//, "");

/**
 * Assemble one provider's slice of the configuration.
 *
 * `secretPath` is carried so the misconfiguration page can name the exact
 * parameter to seed — a dead environment becomes a one-line fix rather than an
 * indistinguishable 403. `secretSeeded` is computed here so that no caller has
 * to remember which sentinel Terraform writes.
 */
const providerConfig = (p, idp, prefix) => ({
  clientId: p[`auth/${idp}/client_id`],
  clientSecret: p[`auth/${idp}/client_secret`],
  secretSeeded: isSeeded(p[`auth/${idp}/client_secret`]),
  secretPath: `${prefix}/auth/${idp}/client_secret`,
  tenantId: p[`auth/${idp}/tenant_id`],
});

export const buildConfig = (bundled, p) => ({
  ...bundled,
  providers: {
    entra: providerConfig(p, "entra", bundled.ssmPrefix),
    google: providerConfig(p, "google", bundled.ssmPrefix),
  },
  sessionKey: p["auth/session_hmac_key"],
  // An empty allow-list must admit NOBODY (ADR-0010). `filter(Boolean)` is
  // what makes `"".split(",")` produce `[]` instead of `[""]` — without it an
  // empty parameter would admit an empty email, which some IdP edge cases
  // can actually produce.
  //
  // ONE list across providers, matched on the verified address. An address is
  // admitted whichever provider vouches for it, and a provider that vouches for
  // an address not on the list admits nobody (ADR-0035).
  allowedUsers: (p["auth/allowed_users"] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  sessionTtlSeconds: Number(p["auth/session_ttl_seconds"] ?? 28800),
});
