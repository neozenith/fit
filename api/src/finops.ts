import type { z } from "zod";
import { FINOPS_BUCKET, FINOPS_PREFIX } from "./const.js";
import { parquetGlob, queryParquet } from "./query.js";
import type { finopsQuerySchema } from "./schemas.js";

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
 * denied" — is gone. A missing prefix now simply returns zero rows.
 */

type FinopsQuery = z.infer<typeof finopsQuerySchema>;

/**
 * Column in the CUR that carries each grouping.
 *
 * The tag columns are prefixed and lower-cased by the export, which is why
 * these are not simply `Environment` and `Stack`.
 */
const GROUP_COLUMN: Record<FinopsQuery["groupBy"], string> = {
  service: "line_item_product_code",
  environment: "resource_tags_user_environment",
  stack: "resource_tags_user_stack",
};

const monthsAgo = (n: number): string => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 7);
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

  const from = input.from ?? monthsAgo(5);
  const to = input.to ?? monthsAgo(0);

  // The grouping column is selected from a fixed map keyed by a zod enum, so it
  // cannot be caller-controlled. Everything else is BOUND — the glob, the date
  // range and the environment filter reach DuckDB as parameters rather than as
  // string concatenation.
  const column = GROUP_COLUMN[input.groupBy];
  const glob = parquetGlob(FINOPS_BUCKET, FINOPS_PREFIX);

  const rows = await queryParquet<CostRow>(
    glob,
    `
    SELECT
      strftime(bill_billing_period_start_date, '%Y-%m') AS period,
      ${column}                                         AS grouping_key,
      ROUND(SUM(line_item_unblended_cost), 4)           AS cost
    FROM read_parquet(?, hive_partitioning = true, union_by_name = true)
    WHERE strftime(bill_billing_period_start_date, '%Y-%m') BETWEEN ? AND ?
      AND resource_tags_user_project = 'fit'
      AND (? IS NULL OR resource_tags_user_environment = ?)
    GROUP BY period, ${column}
    ORDER BY period, cost DESC
    `,
    [glob, from, to, input.environment ?? null, input.environment ?? null],
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
    from,
    to,
    rows: rows.map((r) => ({
      period: r.period,
      key: r.grouping_key || "(untagged)",
      cost: Number(r.cost),
    })),
  };
};
