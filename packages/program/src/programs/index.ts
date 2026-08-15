import type { Program } from "../types.js";
import { CANDITO_6_WEEK } from "./candito.js";
import { STRONGLIFTS_5X5 } from "./stronglifts5x5.js";
import { WENDLER_531 } from "./wendler531.js";

/**
 * The built-in program registry.
 *
 * Ordered deliberately: Candito first because it is what this application was
 * built to replace, then 5/3/1 and 5×5 by how widely they are run. The picker
 * renders this order.
 *
 * Adding a program is adding one entry here. Nothing in the API or the SPA
 * enumerates programs by name — the parameter declarations drive the form and
 * the schedule drives the calendar, so a fourth program needs no UI work.
 */
export const BUILTIN_PROGRAMS: readonly Program[] = [
  CANDITO_6_WEEK,
  WENDLER_531,
  STRONGLIFTS_5X5,
] as const;

export const findBuiltinProgram = (programId: string): Program | undefined =>
  BUILTIN_PROGRAMS.find((p) => p.programId === programId);

/** The program a block gets when none was named — the historical default. */
export const DEFAULT_PROGRAM_ID = CANDITO_6_WEEK.programId;

export { CANDITO_6_WEEK, STRONGLIFTS_5X5, WENDLER_531 };
export { resolveConditional } from "./candito.js";
export { linearRamp } from "./stronglifts5x5.js";
export { trainingMaxes } from "./wendler531.js";
