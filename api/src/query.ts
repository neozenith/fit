import { DuckDBInstance } from "@duckdb/node-api";
import { REGION } from "./const.js";

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
    // A hard ceiling well under the Lambda's memory. Without it DuckDB sizes
    // its buffer pool from the machine's total RAM, which in Lambda is the
    // host's, not the function's — it would happily plan a query that the
    // runtime then kills for exceeding its allocation.
    memory_limit: "384MB",
    threads: "2",
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
 * The S3 secret uses `credential_chain`, so DuckDB picks up the Lambda's own
 * role credentials — including the rotation the runtime performs. Hardcoding
 * keys, or reading them from the environment once at start-up, would break on a
 * long-lived container after the first rotation.
 */
export const query = async <T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> => {
  const db = await instance();
  const connection = await db.connect();

  try {
    await connection.run(`
      INSTALL httpfs; LOAD httpfs;
      CREATE OR REPLACE SECRET s3_role (
        TYPE s3,
        PROVIDER credential_chain,
        REGION '${REGION}'
      );
    `);

    // Parameters are bound, never interpolated. Every caller here passes values
    // that have already been through a zod schema, but binding is the habit that
    // survives the one caller that has not.
    const result = params.length > 0
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
 * without every query needing an edit. An empty prefix yields zero rows rather
 * than an error, which is why "the data is not there yet" stopped being a state
 * this service has to model.
 */
export const parquetGlob = (bucket: string, prefix: string): string =>
  `s3://${bucket}/${prefix.replace(/\/+$/, "")}/**/*.parquet`;
