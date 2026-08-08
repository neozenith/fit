import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from "@aws-sdk/client-athena";
import type { z } from "zod";
import { FINOPS_DATABASE, FINOPS_WORKGROUP, REGION } from "./const.js";
import { isCatalogueMissing } from "./finops-errors.js";
import type { finopsQuerySchema } from "./schemas.js";

/**
 * Cost reporting, read from the GLOBAL FinOps stack.
 *
 * Every environment queries the same account-scoped tables and filters by the
 * Environment tag (ADR-0015), so the page renders identical data from dev, test
 * or prod. Hiding dev's spend from prod's page would only make the account
 * total unexplainable.
 */

const athena = new AthenaClient({ region: REGION });

type FinopsQuery = z.infer<typeof finopsQuerySchema>;

/** Column in the CUR that carries each grouping. */
const GROUP_COLUMN: Record<FinopsQuery["groupBy"], string> = {
  service: "line_item_product_code",
  // Cost-allocation tag columns are prefixed and lower-cased by the CUR, which
  // is why these are not simply "Environment" and "Stack".
  environment: "resource_tags_user_environment",
  stack: "resource_tags_user_stack",
};

/**
 * Athena is asynchronous: start, poll, then fetch. There is no synchronous
 * form, so the polling loop is not an implementation choice.
 *
 * The ceiling is deliberate. A query that has not finished in 30 seconds is
 * either scanning far more than a partition-pruned month should, or the
 * workgroup's byte cap has already killed it — either way, blocking a page load
 * on it is worse than reporting that it timed out.
 */
const runQuery = async (sql: string): Promise<Record<string, string>[]> => {
  const started = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: FINOPS_WORKGROUP,
      QueryExecutionContext: { Database: FINOPS_DATABASE },
    }),
  );

  const id = started.QueryExecutionId;
  if (!id) throw new Error("Athena did not return a query execution id");

  const deadline = Date.now() + 30_000;
  for (;;) {
    const status = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = status.QueryExecution?.Status?.State;

    if (state === "SUCCEEDED") break;
    if (state === "FAILED" || state === "CANCELLED") {
      throw new Error(
        `Athena query ${state}: ${status.QueryExecution?.Status?.StateChangeReason ?? "no reason given"}`,
      );
    }
    if (Date.now() > deadline) throw new Error("Athena query exceeded its 30s ceiling");
    await new Promise((r) => setTimeout(r, 500));
  }

  const results = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id }));
  const rows = results.ResultSet?.Rows ?? [];
  // Row 0 is the header, always — Athena returns column names as data.
  const header = (rows[0]?.Data ?? []).map((d) => d.VarCharValue ?? "");
  return rows
    .slice(1)
    .map((row) =>
      Object.fromEntries(
        (row.Data ?? []).map((cell, i) => [header[i] ?? String(i), cell.VarCharValue ?? ""]),
      ),
    );
};

const monthsAgo = (n: number): string => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 7);
};

export const queryFinops = async (query: FinopsQuery) => {
  if (!FINOPS_DATABASE || !FINOPS_WORKGROUP) {
    // Loud rather than an empty chart. An environment deployed before the
    // global stack has genuinely no cost data, and saying so is more useful
    // than rendering zeros that look like a free account.
    return {
      available: false,
      reason: "The FinOps stack has not been deployed; there is no cost data to query yet.",
      rows: [],
    };
  }

  const from = query.from ?? monthsAgo(5);
  const to = query.to ?? monthsAgo(0);
  const column = GROUP_COLUMN[query.groupBy];

  // Parameters are inlined, and they are safe to inline because every one has
  // already been through a zod schema that constrains it to a fixed enum or a
  // YYYY-MM regex. Nothing user-shaped reaches this string.
  const environmentFilter =
    query.environment !== undefined
      ? `AND resource_tags_user_environment = '${query.environment}'`
      : "";

  // The CUR table does not exist until the global stack has been applied AND
  // its crawler has run over at least one delivered export — which is hours
  // after the stack applies, and up to a day after a brand-new account starts
  // accruing cost.
  //
  // That window is a NORMAL state, not a fault, so it must not be a 502. But
  // the catch below is deliberately NARROW: only a missing table or database is
  // translated into "not available yet". A permissions error, a byte-cap
  // rejection or a malformed query still throws, because each of those is a
  // real defect and hiding it behind "no data yet" is exactly how a broken
  // FinOps page looks healthy for a month.
  let rows: Record<string, string>[];
  try {
    rows = await runQuery(`
    SELECT
      billing_period,
      ${column} AS grouping_key,
      ROUND(SUM(line_item_unblended_cost), 4) AS cost
    FROM cur
    WHERE billing_period BETWEEN '${from}' AND '${to}'
      AND resource_tags_user_project = 'fit'
      ${environmentFilter}
    GROUP BY billing_period, ${column}
    ORDER BY billing_period, cost DESC
  `);
  } catch (error) {
    if (!isCatalogueMissing(error)) throw error;
    return {
      available: false,
      reason:
        "The cost catalogue has no data yet. The export lands within a few hours of the " +
        "FinOps stack being applied, and the crawler registers it shortly after.",
      rows: [],
    };
  }

  return {
    available: true,
    groupBy: query.groupBy,
    from,
    to,
    rows: rows.map((r) => ({
      period: r["billing_period"] ?? "",
      key: r["grouping_key"] || "(untagged)",
      cost: Number(r["cost"] ?? 0),
    })),
  };
};
