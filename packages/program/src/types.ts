/**
 * Domain types for the Candito 6-Week Strength Program.
 *
 * Nothing here describes storage. Per ADR-0001 the program is a pure function
 * `(BlockConfig) => Session[]`; only `BlockConfig` and logged observations are
 * ever persisted, and every weight below is recomputed on read.
 */

export type Units = "kg" | "lb";

/** The three barbell lifts the whole program is projected from. */
export type LiftKey = "bench" | "squat" | "deadlift";

export const LIFT_KEYS: readonly LiftKey[] = ["bench", "squat", "deadlift"] as const;

export const LIFT_LABELS: Record<LiftKey, string> = {
  bench: "Bench Press",
  squat: "Squat",
  deadlift: "Deadlift",
};

/**
 * Which slot an exercise fills. The slot is fixed by the program; the exercise
 * that fills it is the athlete's choice (`BlockConfig.accessories`).
 */
export type ExerciseRole =
  | "primary" // bench / squat / deadlift — the projected lifts
  | "deadliftVariation" // stiff-legged, snatch-grip, deficit or pause DL
  | "upperBackHorizontal"
  | "shoulder"
  | "upperBackVertical"
  | "optional"
  | "optionalLower";

/**
 * How many reps a prescribed set asks for.
 *
 * `maxReps` is the spreadsheet's `MR`, `maxRepsCapped` its `MR10` ("max reps
 * but no more than 10"). Both are the sets that *measure* the athlete — every
 * feedback rule in the program keys off one of them.
 */
export type RepSpec =
  | { kind: "fixed"; reps: number }
  | { kind: "range"; min: number; max: number }
  | { kind: "maxReps" }
  | { kind: "maxRepsCapped"; cap: number };

export interface PrescribedSet {
  /**
   * Absolute working weight in `BlockConfig.units`, already rounded to the
   * loadable increment. Absent for accessory work, which the program
   * deliberately leaves to the athlete's judgement.
   */
  weight?: number;
  reps: RepSpec;
}

export interface PrescribedExercise {
  /** Display name — resolved from `BlockConfig.accessories` for non-primary roles. */
  exercise: string;
  role: ExerciseRole;
  /** Empty for "warm up and work up" entries the sheet leaves unprescribed. */
  sets: PrescribedSet[];
  /** Free-text guidance carried through from the program, e.g. rest intervals. */
  note?: string;
  /** Feedback rules that resolve once the athlete logs an `MR`/`MR10` set. */
  conditional?: ConditionalRule;
}

/**
 * A rule the spreadsheet could only state in prose, made computable.
 *
 * Every outcome band is keyed on the rep count achieved on `triggerExercise`'s
 * max-reps set. The first band whose `[min, max]` window contains the achieved
 * reps wins; bands are declared in descending order and are exhaustive.
 */
export interface ConditionalRule {
  triggerExercise: string;
  description: string;
  outcomes: ConditionalOutcome[];
}

export interface ConditionalOutcome {
  /** Inclusive lower bound on reps achieved. Omit for "no lower bound". */
  minReps?: number;
  /** Inclusive upper bound on reps achieved. Omit for "no upper bound". */
  maxReps?: number;
  /** Back-off work to perform, if any. */
  work?: { sets: number; reps: number; weightDelta: number };
  /**
   * Multiplier to apply to the block's seed 1RM for this lift going forward.
   * `0.975` is the program's "reduce your max by 2.5%" instruction.
   */
  oneRepMaxFactor?: number;
  description: string;
}

export interface Session {
  /** 1-indexed week within the block. */
  week: number;
  /** 1-indexed training day within the week. */
  day: number;
  /** ISO `YYYY-MM-DD`, derived from `BlockConfig.startDate` plus the day offset. */
  date: string;
  /** Offset in days from the block start — the spreadsheet's `Inputs!B8 + n`. */
  dayOffset: number;
  /** Human title of the week's phase, e.g. "Linear Max OT Phase". */
  weekTitle: string;
  /** The sheet's intensity annotation for the day, e.g. "50, 67.5, 75, 77.5%". */
  intensityLabel?: string;
  exercises: PrescribedExercise[];
  /** Week-level prose carried verbatim from the program. */
  notes: string[];
}

export interface AccessoryChoices {
  upperBackHorizontal: string;
  shoulder: string;
  upperBackVertical: string;
  optional1: string;
  optional2: string;
  optionalLower1: string;
  optionalLower2: string;
  deadliftVariation: string;
}

export interface BlockConfig {
  /** Stable identifier; a new block is a new item, never an update (ADR-0013). */
  blockId: string;
  /** ISO `YYYY-MM-DD`. Day 0 of Week 1. */
  startDate: string;
  units: Units;
  /** The seed the entire six weeks is projected from. */
  oneRepMax: Record<LiftKey, number>;
  accessories: AccessoryChoices;
  /** `blockId` of the block whose Week 6 projection seeded this one. */
  derivedFrom?: string;
}

/** The options the program offers for Week 6. */
export type WeekSixChoice = "skip" | "deload" | "test";

/**
 * A proposed seed for the next block, derived from Week 5's max-reps set.
 *
 * Per ADR-0013 this is a *proposal*: it is recorded, presented, and only
 * becomes a `BlockConfig` when the athlete accepts it. An unaccepted projection
 * never silently changes the next block's prescription.
 */
export interface ProjectedMax {
  lift: LiftKey;
  /** The weight actually lifted on the Week 5 test set. */
  achievedWeight: number;
  /** Reps completed on that set (the program defines behaviour for 1–4). */
  achievedReps: number;
  /** `achievedWeight × factor`, unrounded. */
  projected: number;
  /** `projected` rounded to the loadable increment — the value that seeds the next block. */
  projectedRounded: number;
  /** 1.00 / 1.03 / 1.06 / 1.09 for 1 / 2 / 3 / 4 reps. */
  factor: number;
}
