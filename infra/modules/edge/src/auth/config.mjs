import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import bundled from "./config.json" with { type: "json" };
import { buildConfig, relativeKey } from "./params.mjs";

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
 *
 * The SHAPING of what is read lives in `params.mjs`, which is pure and testable;
 * this file is only the I/O and the cache. Importing `config.json` is precisely
 * what makes this file untestable, so nothing that can be decided without the
 * network belongs here.
 */

// Lambda@Edge runs in the region nearest the viewer, but the parameters live in
// exactly one region. Pinning the client is not optional: an unpinned client
// would look for the parameters wherever the replica happens to be and find
// nothing, in a way that only reproduces from certain continents.
const ssm = new SSMClient({ region: bundled.ssmRegion });

const PARAM_TTL_MS = 5 * 60 * 1000;
let cache = null;

/**
 * Read the environment's parameter prefix into a flat object keyed by relative
 * path.
 *
 * Pagination is handled rather than assumed: the prefix is small today, but a
 * silently truncated page would drop a client secret and produce a 500 that
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
      values[relativeKey(p.Name, bundled.ssmPrefix)] = p.Value;
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return values;
};

export const loadConfig = async () => {
  if (cache && cache.expires > Date.now()) return cache.config;

  const config = buildConfig(bundled, await readParameters());

  cache = { config, expires: Date.now() + PARAM_TTL_MS };
  return config;
};

export const bundledConfig = bundled;
