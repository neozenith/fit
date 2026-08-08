import type { Units } from "./types.js";

/**
 * The smallest weight change the athlete can actually load, per unit system.
 *
 * This single constant does double duty in the source program, and the two uses
 * are worth separating in your head even though the number is the same:
 *
 *  1. the multiple every computed weight is rounded to (`MROUND(x, 2.5)`), and
 *  2. the explicit nudge the program applies on top of a percentage
 *     ("`+ 2.5`" on a Week 3 squat), which is really "add one plate pair".
 */
export const increment = (units: Units): number => (units === "kg" ? 2.5 : 5);

/**
 * Excel's `MROUND`: round to the nearest multiple, halves away from zero.
 *
 * `Math.round` is half-*up*, which differs from half-away-from-zero only for
 * negatives — and no weight here is negative. The `Number.EPSILON` scaling
 * matters more: `49 / 2.5` is exactly 19.6 in binary floating point, but
 * `0.675 * 40 / 2.5` lands on `10.799999999999999`, and rounding that naively
 * loses a 2.5kg step. Scaling by the reciprocal before rounding avoids the
 * class of error entirely.
 */
export const mround = (value: number, multiple: number): number => {
  if (multiple === 0) return 0;
  const scaled = value / multiple;
  // Nudge by one ULP-ish so exact halves that landed a hair low still round up.
  const rounded = Math.round(scaled + Math.sign(scaled) * Number.EPSILON * Math.abs(scaled));
  return roundFloat(rounded * multiple);
};

/**
 * Trim binary-floating-point dust from a weight.
 *
 * `2.5 * 23` is `57.49999999999999`; displayed raw it reads as a bug. Three
 * decimal places is well below the smallest real increment (0.25kg micro-plates
 * are the finest anyone loads) so this can never round away a real value.
 */
export const roundFloat = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Project a working weight: a percentage of a 1RM, optionally nudged before
 * rounding, rounded to the loadable increment, then optionally nudged again.
 *
 * Both nudges are counted in **increments**, not in kilograms. That is the fix
 * for one of the two arithmetic bugs in the source spreadsheet (see
 * `docs/questions/Q01-spreadsheet-formula-deviations.md`): the sheet writes
 * every nudge as a literal `+2.5` or `-5`, which is right in one unit system
 * and wrong in the other. Counting increments makes the intent unit-independent.
 *
 * Whether a nudge falls inside or outside `MROUND` genuinely changes the answer,
 * so the distinction is not cosmetic. A 70kg squat at 85%:
 *
 *   outside: mround(59.5, 2.5) + 2.5 = 60   + 2.5 = 62.5
 *   inside:  mround(59.5 + 2.5, 2.5) + 2.5 = 62.5 + 2.5 = 65
 *
 * Week 3's two squat days use one form each, deliberately — that is the week's
 * built-in linear progression.
 */
export const workingWeight = (
  oneRepMax: number,
  percentage: number,
  units: Units,
  options: { preNudge?: number | undefined; nudge?: number | undefined } = {},
): number => {
  const { preNudge = 0, nudge = 0 } = options;
  const step = increment(units);
  return roundFloat(mround(oneRepMax * percentage + preNudge * step, step) + nudge * step);
};
