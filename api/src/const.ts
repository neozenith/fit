/**
 * The single place this service reads its environment.
 *
 * Every other module imports from here. A missing variable therefore fails at
 * module load — the first cold start — rather than inside a request handler
 * that only takes that branch on a Tuesday.
 */

const required = (key: string): string => {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new Error(`Undefined required environment variable - ${key}`);
  }
  return value;
};

const optional = (key: string, fallback: string): string => process.env[key] || fallback;

export const APP_NAME = optional("APP_NAME", "fit");
export const ENVIRONMENT = required("ENVIRONMENT");
export const REGION = optional("AWS_REGION", "ap-southeast-2");

/** Prefix for every parameter this environment owns. */
export const SSM_PREFIX = optional("SSM_PREFIX", `/${APP_NAME}/${ENVIRONMENT}`);

/** Physical table names are `{prefix}-{logical}`; see the data module. */
export const TABLE_PREFIX = optional("TABLE_PREFIX", `${APP_NAME}-${ENVIRONMENT}`);

export const ARCHIVE_BUCKET = optional("ARCHIVE_BUCKET", "");

/**
 * Global FinOps export — identical in every environment (ADR-0015).
 *
 * A bucket and a prefix, not a database and a workgroup: there is no catalogue
 * any more, so the only thing an environment needs to know is where the Parquet
 * lives (ADR-0025).
 */
export const FINOPS_BUCKET = optional("FINOPS_BUCKET", "");
export const FINOPS_PREFIX = optional("FINOPS_PREFIX", "cur");

/**
 * Local development points the AWS SDK at DynamoDB Local instead of AWS.
 *
 * This is the ONLY thing that differs between local and deployed (ADR-0016) —
 * transport and backing store. There is no branch anywhere in this service that
 * changes business or authentication logic based on the environment.
 */
export const DYNAMODB_ENDPOINT = optional("DYNAMODB_ENDPOINT", "");

export const IS_LOCAL = DYNAMODB_ENDPOINT !== "";

export const PORT = Number(optional("PORT", "8787"));

/**
 * Local development key.
 *
 * Deployed environments read the real key from SSM. This constant exists only
 * so `make dev` can verify signatures with the same code path production uses,
 * rather than skipping verification — a local `if (isLocal) skipAuth` branch is
 * how an auth bug reaches production undetected.
 */
export const LOCAL_SESSION_KEY = optional(
  "LOCAL_SESSION_KEY",
  "local-development-key-not-a-secret",
);
