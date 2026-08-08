import { isSeeded, loadConfig } from "./config.mjs";
import { hmac, nonce, pkceChallenge, sign, verify } from "./crypto.mjs";
import { PROFILES, verifyIdToken } from "./providers.mjs";
import {
  cookie,
  errorPage,
  headerValue,
  isAllowedHost,
  parseCookies,
  redirectUri,
  respond,
  safePath,
  setHeader,
  stripIdentityHeaders,
} from "./routing.mjs";

/**
 * The sole authenticator (ADR-0009). Runs at viewer-request on every behaviour.
 *
 * Its contract with the origin is one line: a request arriving at the origin
 * with a valid `x-auth-sig` was authenticated here, and a request arriving
 * without one was not. The origin verifies that signature and trusts nothing
 * else — it has no login code, no session store and no IdP dependency.
 */

const IDP = "entra"; // one provider (ADR-0010); PROFILES is the seam for a second

const SESSION_COOKIE = "__session";
const TXN_COOKIE = "__oauth";
const IDENTITY_COOKIE = "__identity";

/** How long an injected identity header is valid at the origin. */
const SIG_TTL_S = 300;

/**
 * The only paths that reach the origin without a session.
 *
 * An EXACT-match set, never a prefix. A prefix carve-out for `/api/health`
 * would also admit `/api/health/../blocks`, and path traversal past an
 * allow-list is precisely the bug this shape prevents.
 *
 * `/api/health` is public because it has to answer before the platform is
 * fully wired — during a cold start, from a monitor, from a deploy pipeline
 * verifying an environment came up. It exposes a boolean and an environment
 * name, and nothing else. The origin ALSO exempts it, which is not redundant:
 * the two layers are independently reachable, so each must be correct alone.
 */
const PUBLIC_PATHS = new Set(["/api/health"]);

/** The login transaction only has to survive one redirect to the IdP and back. */
const TXN_TTL_S = 600;

const seconds = () => Math.floor(Date.now() / 1000);

/**
 * Attach the identity headers the origin verifies.
 *
 * The signature covers `email.exp` together, so a header pair captured from one
 * response cannot be recombined with a different address or outlive its expiry.
 */
const injectIdentity = (request, config, session) => {
  const exp = seconds() + SIG_TTL_S;
  setHeader(request.headers, "x-auth-email", session.email);
  setHeader(request.headers, "x-auth-exp", exp);
  setHeader(request.headers, "x-auth-sig", hmac(config.sessionKey, `${session.email}.${exp}`));
  // Distinguishes an agent-minted session from a human sign-in in the audit
  // trail (ADR-0011). Signed as part of the payload, not as a bare header.
  setHeader(request.headers, "x-auth-actor", session.actor ?? "user");
  return request;
};

const redirect = (location, cookies = []) =>
  respond(302, "Found", "", {
    location,
    ...(cookies.length
      ? { "set-cookie": cookies.map((c) => ({ key: "Set-Cookie", value: c })) }
      : {}),
  });

// --- OAuth handlers ----------------------------------------------------------

const startLogin = async (config, host, next) => {
  if (!isSeeded(config.clientSecret)) {
    // Naming the parameter turns a dead environment into a one-line fix. The
    // alternative — a generic 403 — is indistinguishable from a real denial.
    return respond(
      500,
      "Misconfigured",
      errorPage(
        "Sign-in is not configured",
        `The client secret has not been seeded. Set the SSM parameter ` +
          `<code>${config.clientSecretPath}</code> and try again.`,
      ),
    );
  }

  const profile = PROFILES[IDP];
  const verifier = nonce(48);
  const loginNonce = nonce();

  // The transaction rides the browser because the edge is stateless across the
  // IdP round trip. It is signed, so the browser carries it without being able
  // to alter which provider, nonce or verifier the callback will check against.
  const txn = sign(config.sessionKey, {
    n: loginNonce,
    v: verifier,
    idp: IDP,
    h: host,
    p: safePath(next),
    exp: seconds() + TXN_TTL_S,
  });

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    // Must be byte-identical to the value sent at token exchange, which is why
    // the chosen host travels inside the signed transaction rather than being
    // re-derived from the callback's own Host header.
    redirect_uri: redirectUri(host, config),
    scope: profile.scopes,
    response_mode: "query",
    nonce: loginNonce,
    state: loginNonce,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  });

  return redirect(`${profile.authorizeUrl(config)}?${params}`, [
    cookie(TXN_COOKIE, txn, { maxAge: TXN_TTL_S }),
  ]);
};

