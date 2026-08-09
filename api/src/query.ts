import { DuckDBInstance } from "@duckdb/node-api";
import { DUCKDB_EXTENSION_DIR, REGION } from "./const.js";

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
let instancePromise: Promise<DuckDBInstance> | null = null;

const instance = (): Promise<DuckDBInstance> => {
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
 * Run a read-only query and return plain objects.
 *
 * The S3 secret reads the Lambda's credentials from the ENVIRONMENT rather than
 * from a config file. `credential_chain` with no chain specified defaults to
 * `config`, which fails outright where there is no `~/.aws/config` — and Lambda
 * is exactly that place. Creating the secret per call also means a container
 * that outlives a credential rotation picks up the new values.
 */
export const query = async <T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> => {
  const db = await instance();
  const connection = await db.connect();

  try {
    await connection.run(`
      LOAD httpfs;
      LOAD aws;
      CREATE OR REPLACE SECRET s3_role (
        TYPE s3,
        PROVIDER credential_chain,
        CHAIN 'env;sts',
        REGION '${REGION}'
      );
    `);

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
 */
export const parquetGlob = (bucket: string, prefix: string): string =>
  `s3://${bucket}/${prefix.replace(/\/+$/, "")}/**/*.parquet`;

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
  const listed = await query<{ n: bigint }>("SELECT count(*) AS n FROM glob(?)", [glob]);
  if (toNumber(listed[0]?.n) === 0) return null;
  return query<T>(sql, params);
};

/** DuckDB returns BIGINT columns as `bigint`; every caller here wants a number. */
export const toNumber = (value: unknown): number => Number(value ?? 0);
