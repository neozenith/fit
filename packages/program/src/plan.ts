import type {
  ConditionalRule,
  ExerciseName,
  LoadSpec,
  PrescribedExerciseActivity,
  RepSpec,
  SessionPlan,
} from "./types.js";

/**
 * Builders for SessionPlans.
 *
 * A plan is a FLAT list of one activity per prescribed set, which is correct for
 * the model and verbose to write by hand: "5 sets of 3" is five records. These
 * builders restore the shorthand without reintroducing a set-count field that
 * a log could never line up against.
 *
 * The built-in programs use these. So does the compiler that turns a stored,
 * hand-authored plan into the same structure (`custom.ts`) — which is what makes
 * the claim "the built-ins are built on the custom foundation" checkable rather
 * than aspirational (ADR-0037).
 */

// --- Rep specs ---------------------------------------------------------------

export const fixed = (reps: number): RepSpec => ({ kind: "fixed", reps });
export const range = (min: number, max: number): RepSpec => ({ kind: "range", min, max });
export const MAX_REPS: RepSpec = { kind: "maxReps" };
export const maxRepsCapped = (cap: number): RepSpec => ({ kind: "maxRepsCapped", cap });
export const UNPRESCRIBED_REPS: RepSpec = { kind: "unprescribed" };

/** Render a rep spec the way the source programs write it: `x6`, `x4-6`, `xMR10`. */
export const repLabel = (spec: RepSpec): string => {
  switch (spec.kind) {
    case "fixed":
      return `×${spec.reps}`;
    case "range":
      return `×${spec.min}-${spec.max}`;
    case "maxReps":
      return "×MR";
    case "maxRepsCapped":
      return `×MR${spec.cap}`;
    case "unprescribed":
      return "as you judge";
  }
};

/** The rep count a prescription is satisfied by, for progress arithmetic. */
export const targetReps = (spec: RepSpec): number | undefined => {
  switch (spec.kind) {
    case "fixed":
      return spec.reps;
    case "range":
      return spec.min;
    case "maxRepsCapped":
      return spec.cap;
    default:
      return undefined;
  }
};

// --- Load specs --------------------------------------------------------------

export const absolute = (weight: number): LoadSpec => ({ kind: "absolute", weight });

/**
 * A percentage of a declared parameter.
 *
 * Nudges are counted in INCREMENTS. `preNudge` is applied before rounding and
 * `nudge` after, and the two give different answers by design (ADR-0021).
 */
export const percentageOf = (
  ref: string,
  percentage: number,
  options: { preNudge?: number; nudge?: number } = {},
): LoadSpec => ({
  kind: "reference",
  ref,
  percentage,
  ...(options.preNudge === undefined ? {} : { preNudge: options.preNudge }),
  ...(options.nudge === undefined ? {} : { nudge: options.nudge }),
});

export const UNPRESCRIBED: LoadSpec = { kind: "unprescribed" };

// --- Activity builders -------------------------------------------------------

export interface ActivitySpec {
  exercise: ExerciseName;
  reps: RepSpec;
  load?: LoadSpec | undefined;
  role?: string | undefined;
  note?: string | undefined;
  conditional?: ConditionalRule | undefined;
}

/** The exercise a program names but declines to prescribe. */
export const freeChoice = (exercise: ExerciseName, role?: string): ActivitySpec => ({
  exercise,
  reps: UNPRESCRIBED_REPS,
  load: UNPRESCRIBED,
  ...(role === undefined ? {} : { role }),
});

/** One activity — one set. `setIndex` is assigned when the plan is assembled. */
export const activity = (spec: ActivitySpec): ActivitySpec => spec;

/** `count` identical sets, e.g. Candito's `=C5` chain or StrongLifts' 5×5. */
export const repeat = (count: number, spec: ActivitySpec): ActivitySpec[] =>
  Array.from({ length: count }, () => spec);

/** Sets at explicit rep counts, all at one load: the sheet's `x10 | x10 | x8 | x6`. */
export const ladder = (
  exercise: ExerciseName,
  reps: readonly number[],
  options: { load?: LoadSpec; role?: string; note?: string } = {},
): ActivitySpec[] =>
  reps.map((r) => ({
    exercise,
    reps: fixed(r),
    load: options.load ?? UNPRESCRIBED,
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(options.note === undefined ? {} : { note: options.note }),
  }));

/**
 * Assemble a SessionPlan, numbering each exercise's sets independently.
 *
 * `setIndex` counts within an exercise rather than across the session, because
 * that is the number the athlete uses — "set 3 of the squat", not "the eleventh
 * thing I did today". It is also what a logged activity carries, so the two line
 * up without a lookup.
 */
export const sessionPlan = (
  planId: string,
  name: string,
  specs: readonly ActivitySpec[],
  options: { notes?: readonly string[]; intensityLabel?: string } = {},
): SessionPlan => {
  const seen = new Map<string, number>();
  const activities: PrescribedExerciseActivity[] = specs.map((spec) => {
    const n = (seen.get(spec.exercise) ?? 0) + 1;
    seen.set(spec.exercise, n);
    return {
      kind: "prescribed",
      exercise: spec.exercise,
      setIndex: n,
      reps: spec.reps,
      load: spec.load ?? UNPRESCRIBED,
      ...(spec.role === undefined ? {} : { role: spec.role }),
      ...(spec.note === undefined ? {} : { note: spec.note }),
      ...(spec.conditional === undefined ? {} : { conditional: spec.conditional }),
    };
  });

  return {
    planId,
    name,
    activities,
    notes: [...(options.notes ?? [])],
    ...(options.intensityLabel === undefined ? {} : { intensityLabel: options.intensityLabel }),
  };
};

/**
 * Group a session's activities back into per-exercise runs, in first-seen order.
 *
 * Every renderer wants this — a flat list of fifteen sets is not how a session
 * reads on paper. Grouping is a VIEW built here rather than a shape stored on
 * the plan, so the stored model stays one-activity-per-set.
 */
export interface ExerciseGroup {
  exercise: ExerciseName;
  role?: string | undefined;
  note?: string | undefined;
  activities: PrescribedExerciseActivity[];
}

export const groupByExercise = (
  activities: readonly PrescribedExerciseActivity[],
): ExerciseGroup[] => {
  const groups = new Map<string, ExerciseGroup>();
  for (const a of activities) {
    const existing = groups.get(a.exercise);
    if (existing) {
      existing.activities.push(a);
      continue;
    }
    groups.set(a.exercise, {
      exercise: a.exercise,
      role: a.role,
      note: a.note,
      activities: [a],
    });
  }
  return [...groups.values()];
};