const completeLogin = async (config, request, cookies) => {
  const query = new URLSearchParams(request.querystring ?? "");
  const profile = PROFILES[IDP];

  const txn = verify(config.sessionKey, cookies[TXN_COOKIE]);
  if (!txn) {
    return respond(
      403,
      "Forbidden",
      errorPage("Sign-in could not be completed", "The login session expired or did not match.", [
        { href: "/", label: "Start again" },
      ]),
    );
  }

  // Timing-safe by construction: `verify` already authenticated the txn, and
  // `state` is compared against a value only this browser could be holding.
  if (query.get("state") !== txn.n) {
    return respond(
      403,
      "Forbidden",
      errorPage("Sign-in could not be completed", "The login session did not match.", [
        { href: "/", label: "Start again" },
      ]),
    );
  }

  const code = query.get("code");
  if (!code) {
    return respond(
      403,
      "Forbidden",
      errorPage("Sign-in could not be completed", "The provider returned no authorization code."),
    );
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(txn.h, config),
    code_verifier: txn.v,
  });

  const tokenResponse = await fetch(profile.tokenUrl(config), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenResponse.ok) {
    return respond(
      403,
      "Forbidden",
      errorPage("Sign-in could not be completed", "The provider rejected the token exchange."),
    );
  }

  const { id_token: idToken } = await tokenResponse.json();
  const claims = await verifyIdToken(idToken, profile, config, txn.n);
  if (!claims) {
    return respond(
      403,
      "Forbidden",
      errorPage("Sign-in could not be completed", "The identity token failed verification."),
    );
  }

  const admission = profile.admit(claims, config);
  if (!admission.ok) {
    return respond(
      403,
      "Forbidden",
      errorPage("You do not have access", `Sign-in succeeded, but ${admission.reason}.`, [
        { href: "/oauth2/logout", label: "Sign out and try another account" },
      ]),
    );
  }

  const exp = seconds() + config.sessionTtlSeconds;
  const session = sign(config.sessionKey, { email: admission.email, idp: IDP, actor: "user", exp });

  return redirect(safePath(txn.p), [
    cookie(SESSION_COOKIE, session, { maxAge: config.sessionTtlSeconds }),
    // Display-only, readable by the SPA, trusted by nothing. It exists so the
    // app can render who is signed in without a round trip; it carries no
    // authority, which is exactly why it is NOT HttpOnly and NOT signed.
    cookie(IDENTITY_COOKIE, JSON.stringify({ email: admission.email, idp: IDP }), {
      maxAge: config.sessionTtlSeconds,
      httpOnly: false,
    }),
    // Clear the transaction: it has served its single purpose and leaving it
    // behind extends the window in which a captured verifier is useful.
    cookie(TXN_COOKIE, "", { maxAge: 0 }),
  ]);
};

const logout = (config, host) => {
  const post = encodeURIComponent(`https://${isAllowedHost(host, config) ? host : config.fqdn}/`);
  return redirect(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/logout` +
      `?post_logout_redirect_uri=${post}`,
    [
      cookie(SESSION_COOKIE, "", { maxAge: 0 }),
      cookie(IDENTITY_COOKIE, "", { maxAge: 0, httpOnly: false }),
      cookie(TXN_COOKIE, "", { maxAge: 0 }),
    ],
  );
};

// --- Entry point -------------------------------------------------------------

export const handler = async (event) => {
  const request = event.Records[0].cf.request;

  // FIRST. Before the host check, before config loads, before anything that
  // could throw. If this moved even one line down, a request that took an
  // early-return path would reach the origin with attacker-set identity.
  request.headers = stripIdentityHeaders(request.headers);

  const host = headerValue(request.headers, "host");
  const config = await loadConfig();

  // 421, never 403 — see routing.mjs.
  if (!isAllowedHost(host, config)) {
    return respond(
      421,
      "Misdirected Request",
      errorPage("Wrong address", "This distribution does not serve that hostname."),
    );
  }

  const uri = request.uri ?? "/";
  const cookies = parseCookies(request.headers);

  if (uri.startsWith("/oauth2/")) {
    if (uri === "/oauth2/logout") return logout(config, host);
    if (uri === "/oauth2/callback") return completeLogin(config, request, cookies);
    if (uri === "/oauth2/start") {
      return startLogin(config, host, new URLSearchParams(request.querystring ?? "").get("next"));
    }
    return respond(404, "Not Found", errorPage("Not found", "No such sign-in route."));
  }

  // AFTER the header strip and the host check, so a public path is still
  // reached only on an admitted host and still cannot carry a forged identity.
  // Before the session check, because it must answer without one.
  if (PUBLIC_PATHS.has(uri)) return request;

  const session = verify(config.sessionKey, cookies[SESSION_COOKIE]);
  if (session?.email) return injectIdentity(request, config, session);

  // Unauthenticated. With one provider there is nothing to choose between, so
  // the redirect goes straight to the authorize URL (ADR-0010).
  //
  // An API call gets a 401 instead of a redirect: following a 302 to Microsoft
  // from `fetch` produces an opaque CORS failure that tells the SPA nothing,
  // whereas a 401 is something it can act on.
  if (uri.startsWith("/api/")) {
    return respond(401, "Unauthorized", JSON.stringify({ error: "not_authenticated" }), {
      "content-type": "application/json",
    });
  }

  const next = encodeURIComponent(uri + (request.querystring ? `?${request.querystring}` : ""));
  return redirect(`https://${host}/oauth2/start?next=${next}`);
};
