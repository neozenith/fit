import type { z } from "zod";
import { FINOPS_BUCKET, FINOPS_PREFIX } from "./const.js";
import { parquetGlob, queryParquet, toNumber } from "./query.js";
import { FINOPS_RANGE_DAYS, type finopsQuerySchema } from "./schemas.js";

/**
 * Cost reporting, read from the GLOBAL FinOps export.
 *
 * Every environment reads the same account-scoped Parquet and filters by the
 * Environment tag (ADR-0015), so the page renders identical data from dev, test
 * or prod. Hiding dev's spend from prod's page would only make the account
 * total unexplainable.
 *
 * Queried with DuckDB directly against S3 (ADR-0025). What used to be here — an
 * Athena start/poll/fetch loop, a 30-second ceiling, and a regex classifying one
 * vendor's free-text failure strings to tell "no table yet" from "access
 * denied" — is gone. "The export has not landed yet" is now decided by LISTING
 * the prefix, which is a fact rather than an interpretation.
 */

type FinopsQuery = z.infer<typeof finopsQuerySchema>;

/**
 * The expression in the CUR that carries each grouping.
 *
 * Tags are a `MAP(VARCHAR, VARCHAR)` column, NOT flattened into
 * `resource_tags_user_*` columns. That flattening was the Glue crawler's doing,
 * and it left with the crawler (ADR-0025) — reading the export directly means
 * reading the map. Keys are lower-cased and prefixed by AWS, so the `Project`
 * tag arrives as `user_project`.
 *
 * `stack` resolves to NULL today and that is an ACCOUNT limitation, not a bug:
 * this is a linked account, so cost-allocation tag activation belongs to the
 * payer, and only `Project` and `Environment` have been activated there. Every
 * resource already carries `Stack` via provider default_tags, so the grouping
 * starts working the moment the payer activates it — with no change here.
 */
const GROUP_COLUMN: Record<FinopsQuery["groupBy"], string> = {
  service: "line_item_product_code",
  environment: "resource_tags['user_environment']",
  stack: "resource_tags['user_stack']",
};

/**
 * How a bucket is cut, and how it is labelled.
 *
 * Cut on `line_item_usage_start_date`, NOT on `bill_billing_period_start_date`.
 * The billing period is a whole month, so a 1-day or 7-day window bucketed by it
 * collapses into a single bar covering thirty days of spend. The usage date is
 * when the cost was actually incurred, and it is the only column that can answer
 * "what did yesterday cost".
 */
const GRAIN_SQL: Record<"day" | "month", { trunc: string; format: string }> = {
  day: { trunc: "day", format: "%Y-%m-%d" },
  month: { trunc: "month", format: "%Y-%m" },
};

/** Daily detail stays legible up to about a quarter; past that it is noise. */
const defaultGrain = (range: FinopsQuery["range"]): "day" | "month" => {
  const days = FINOPS_RANGE_DAYS[range];
  return typeof days === "number" && days <= 90 ? "day" : "month";
};

interface CostRow {
  period: string;
  grouping_key: string | null;
  cost: number;
}

export const queryFinops = async (input: FinopsQuery) => {
  if (!FINOPS_BUCKET) {
    // Loud rather than an empty chart. An environment deployed before the
    // global stack genuinely has no cost data, and saying so is more useful
    // than rendering zeros that look like a free account.
    return {
      available: false,
      reason: "The FinOps stack has not been deployed; there is no cost data to query yet.",
      rows: [],
    };
  }

  const grain = input.grain ?? defaultGrain(input.range);
  const { trunc, format } = GRAIN_SQL[grain];
  const days = FINOPS_RANGE_DAYS[input.range] ?? null;

  // The grouping column and the truncation unit come from fixed maps keyed by
  // zod enums, so neither can be caller-controlled. Everything else is BOUND —
  // the glob, the window and the environment filter reach DuckDB as parameters
  // rather than as string concatenation.
  const column = GROUP_COLUMN[input.groupBy];
  const glob = parquetGlob(FINOPS_BUCKET, FINOPS_PREFIX);

  const rows = await queryParquet<CostRow>(
    glob,
    `
    SELECT
      strftime(date_trunc('${trunc}', line_item_usage_start_date), '${format}') AS period,
      ${column}                                                                 AS grouping_key,
      ROUND(SUM(line_item_unblended_cost), 6)                                   AS cost
    FROM read_parquet(?, hive_partitioning = true, union_by_name = true)
    WHERE (? IS NULL OR line_item_usage_start_date >= current_date - CAST(? AS INTEGER))
      AND resource_tags['user_project'] = 'fit'
      AND (? IS NULL OR resource_tags['user_environment'] = ?)
    GROUP BY period, ${column}
    -- Exact-zero rows are the majority of a CUR: every free-tier line and every
    -- service touched once appears at $0.000000. Keeping them turns a legend of
    -- six real services into forty, most of which can never be seen.
    HAVING SUM(line_item_unblended_cost) <> 0
    ORDER BY period, cost DESC
    `,
    [glob, days, days, input.environment ?? null, input.environment ?? null],
  );

  if (rows === null) {
    // The stack exists but the first export has not landed. AWS delivers a CUR
    // up to 24 hours after the export is defined, so this is the NORMAL state
    // of a freshly applied account rather than a fault.
    return {
      available: false,
      reason: "The cost export has been defined but AWS has not delivered any data yet.",
      rows: [],
    };
  }

  return {
    available: true,
    groupBy: input.groupBy,
    range: input.range,
    grain,
    rows: rows.map((r) => ({
      period: r.period,
      key: r.grouping_key || "(untagged)",
      cost: toNumber(r.cost),
    })),
  };
};
