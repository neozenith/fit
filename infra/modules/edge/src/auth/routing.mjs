/**
 * Pure helpers for the edge authenticator: header manipulation, host
 * validation, cookie parsing, redirect safety.
 *
 * Everything here is deliberately free of I/O so it can be unit-tested without
 * a CloudFront event, an IdP, or AWS credentials. `index.mjs` holds the parts
 * that genuinely need the network.
 */

/**
 * Remove every `x-auth-*` header from an inbound request.
 *
 * THIS RUNS BEFORE ANY OTHER LOGIC, on every path, in every mode. CloudFront
 * forwards viewer headers to the origin verbatim, so a caller who sets
 * `x-auth-email: someone@example.com` would be that person at the origin unless
 * this strips it first. A header the function sets but forgets to strip is a
 * free privilege escalation (ADR-0009).
 *
 * The prefix match is the point: stripping a hand-written list means the next
 * header added to the injection set is un-stripped until someone remembers.
 */
export const stripIdentityHeaders = (headers) => {
  const cleaned = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase().startsWith("x-auth-")) continue;
    cleaned[key] = value;
  }
  return cleaned;
};

/** CloudFront's header shape: lowercase key -> [{ key, value }]. */
export const headerValue = (headers, name) => headers?.[name.toLowerCase()]?.[0]?.value;

export const setHeader = (headers, name, value) => {
  headers[name.toLowerCase()] = [{ key: name, value: String(value) }];
  return headers;
};

/**
 * The set of hostnames this distribution answers on.
 *
 * Anything else gets a 421, never a 403 — the SPA's error rewrite turns a 403
 * into `index.html`, which would launder a rejected host into a served
 * application (ADR-0009).
 */
export const allowedHosts = (config) =>
  [config.fqdn, ...(config.extraHosts ?? [])].filter(Boolean).map((h) => h.toLowerCase());

export const isAllowedHost = (host, config) =>
  typeof host === "string" && allowedHosts(config).includes(host.toLowerCase());

/**
 * Choose the redirect URI for the OAuth round trip.
 *
 * It follows the VIEWER's host rather than the configured `fqdn`, so an
 * environment reachable on more than one name still works — but only after the
 * host has been validated against the same allow-list the 421 gate uses.
 * Unvalidated, this would be an open redirect operating under our own client
 * id, which is the worst kind: the IdP itself would vouch for it.
 */
export const redirectUri = (host, config) =>
  `https://${isAllowedHost(host, config) ? host : config.fqdn}/oauth2/callback`;

export const parseCookies = (headers) => {
  const out = {};
  for (const entry of headers?.cookie ?? []) {
    for (const pair of String(entry.value).split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      out[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1).trim());
    }
  }
  return out;
};

export const cookie = (name, value, { maxAge, httpOnly = true }) =>
  [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "Secure",
    // `Lax`, not `Strict`: the IdP redirects the browser back to
    // `/oauth2/callback` as a cross-site top-level navigation, and `Strict`
    // would withhold the transaction cookie exactly then — the login would
    // fail with a nonce mismatch that looks like an attack.
    "SameSite=Lax",
    httpOnly ? "HttpOnly" : null,
    `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join("; ");

/**
 * Constrain a post-login redirect to a path within this site.
 *
 * Anything protocol-relative (`//evil.example`), absolute, or backslashed is
 * discarded in favour of the root. Returning the root on doubt is the whole
 * defence: there is no input a caller can craft that leaves the origin.
 */
export const safePath = (raw) => {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.includes("\\")) return "/";
  return raw;
};

/**
 * Paths the SPA owns, which must fall back to `index.html` rather than 404.
 *
 * A request for an asset (anything with a file extension) must NOT fall back —
 * serving `index.html` for a missing `.js` produces a syntax error in the
 * console instead of a 404, which is a genuinely awful thing to debug.
 */
export const isSpaRoute = (uri) => !/\.[a-z0-9]+$/i.test(uri) && !uri.startsWith("/api/");

/** A response object in CloudFront's shape. */
export const respond = (status, statusDescription, body, headers = {}) => ({
  status: String(status),
  statusDescription,
  headers: Object.fromEntries(
    Object.entries({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    }).map(([k, v]) => [k, Array.isArray(v) ? v : [{ key: k, value: String(v) }]]),
  ),
  body,
});

/**
 * A minimal error page.
 *
 * Deliberately styleless and dependency-free: it renders before any asset has
 * loaded and, in the misconfiguration case, before the origin is reachable at
 * all. `reason` is operator-facing text and never echoes anything the caller
 * supplied.
 */
export const chooserPage = (choices) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Sign in</title>` +
  `<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;` +
  `background:#0f1115;color:#e6e8eb}main{max-width:20rem;width:100%;padding:2rem}h1{font-size:1.25rem;margin:0 0 1rem}` +
  `a{display:block;padding:.75rem 1rem;margin:0 0 .5rem;border:1px solid #2a2f3a;border-radius:.5rem;` +
  `color:#e6e8eb;text-decoration:none;text-align:center}a:hover{border-color:#7aa2f7}</style>` +
  `<main><h1>Sign in</h1>` +
  // The label comes from PROFILES, never from the request, so there is nothing
  // here for a caller to inject. Same for href: the idp key is already known to
  // be one of ours because it survived the availability filter.
  choices.map((c) => `<a href="${c.href}">Continue with ${c.label}</a>`).join("") +
  `</main>`;

export const errorPage = (title, reason, links = []) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title>` +
  `<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;` +
  `background:#0f1115;color:#e6e8eb}main{max-width:34rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}` +
  `p{color:#9aa3ad;margin:0 0 1rem}a{color:#7aa2f7}</style>` +
  `<main><h1>${title}</h1><p>${reason}</p>` +
  links.map((l) => `<p><a href="${l.href}">${l.label}</a></p>`).join("") +
  `</main>`;
