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
/**
 * The `fit` mark, inline.
 *
 * A COPY, and deliberately so. The canonical asset is
 * `frontend/public/brand/fit-mark-themed.svg`, which cannot be referenced here
 * for two independent reasons: an `<img src="/brand/…">` is a second request to
 * this same distribution, which arrives with no session and is redirected
 * straight back to this page — a broken image on the sign-in screen — and on a
 * cold environment the SPA bucket may hold nothing at all.
 *
 * The source file carries its palette as `:root` custom properties under a
 * `prefers-color-scheme` query. Inlining that verbatim would redefine `:root`
 * for the whole page, so the dark values are resolved into the paths here and
 * the `<style>` block dropped. These edge pages are dark-only regardless.
 */
const MARK =
  `<svg viewBox="0 0 512 512" width="56" height="56" role="img" aria-label="fit">` +
  `<rect width="512" height="512" rx="96" fill="#101010"/>` +
  `<g fill="#3a2a63"><path d="M-8 402L118 104L244 402Z"/><path d="M102 402L252 60L402 402Z"/>` +
  `<path d="M264 402L404 30L544 402Z"/></g>` +
  `<g fill="#6b52ab"><path d="M-44 402L60 238L164 402Z"/><path d="M93.9 402L168.4 113.9L242.9 402Z"/>` +
  `<path d="M252.2 402L345 39.9L437.8 402Z"/><path d="M338 402L438 210L538 402Z"/></g>` +
  `<g fill="#b79bff"><path d="M8 402L126 300L244 402Z"/><path d="M150 402L288 258L426 402Z"/>` +
  `<path d="M320 402L424 302L528 402Z"/></g>` +
  `<polyline points="30,352 104,282 166,322 254.4,121.5 345,76" fill="none" stroke-linecap="round" ` +
  `stroke-linejoin="round" stroke="#dccbff" stroke-width="20"/>` +
  `<circle cx="30" cy="352" r="20" fill="#dccbff"/><circle cx="104" cy="282" r="20" fill="#dccbff"/>` +
  `<circle cx="166" cy="322" r="20" fill="#dccbff"/><circle cx="345" cy="76" r="20" fill="#dccbff"/>` +
  `<circle cx="254.4" cy="121.5" r="27" fill="#e9b26a"/></svg>`;

/**
 * The provider chooser.
 *
 * Styleless in the sense that matters — no stylesheet, no font, no image
 * request. Every byte it needs is in this response, because it renders before
 * the SPA exists and, on a cold environment, before the origin has anything to
 * serve.
 */
export const chooserPage = (choices) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Sign in — fit</title>` +
  `<style>body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;display:grid;` +
  `place-items:center;min-height:100vh;padding:1.5rem;background:#0f1115;color:#e6e8eb}` +
  `main{width:100%;max-width:22rem;padding:2rem 1.75rem;background:#15181f;border:1px solid #2a2f3a;` +
  `border-radius:1rem;text-align:center}h1{font-size:1.125rem;font-weight:600;margin:1.25rem 0 .25rem}` +
  `p{font-size:.8125rem;color:#9aa3ad;margin:0 0 1.5rem}` +
  `a{display:flex;align-items:center;justify-content:center;gap:.625rem;padding:.7rem 1rem;margin:0 0 .75rem;` +
  `border:1px solid #2a2f3a;border-radius:.625rem;background:#1b1f28;color:#e6e8eb;font-size:.875rem;` +
  `font-weight:500;text-decoration:none}a:last-child{margin-bottom:0}` +
  `a:hover{background:#212633;border-color:#7aa2f7}` +
  `.ico{display:inline-flex;width:18px;height:18px}</style>` +
  `<main>${MARK}<h1>fit</h1><p>Sign in to continue</p>` +
  // Label, icon and idp key all come from PROFILES, never from the request, so
  // there is nothing here for a caller to inject. The href's idp is already
  // known to be one of ours because it survived the availability filter.
  choices
    .map(
      (c) =>
        `<a href="${c.href}"><span class="ico">${c.icon}</span><span>Continue with ${c.label}</span></a>`,
    )
    .join("") +
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
