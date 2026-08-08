import { SSMClient, GetParametersByPathCommand } from "@aws-sdk/client-ssm";
import bundled from "./config.json" with { type: "json" };

/**
 * Runtime configuration for the edge authenticator.
 *
 * Two sources, and the split is forced by the platform:
 *
 *   `config.json` is SYNTHESIZED BY TERRAFORM at plan time and baked into the
 *   deployment bundle. It does not exist in the source tree — Lambda@Edge has
 *   no environment variables (ADR-0017), so anything the function needs before
 *   its first network call has to arrive inside the zip.
 *
 *   SSM carries everything secret or mutable. Read recursively at cold start
 *   from the environment's own prefix, so seeding a credential does not need a
 *   redeploy.
 */

// Lambda@Edge runs in the region nearest the viewer, but the parameters live in
// exactly one region. Pinning the client is not optional: an unpinned client
// would look for the parameters wherever the replica happens to be and find
// nothing, in a way that only reproduces from certain continents.
const ssm = new SSMClient({ region: bundled.ssmRegion });

const PARAM_TTL_MS = 5 * 60 * 1000;
let cache = null;

const leaf = (name) => name.split("/").pop();

/**
 * Read the environment's parameter prefix into a flat object.
 *
 * Pagination is handled rather than assumed: the prefix is small today, but a
 * silently truncated page would drop the client secret and produce a 500 that
 * looks like a seeding problem.
 */
const readParameters = async () => {
  const values = {};
  let nextToken;
  do {
    const page = await ssm.send(
      new GetParametersByPathCommand({
        Path: bundled.ssmPrefix,
        Recursive: true,
        WithDecryption: true,
        NextToken: nextToken,
      }),
    );
    for (const p of page.Parameters ?? []) {
      // Keyed by leaf name, with the full path kept for the error messages that
      // tell an operator exactly which parameter to seed.
      values[leaf(p.Name)] = p.Value;
      values[`__path_${leaf(p.Name)}`] = p.Name;
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return values;
};

/** Sentinel values written by Terraform for parameters it must never own. */
const UNSEEDED = new Set(["UNSEEDED", "PLACEHOLDER", ""]);

export const isSeeded = (value) => value !== undefined && !UNSEEDED.has(value);

export const loadConfig = async () => {
  if (cache && cache.expires > Date.now()) return cache.config;

  const p = await readParameters();

  const config = {
    ...bundled,
    tenantId: p.tenant_id,
    clientId: p.client_id,
    clientSecret: p.client_secret,
    clientSecretPath: p.__path_client_secret,
    sessionKey: p.session_hmac_key,
    // An empty allow-list must admit NOBODY (ADR-0010). `filter(Boolean)` is
    // what makes `"".split(",")` produce `[]` instead of `[""]` — without it an
    // empty parameter would admit an empty email, which some IdP edge cases
    // can actually produce.
    allowedUsers: (p.allowed_users ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    sessionTtlSeconds: Number(p.session_ttl_seconds ?? 28800),
  };

  cache = { config, expires: Date.now() + PARAM_TTL_MS };
  return config;
};

export const bundledConfig = bundled;
