#!/usr/bin/env bun
/**
 * Publish the curated history Parquet to an environment's archive bucket.
 *
 *   bun run tools/publish-history.ts --env dev
 *   bun run tools/publish-history.ts --env prod --dry-run
 *
 * The curation step (tools/curate_history.py) reads a workbook full of personal
 * body-composition data and writes to `reference/`, which is gitignored. This
 * step is the deliberate act of moving it somewhere it can be read back — which
 * is why it is a SEPARATE command with an explicit `--env`, rather than a stage
 * of the curation. Nothing leaves the machine because a build ran.
 *
 * The layout matches what the API globs:
 *
 *   s3://{archive-bucket}/history/{table}/{table}.parquet
 *
 * A directory per table even though each holds one file, because
 * `read_parquet('.../history/strength_sets/**\/*.parquet')` then keeps working
 * when the import is eventually split by year.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const REGION = process.env["AWS_REGION"] ?? "ap-southeast-2";
const SOURCE_DIR = new URL("../reference/history/", import.meta.url).pathname;
const PREFIX = "history";

const ENVIRONMENTS = ["dev", "test", "prod"] as const;
type Environment = (typeof ENVIRONMENTS)[number];

const printHelp = (): void => {
  console.log(
    [
      "Usage: publish-history --env <dev|test|prod> [--dry-run]",
      "",
      "Upload reference/history/*.parquet to the environment's archive bucket.",
      "",
      "Options:",
      "  --env <name>   Target environment (required)",
      "  --dry-run      Report what would change without uploading",
      "  -h, --help     Show this help and exit",
    ].join("\n"),
  );
};

const archiveBucket = async (environment: Environment): Promise<string> => {
  const ssm = new SSMClient({ region: REGION });
  const name = `/fit/${environment}/data/archive_bucket`;
  const result = await ssm.send(new GetParameterCommand({ Name: name }));
  const value = result.Parameter?.Value;
  if (!value)
    throw new Error(`${name} is empty — has the data stack been applied for ${environment}?`);
  return value;
};

/**
 * Whether S3 already holds these exact bytes.
 *
 * Compared by MD5 against the object's ETag rather than by size: re-curating
 * the same workbook produces a byte-identical file, and re-uploading 40KB is
 * harmless, but a SIZE comparison would call a changed file unchanged whenever
 * a correction happened to preserve the row count.
 *
 * Multipart-uploaded objects carry a `-N` suffix on their ETag and cannot be
 * compared this way; at these file sizes nothing is multipart, and an
 * unrecognised ETag is treated as "changed" rather than assumed equal.
 */
const alreadyPublished = async (
  s3: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
): Promise<boolean> => {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const etag = (head.ETag ?? "").replaceAll('"', "");
    if (etag.includes("-")) return false;
    return etag === createHash("md5").update(body).digest("hex");
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "NotFound" || name === "NoSuchKey") return false;
    throw error;
  }
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      env: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const environment = values.env as Environment | undefined;
  if (!environment || !ENVIRONMENTS.includes(environment)) {
    console.error("error: --env must be one of dev, test, prod");
    printHelp();
    process.exit(2);
  }

  const entries = (await readdir(SOURCE_DIR, { recursive: true }))
    .filter((f) => f.endsWith(".parquet"))
    .sort();
  if (entries.length === 0) {
    // Loud, and specific about the fix. An empty publish that exits 0 would
    // leave the environment reporting "no history" with nothing to explain it.
    throw new Error(`no Parquet in ${SOURCE_DIR} — run \`make history\` first`);
  }

  const bucket = await archiveBucket(environment);
  const s3 = new S3Client({ region: REGION });

  console.log(`${environment}: s3://${bucket}/${PREFIX}/`);
  for (const file of entries) {
    // `file` already carries its table directory — the curated tree mirrors the
    // S3 layout exactly, so the key is the relative path and nothing is rebuilt
    // from a filename that could disagree with it.
    const key = `${PREFIX}/${file}`;
    const body = await readFile(`${SOURCE_DIR}${file}`);

    if (await alreadyPublished(s3, bucket, key, body)) {
      console.log(`  = ${key} (${body.length} bytes, unchanged)`);
      continue;
    }
    if (values["dry-run"]) {
      console.log(`  ~ ${key} (${body.length} bytes, would upload)`);
      continue;
    }
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/vnd.apache.parquet",
      }),
    );
    console.log(`  + ${key} (${body.length} bytes)`);
  }
};

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`error: ${msg}`);
  process.exit(1);
});
