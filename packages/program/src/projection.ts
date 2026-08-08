import type { BlockConfig, LiftKey, ProjectedMax, Units } from "./types.js";
import { LIFT_KEYS } from "./types.js";
import { increment, mround, roundFloat } from "./units.js";

/**
 * The program's own rep-to-multiplier table for turning a Week 5 test set into
 * a projected one-rep max:
 *
 *   "Take what you lifted in week 5, and multiply by 1.03 if you completed
 *    2 reps, 1.06 if 3 reps, and 1.09 if 4 reps."
 *
 * One rep is the trivial case (the set *was* a single) and gets 1.00. Five or
 * more is outside the prescribed 1-4 rep window — see `projectMax`.
 */
const REP_FACTORS: Record<number, number> = { 1: 1.0, 2: 1.03, 3: 1.06, 4: 1.09 };

/** The linear extension of the table beyond 4 reps: 3 percentage points each. */
const EXTRAPOLATED_STEP = 0.03;

/**
 * Factor for `reps` completed on the Week 5 test set.
 *
 * Above 4 reps the program is silent, because a set that goes past 4 at 97.5%
 * means the entered max was too low to begin with. Continuing the table's own
 * linear 3-points-per-rep slope is the least surprising extension, and it errs
 * toward a *larger* jump — which the Week 2 feedback rules will correct
 * downward if it proves optimistic. Below 1 rep is a failed lift and has no
 * projection at all.
 */
export const repFactor = (reps: number): number => {
  if (reps < 1) return Number.NaN;
  return REP_FACTORS[reps] ?? roundFloat(1.09 + (reps - 4) * EXTRAPOLATED_STEP);
};

/**
 * Project one lift's next-block seed from its Week 5 test set.
 *
 * Returns `null` for a failed set (0 reps): there is nothing to project from,
 * and inventing a number here would quietly seed the next block with a
 * fabricated max.
 */
export const projectMax = (
  lift: LiftKey,
  achievedWeight: number,
  achievedReps: number,
  units: Units,
): ProjectedMax | null => {
  const factor = repFactor(achievedReps);
  if (!Number.isFinite(factor)) return null;
  const projected = roundFloat(achievedWeight * factor);
  return {
    lift,
    achievedWeight,
    achievedReps,
    factor,
    projected,
    projectedRounded: mround(projected, increment(units)),
  };
};

/** One Week 5 result, as the athlete logs it. */
export interface TestSetResult {
  lift: LiftKey;
  weight: number;
  reps: number;
}

/**
 * Build the *proposed* next block from this block plus its Week 5 results.
 *
 * Per ADR-0013 the result is a proposal, not a mutation: the returned config is
 * a brand-new item carrying `derivedFrom`, and nothing is written until the
 * athlete accepts it. A lift with no usable result keeps its current seed
 * rather than being dropped — an untested lift has not got weaker.
 */
export const proposeNextBlock = (
  current: BlockConfig,
  results: TestSetResult[],
  options: { blockId: string; startDate: string },
): { config: BlockConfig; projections: ProjectedMax[]; carriedForward: LiftKey[] } => {
  const projections: ProjectedMax[] = [];
  const carriedForward: LiftKey[] = [];
  const oneRepMax = { ...current.oneRepMax };

  for (const lift of LIFT_KEYS) {
    const result = results.find((r) => r.lift === lift);
    const projection = result ? projectMax(lift, result.weight, result.reps, current.units) : null;
    if (projection) {
      projections.push(projection);
      oneRepMax[lift] = projection.projectedRounded;
    } else {
      carriedForward.push(lift);
    }
  }

  return {
    config: {
      blockId: options.blockId,
      startDate: options.startDate,
      units: current.units,
      oneRepMax,
      accessories: { ...current.accessories },
      derivedFrom: current.blockId,
    },
    projections,
    carriedForward,
  };
};

/**
 * Apply the program's failure rule to a seed max.
 *
 * "If you ever fail a required rep, reduce your max by 2.5%." Applied as a
 * fresh block config rather than an edit, so the history of what was believed
 * when stays intact (ADR-0013).
 */
export const applyFailureAdjustment = (
  current: BlockConfig,
  lift: LiftKey,
  options: { blockId: string; startDate?: string; factor?: number },
): BlockConfig => {
  const factor = options.factor ?? 0.975;
  return {
    ...current,
    blockId: options.blockId,
    startDate: options.startDate ?? current.startDate,
    derivedFrom: current.blockId,
    oneRepMax: {
      ...current.oneRepMax,
      [lift]: mround(current.oneRepMax[lift] * factor, increment(current.units)),
    },
  };
};
