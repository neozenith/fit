/**
 * Classifying Athena failures — kept in its own module, with NO dependency on
 * the environment.
 *
 * `finops.ts` imports `const.ts`, which throws at load time when a required
 * variable is missing. That is correct for a service (fail on the first cold
 * start, not deep in a handler) and makes the module untestable in isolation.
 * The classification is pure, so it lives here and is tested directly.
 */

/**
 * The failure reasons that mean "the catalogue is not populated yet", as
 * opposed to "something is wrong".
 *
 * Matched on the message because Athena reports every query failure through the
 * same `FAILED` state with a free-text `StateChangeReason` — there is no typed
 * error to catch.
 *
 * The patterns are deliberately narrow. Anything broader would also swallow a
 * permissions error or a byte-cap rejection, and a FinOps page that reports
 * "no data yet" while actually being denied access looks healthy for a month.
 */
export const MISSING_CATALOGUE =
  /(does not exist|Table .*not found|Database .*not found|Schema .*not found|EntityNotFound|TABLE_NOT_FOUND|SCHEMA_NOT_FOUND)/i;

/** True when a failure means "not populated yet" rather than "broken". */
export const isCatalogueMissing = (error: unknown): boolean =>
  MISSING_CATALOGUE.test(error instanceof Error ? error.message : String(error));
