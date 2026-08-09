import { createRequire } from "node:module";
import type { DuckDBInstance as DuckDBInstanceType } from "@duckdb/node-api";
import { DUCKDB_EXTENSION_DIR, REGION } from "./const.js";

/**
 * Loaded through `createRequire`, not by a static `import`, and that is not a
 * style choice.
 *
 * Lambda puts a layer's packages on `NODE_PATH`, and **`NODE_PATH` applies only
 * to CommonJS `require`** — ESM bare-specifier resolution walks `node_modules`
 * upward from the importing file, which for a handler at `/var/task` never
 * reaches `/opt/nodejs/node_modules`. A plain `import` therefore resolves
 * perfectly on a laptop, survives typecheck and bundling, and then fails at the
 * first cold start with `ERR_MODULE_NOT_FOUND`.
 *
 * `@duckdb/node-api` is CommonJS (no `"type": "module"`), so requiring it is
 * also what the package itself expects. The types come from the dev-time
 * dependency; only the runtime lookup goes through the layer.
 */
const { DuckDBInstance } = createRequire(import.meta.url)(
  "@duckdb/node-api",
) as typeof import("@duckdb/node-api");

/**
 * Analytical queries over Parquet in S3, run inside this Lambda (ADR-0025).
 *
 * There is no catalogue. The S3 layout IS the schema, and `read_parquet` with
 * `hive_partitioning` derives the partition columns from the path — so data is
 * queryable the moment it is written, rather than whenever a crawler next runs.
 *
 * DuckDB arrives as a Lambda layer, which is why nothing here downloads or
 * installs anything: the import fails loudly at cold start if the layer is
 * missing or built for the wrong architecture, which is the correct failure for
 * a hard dependency.
 */

/**
 * One instance per container, created lazily.
 *
 * DuckDB start-up costs tens of milliseconds and is pure waste on a warm
 * invocation. The PROMISE is cached rather than the instance, so two concurrent
 * first requests share one start-up instead of racing to create two.
 */
let instancePromise: Promise<DuckDBInstanceType> | null = null;

const instance = (): Promise<DuckDBInstanceType> => {
  instancePromise ??= DuckDBInstance.create(":memory:", {
    // Spread rather than a constant key: DuckDB rejects an empty
    // `extension_directory`, so "unset" has to mean absent, not "".
    ...(DUCKDB_EXTENSION_DIR ? { extension_directory: DUCKDB_EXTENSION_DIR } : {}),

    // A hard ceiling well under the Lambda's memory. Without it DuckDB sizes
    // its buffer pool from the machine's total RAM, which in Lambda is the
    // host's, not the function's — it would happily plan a query that the
    // runtime then kills for exceeding its allocation.
    memory_limit: "384MB",
    threads: "2",

    // `httpfs` and `aws` are NOT statically linked (only `parquet` is), so
    // without the directory above DuckDB tries to fetch them from
    // extensions.duckdb.org on first use and cache them under $HOME — which on
    // Lambda is read-only. The layer bakes them in; pointing at that directory
    // is what makes the first S3 read work with no network call.
    //
    // Any extension not in that directory is a BUILD error, not something to
    // paper over at runtime. With autoinstall on, a missing bake would silently
    // become a cold-start download that works in dev and fails in Lambda.
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
  }).catch((error) => {
    // Clear the cache so the next cold start retries. A cached rejection makes
    // one transient failure permanent for the life of the container.
    instancePromise = null;
    throw error;
  });
  return instancePromise;
};

/**
 * Give a connection the ability to read `s3://`, and only when it needs it.
 *
 * `CREATE SECRET ... PROVIDER credential_chain` VALIDATES EAGERLY: it resolves
 * the chain at creation and raises if it comes up empty. So a query over local
 * Parquet on a laptop with credentials in a profile rather than the environment
 * would fail on a secret it was never going to use.
 *
 * Gating on the source is therefore correctness, not thrift — and it is not a
 * degraded path either: reading a local file genuinely requires no S3
 * credentials. When the source IS `s3://`, a missing chain still fails loudly.
 *
 * `CHAIN 'env'` because Lambda publishes its role credentials as environment
 * variables and refreshes them there; the default chain is `config`, which
 * looks for a `~/.aws/config` that Lambda does not have.
 */
const configureS3 = async (connection: {
  run: (sql: string) => Promise<unknown>;
}): Promise<void> => {
  await connection.run(`
    LOAD httpfs;
    LOAD aws;
    CREATE OR REPLACE SECRET s3_role (
      TYPE s3,
      PROVIDER credential_chain,
      CHAIN 'env',
      REGION '${REGION}'
    );
  `);
};

/** Run a read-only query and return plain objects. */
export const query = async <T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  options: { s3?: boolean } = {},
): Promise<T[]> => {
  const db = await instance();
  const connection = await db.connect();

  try {
    if (options.s3) await configureS3(connection);

    // Parameters are bound, never interpolated. Every caller here passes values
    // that have already been through a zod schema, but binding is the habit that
    // survives the one caller that has not.
    const result =
      params.length > 0
        ? await connection.runAndReadAll(sql, params as never[])
        : await connection.runAndReadAll(sql);

    return result.getRowObjects() as T[];
  } finally {
    connection.closeSync();
  }
};

/**
 * A glob over a Parquet prefix, as `read_parquet` wants it.
 *
 * `**` rather than a fixed depth, so a partition scheme can gain a level
 * without every query needing an edit.
 *
 * An ABSOLUTE PATH in place of a bucket name yields a filesystem glob instead
 * of an `s3://` one. That is the same local-development swap as
 * `DYNAMODB_ENDPOINT` (ADR-0016): transport and backing store differ locally,
 * and nothing else does. It exists so `make dev` runs the real handlers over
 * the real curated Parquet — every SQL statement in `history.ts` is exercised
 * against actual data before it is ever deployed, which is not true of a
 * query that only ever runs against S3.
 */
export const parquetGlob = (bucket: string, prefix: string): string => {
  const trimmed = prefix.replace(/\/+$/, "");
  return bucket.startsWith("/")
    ? `${bucket.replace(/\/+$/, "")}/${trimmed}/**/*.parquet`
    : `s3://${bucket}/${trimmed}/**/*.parquet`;
};

/**
 * Run a query over a Parquet glob, returning no rows when the glob matches
 * nothing.
 *
 * `read_parquet` treats an empty match as an IO error, and "the export has not
 * landed yet" is a state this service legitimately has to answer for. The check
 * is a LISTING (`glob()` returns zero rows rather than raising), not a regex
 * over the error message — deciding "no data" from the shape of one vendor's
 * prose is precisely the habit ADR-0025 removed along with Athena.
 *
 * Anything else — access denied, a corrupt file, a bad column — still throws.
 */
export const queryParquet = async <T = Record<string, unknown>>(
  glob: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[] | null> => {
  const s3 = glob.startsWith("s3://");
  const listed = await query<{ n: bigint }>("SELECT count(*) AS n FROM glob(?)", [glob], { s3 });
  if (toNumber(listed[0]?.n) === 0) return null;
  return query<T>(sql, params, { s3 });
};

/** DuckDB returns BIGINT columns as `bigint`; every caller here wants a number. */
export const toNumber = (value: unknown): number => Number(value ?? 0);
