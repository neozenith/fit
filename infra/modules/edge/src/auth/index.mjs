import { loadConfig } from "./config.mjs";
import { hmac, nonce, pkceChallenge, sha256Hex, sign, verify } from "./crypto.mjs";
import { availableIdps, PROFILES, verifyIdToken } from "./providers.mjs";
import {
  chooserPage,
  cookie,
  errorPage,
  headerValue,
  isAllowedHost,
  isSpaRoute,
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
 * Supply the payload hash CloudFront's SigV4 signature needs for a Lambda
 * Function URL origin.
 *
 * WITHOUT THIS, EVERY WRITE FAILS. CloudFront's origin access control signs
 * requests to a Lambda origin, but it does NOT hash the request body — it signs
 * as though the payload were empty. Lambda then computes the hash of the body
 * it actually received, the two disagree, and it answers **403**. `GET` works
 * throughout, because an empty body hashes to the value CloudFront assumed, so
 * the failure looks like "writes are broken" rather than "signing is
 * misconfigured".
 *
 * The fix AWS documents is to compute the hash at the edge and send it as
 * `x-amz-content-sha256`, which CloudFront then includes in what it signs.
 * That requires `include_body` on the function association — a viewer-request
 * function cannot see the body otherwise.
 *
 * The body arrives either as UTF-8 text or base64, and hashing the wrong
 * interpretation produces a signature mismatch indistinguishable from having no
 * header at all — so the encoding flag is honoured rather than assumed.
 */
const signPayload = (request) => {
  const body = request.body;
  if (!body?.data) return;

  const bytes =
    body.encoding === "base64" ? Buffer.from(body.data, "base64") : Buffer.from(body.data, "utf8");

  setHeader(request.headers, "x-amz-content-sha256", sha256Hex(bytes));
};

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

/**
 * Nothing is seeded, so there is nothing to sign in with.
 *
 * Naming the parameters turns a dead environment into a one-line fix. The
 * alternative — a generic 403 — is indistinguishable from a real denial. Every
 * provider with a client id is listed, because which one the operator meant to
 * seed is not knowable from here.
 */
const misconfigured = (config) => {
  const pending = Object.entries(config.providers ?? {})
    .filter(([idp, p]) => PROFILES[idp].configured(p))
    .map(([, p]) => `<code>${p.secretPath}</code>`);

  return respond(
    500,
    "Misconfigured",
    errorPage(
      "Sign-in is not configured",
      pending.length === 0
        ? "No identity provider is configured for this environment."
        : `No client secret has been seeded. Set one of ${pending.join(" or ")} and try again.`,
    ),
  );
};

/**
 * Resolve which provider a sign-in should use.
 *
 * A caller-supplied `idp` is honoured ONLY if it names a configured provider —
 * an unknown value falls through to the chooser rather than erroring, because
 * the value reaches us from a link the user may have bookmarked before a
 * provider was retired.
 *
 * With exactly one provider available the chooser is skipped entirely, which is
 * what preserves the original single-provider behaviour (ADR-0010) unchanged in
 * an environment where only Entra is seeded.
 */
const chooseIdp = (config, requested) => {
  const available = availableIdps(config);
  if (requested && available.includes(requested)) return requested;
  if (available.length === 1) return available[0];
  return null;
};

const startLogin = async (config, host, next, requested) => {
  const available = availableIdps(config);
  if (available.length === 0) return misconfigured(config);

  const idp = chooseIdp(config, requested);
  if (!idp) {
    // More than one provider and no choice made. The chooser is the ONLY place
    // this decision happens; every other path already has an `idp` in hand.
    return respond(
      200,
      "OK",
      chooserPage(
        available.map((k) => ({
          idp: k,
          label: PROFILES[k].label,
          icon: PROFILES[k].icon,
          href: `/oauth2/start?idp=${k}&next=${encodeURIComponent(safePath(next))}`,
        })),
      ),
    );
  }

  // Both are guaranteed present: `idp` came from `availableIdps`, which already
  // required a configured profile and a seeded secret.
  const profile = PROFILES[idp];
  const provider = config.providers[idp];

  const verifier = nonce(48);
  const loginNonce = nonce();

  // The transaction rides the browser because the edge is stateless across the
  // IdP round trip. It is signed, so the browser carries it without being able
  // to alter which provider, nonce or verifier the callback will check against.
  //
  // `idp` inside the signature is what makes two providers safe on one callback
  // URL: the callback uses the provider the START chose, never one the query
  // string names, so a code minted by one provider cannot be redeemed against
  // the other's token endpoint and client secret.
  const txn = sign(config.sessionKey, {
    n: loginNonce,
    v: verifier,
    idp,
    h: host,
    p: safePath(next),
    exp: seconds() + TXN_TTL_S,
  });

  const params = new URLSearchParams({
    client_id: provider.clientId,
    response_type: "code",
    // Must be byte-identical to the value sent at token exchange, which is why
    // the chosen host travels inside the signed transaction rather than being
    // re-derived from the callback's own Host header.
    redirect_uri: redirectUri(host, config),
    scope: profile.scopes,
    nonce: loginNonce,
    state: loginNonce,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    ...profile.authParams(),
  });

  return redirect(`${profile.authorizeUrl(provider)}?${params}`, [
    cookie(TXN_COOKIE, txn, { maxAge: TXN_TTL_S }),
  ]);
};

const completeLogin = async (config, request, cookies) => {
  const query = new URLSearchParams(request.querystring ?? "");

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

  // The provider comes from the SIGNED transaction, never from the query
  // string. A callback that could name its own provider would let a code minted
  // by one IdP be exchanged at the other's token endpoint, under the other's
  // client secret.
  const profile = PROFILES[txn.idp];
  const provider = config.providers?.[txn.idp];
  if (!profile || !provider?.secretSeeded) {
    return respond(
      403,
      "Forbidden",
      errorPage("Sign-in could not be completed", "That provider is no longer configured.", [
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
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(txn.h, config),
    code_verifier: txn.v,
  });

  const tokenResponse = await fetch(profile.tokenUrl(provider), {
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
  const claims = await verifyIdToken(idToken, profile, provider, txn.n);
  if (!claims) {
    return respond(
      403,
      "Forbidden",
      errorPage("Sign-in could not be completed", "The identity token failed verification."),
    );
  }

  const admission = profile.admit(claims, provider, config.allowedUsers);
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
  const session = sign(config.sessionKey, {
    email: admission.email,
    idp: txn.idp,
    actor: "user",
    exp,
  });

  return redirect(safePath(txn.p), [
    cookie(SESSION_COOKIE, session, { maxAge: config.sessionTtlSeconds }),
    // Display-only, readable by the SPA, trusted by nothing. It exists so the
    // app can render who is signed in without a round trip; it carries no
    // authority, which is exactly why it is NOT HttpOnly and NOT signed.
    cookie(IDENTITY_COOKIE, JSON.stringify({ email: admission.email, idp: txn.idp }), {
      maxAge: config.sessionTtlSeconds,
      httpOnly: false,
    }),
    // Clear the transaction: it has served its single purpose and leaving it
    // behind extends the window in which a captured verifier is useful.
    cookie(TXN_COOKIE, "", { maxAge: 0 }),
  ]);
};

/**
 * Sign out.
 *
 * Our cookies are cleared unconditionally and FIRST in intent: whether the
 * provider round trip happens or not, the session here is over. Where the
 * browser goes next depends on the provider the session was minted by —
 * Entra ends its own session for us, Google deliberately does not (see
 * `logoutUrl` in providers.mjs), so a Google session lands back on the site.
 *
 * The provider comes from the SIGNED session cookie. Reading it from the query
 * string would let any caller pick the redirect target, which is an open
 * redirect wearing a sign-out costume.
 */
const logout = (config, host, cookies) => {
  const home = `https://${isAllowedHost(host, config) ? host : config.fqdn}/`;
  const cleared = [
    cookie(SESSION_COOKIE, "", { maxAge: 0 }),
    cookie(IDENTITY_COOKIE, "", { maxAge: 0, httpOnly: false }),
    cookie(TXN_COOKIE, "", { maxAge: 0 }),
  ];

  const session = verify(config.sessionKey, cookies[SESSION_COOKIE]);
  const profile = session?.idp ? PROFILES[session.idp] : null;
  const provider = session?.idp ? config.providers?.[session.idp] : null;
  if (!profile?.logoutUrl || !provider) return redirect(home, cleared);

  return redirect(profile.logoutUrl(provider, home), cleared);
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
    if (uri === "/oauth2/logout") return logout(config, host, cookies);
    if (uri === "/oauth2/callback") return completeLogin(config, request, cookies);
    if (uri === "/oauth2/start") {
      const query = new URLSearchParams(request.querystring ?? "");
      return startLogin(config, host, query.get("next"), query.get("idp"));
    }
    return respond(404, "Not Found", errorPage("Not found", "No such sign-in route."));
  }

  // AFTER the header strip and the host check, so a public path is still
  // reached only on an admitted host and still cannot carry a forged identity.
  // Before the session check, because it must answer without one.
  if (PUBLIC_PATHS.has(uri)) return request;

  // SPA deep links are rewritten HERE rather than by CloudFront's
  // `custom_error_response`, and that is a correctness fix, not a preference.
  //
  // `custom_error_response` is a property of the DISTRIBUTION, not of a cache
  // behaviour — CloudFront offers no per-behaviour form. So a rule mapping
  // 403/404 to `/index.html` also catches a 403 from the API origin and turns
  // it into an HTML page with status **200**. A POST that was actually refused
  // then looks like a successful request returning a web page, which is both
  // impossible to debug and exactly the laundering ADR-0009 forbids.
  //
  // Rewriting the URI at viewer-request is scoped precisely: only a path with
  // no file extension and no `/api/` prefix becomes `index.html`, and every
  // origin error keeps its own status.
  if (isSpaRoute(uri)) request.uri = "/index.html";

  const session = verify(config.sessionKey, cookies[SESSION_COOKIE]);
  if (session?.email) {
    signPayload(request);
    return injectIdentity(request, config, session);
  }

  // Unauthenticated. The redirect always goes to `/oauth2/start`, which decides
  // between going straight to a provider and rendering the chooser — that
  // decision lives in exactly one place (ADR-0035).
  //
  // An API call gets a 401 instead of a redirect: following a 302 to an IdP
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
