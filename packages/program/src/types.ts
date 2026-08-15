/**
 * The domain vocabulary, from the atom upward.
 *
 *   Exercise                    a specific movement — "Barbell Squat"
 *   ExerciseActivity            ONE set of reps of one Exercise
 *     · PrescribedExerciseActivity   what a plan suggests
 *     · LoggedExerciseActivity       what actually happened
 *   SessionPlan                 a predetermined list of prescribed activities
 *   Program                     a PARAMETRISED schedule of SessionPlans
 *   Block                       one instantiation of a Program, on the calendar
 *
 * Two properties of this vocabulary are load-bearing and easy to lose.
 *
 * **Prescribed and logged are different types, not two states of one type.**
 * A prescription carries a rep *spec* ("4 to 6", "max reps") and a load *spec*
 * ("85% of the squat max, plus one increment"); a log carries a rep *count* and
 * a *weight*. Collapsing them into one record with optional fields is what makes
 * an application quietly report what it told you to do as though you had done it.
 *
 * **A logged activity needs nothing but a timestamp.** Attribution to a block or
 * a session is optional metadata on the log, never a foreign key the log depends
 * on. Logging is the primary act; programs are a convenience that suggests what
 * to log (ADR-0036).
 */

export type Units = "kg" | "lb";

/**
 * An Exercise is identified by its name.
 *
 * Not an opaque id, because the name is what the athlete types, what five years
 * of imported history is keyed on, and what a custom plan refers to. The curated
 * catalogue (`catalogue.ts`) is what gives a name its classification; the name
 * itself is the identity.
 */
export type ExerciseName = string;

/**
 * How many reps a prescribed activity asks for.
 *
 * `maxReps` and `maxRepsCapped` are the sets that *measure* the athlete rather
 * than instruct them — Candito's `MR`/`MR10`, Wendler's `+` sets. Every feedback
 * rule in every program keys off one of them.
 */
export type RepSpec =
  | { kind: "fixed"; reps: number }
  | { kind: "range"; min: number; max: number }
  | { kind: "maxReps" }
  | { kind: "maxRepsCapped"; cap: number }
  /**
   * "Do some" — the program names the exercise and declines to prescribe.
   *
   * The mirror of an unprescribed LOAD, and needed for the same reason: Candito
   * lists two free-choice accessories on its squat days with no set count and no
   * rep count at all. Modelling that as zero activities would drop the exercise
   * from the session entirely, which is how a denominator comes to disagree with
   * what is on screen.
   */
  | { kind: "unprescribed" };

/**
 * How a prescribed activity's load is determined.
 *
 * This is the single representation that makes a built-in program and a
 * hand-authored one the same kind of thing (ADR-0037). A built-in emits
 * `reference` specs against its declared parameters; a custom plan emits
 * `absolute` or `reference` specs against parameters the author declared. Both
 * go through one resolver.
 *
 * `preNudge` and `nudge` are counted in INCREMENTS, not in kilograms, and the
 * distinction between them is not cosmetic: whether a nudge falls inside or
 * outside the rounding changes the answer by a full increment (ADR-0021).
 */
export type LoadSpec =
  /** A literal weight in the block's units. */
  | { kind: "absolute"; weight: number }
  /** A percentage of a named parameter, rounded to the loadable increment. */
  | {
      kind: "reference";
      /** Parameter key — `"squat"`, `"benchTrainingMax"`, whatever the program declared. */
      ref: string;
      percentage: number;
      preNudge?: number | undefined;
      nudge?: number | undefined;
    }
  /** Deliberately left to the athlete's judgement. Accessory work, mostly. */
  | { kind: "unprescribed" };

/**
 * ONE prescribed set of reps of one exercise.
 *
 * A program that prescribes "5 sets of 3" produces FIVE of these, not one with a
 * count. That flattening is what lets a log line up with a prescription
 * one-to-one, which is the only way "I got 3, 3, 3, 2, 1" can be represented at
 * all.
 */
export interface PrescribedExerciseActivity {
  readonly kind: "prescribed";
  exercise: ExerciseName;
  /** 1-indexed ordinal of this set WITHIN this exercise, in this session. */
  setIndex: number;
  reps: RepSpec;
  load: LoadSpec;
  /**
   * The resolved absolute weight, filled in at rollout.
   *
   * Absent when `load.kind === "unprescribed"`. NEVER persisted (ADR-0001) —
   * it is recomputed from the block's parameters on every read.
   */
  weight?: number | undefined;
  /** Which slot this fills, when the program models slots. */
  role?: string | undefined;
  /** Guidance carried through from the program, e.g. rest intervals. */
  note?: string | undefined;
  /**
   * A rule that resolves once this activity is logged.
   *
   * It hangs off the TRIGGERING activity rather than off the session, so
   * "which set decides this" needs no lookup — it is the set you are looking at.
   */
  conditional?: ConditionalRule | undefined;
}

/**
 * ONE set of reps that actually happened.
 *
 * The timestamp is the only mandatory context. Everything linking it to a plan
 * is optional, because logging is not required to be about a plan.
 */
export interface LoggedExerciseActivity {
  readonly kind: "logged";
  /** Server-assigned. Part of the sort key, so two sets in one millisecond differ. */
  id: string;
  /** ISO 8601 instant. The one thing every logged activity has. */
  timestamp: string;
  exercise: ExerciseName;
  /** A COUNT, not a spec. What was achieved. */
  reps: number;
  /** Absolute load. Absent for bodyweight movements. */
  weight?: number | undefined;
  units: Units;
  /** Set ordinal within the session, when known. */
  setIndex?: number | undefined;
  /** OPTIONAL attribution. Absent for a freely logged activity. */
  blockId?: string | undefined;
  /** `B-20270810-W5D1`, when logged from a prescribed session. */
  sessionRef?: string | undefined;
  week?: number | undefined;
  day?: number | undefined;
  notes?: string | undefined;
  /** A correction names the record it replaces; nothing is edited in place. */
  supersedes?: string | undefined;
}

/** Either kind, where code genuinely handles both. */
export type ExerciseActivity = PrescribedExerciseActivity | LoggedExerciseActivity;

/**
 * A predetermined list of prescribed activities — the reusable template unit.
 *
 * A SessionPlan knows nothing about dates or about which block it belongs to. It
 * is the thing an athlete authors once ("Heavy Squat Day") and a Program
 * schedules many times.
 */
export interface SessionPlan {
  planId: string;
  name: string;
  /** Ordered. One entry per prescribed set. */
  activities: PrescribedExerciseActivity[];
  /** Prose carried verbatim from the program, or written by the author. */
  notes: string[];
  /** The sheet's intensity annotation, e.g. "50, 67.5, 75, 77.5%". */
  intensityLabel?: string | undefined;
}

/** What a Program needs before it can be rolled out. */
export type ParameterValue = number | string;
export type ProgramParameters = Record<string, ParameterValue>;

/**
 * One declared input.
 *
 * The `kind` drives the generic parameter form in the SPA, which is why a
 * program can be added without touching the UI: declare the parameters and the
 * form renders itself.
 */
export interface ProgramParameterSpec {
  key: string;
  label: string;
  /**
   * Drives both the form control and the validation.
   *
   * There is deliberately no `units` kind: units are a property of the BLOCK,
   * not of any one program, because the rollout needs them to pick the loadable
   * increment before any program-specific parameter is read.
   */
  kind: "oneRepMax" | "weight" | "exercise" | "integer" | "percentage" | "choice";
  /** For `choice`. */
  options?: readonly { value: string; label: string }[] | undefined;
  default?: ParameterValue | undefined;
  help?: string | undefined;
  /** Grouping hint for the form, e.g. "Maxes", "Accessories". */
  group?: string | undefined;
}

/** One SessionPlan placed in the schedule, before it meets a calendar. */
export interface ScheduledSession {
  /** 1-indexed week within the block. */
  week: number;
  /** 1-indexed training day within the week. */
  day: number;
  /** Offset in days from the block's start date. */
  dayOffset: number;
  /** The phase this session belongs to, e.g. "Linear Max OT Phase". */
  phase?: string | undefined;
  plan: SessionPlan;
}

/**
 * A Program: a parametrised schedule of SessionPlans.
 *
 * `schedule` is a pure function of the parameters and nothing else — no clock,
 * no storage, no network. Dates are applied afterwards by the rollout, so a
 * program never has to think about calendars.
 */
export interface Program {
  programId: string;
  name: string;
  /** One or two sentences. Shown in the picker. */
  description: string;
  /** Where the program comes from — an author, a book, a URL. */
  attribution?: string | undefined;
  origin: "builtin" | "custom";
  parameters: readonly ProgramParameterSpec[];
  schedule: (params: ProgramParameters) => ScheduledSession[];
  /**
   * Intermediate parameters computed from the declared ones, merged in before
   * any load spec resolves.
   *
   * 5/3/1 is the reason this exists: its percentages are of a TRAINING max
   * derived from the entered 1RM, and that max rises per cycle. Without this
   * hook the derivation would have to be inlined into every one of sixty set
   * definitions as a percentage of a percentage, which is how a program ends up
   * with two disagreeing definitions of its own training max.
   */
  derive?: ((params: ProgramParameters) => ProgramParameters) | undefined;
}

/**
 * A Session: a SessionPlan on the calendar, with every load resolved.
 *
 * Derived on every read, never stored.
 */
export interface Session {
  /** `B-20270810-W5D1` — addressable on its own. */
  sessionRef: string;
  week: number;
  day: number;
  dayOffset: number;
  /** ISO `YYYY-MM-DD`. */
  date: string;
  name: string;
  phase?: string | undefined;
  intensityLabel?: string | undefined;
  activities: PrescribedExerciseActivity[];
  notes: string[];
}

/**
 * What is STORED when a Program is instantiated.
 *
 * The parameters and the program's identity, and nothing else. Every session,
 * every activity and every weight is projected from this on read (ADR-0001).
 */
export interface BlockConfig {
  /** `B-{YYYYMMDD}` — the identity IS the start date (ADR-0033). */
  blockId: string;
  programId: string;
  /** ISO `YYYY-MM-DD`. Day 0 of week 1. */
  startDate: string;
  units: Units;
  parameters: ProgramParameters;
  /** `blockId` of the block whose results seeded this one. */
  derivedFrom?: string | undefined;
}

/** A BlockConfig with its sessions projected — the shape the app renders. */
export interface Block extends BlockConfig {
  program: { programId: string; name: string; origin: Program["origin"] };
  sessions: Session[];
}

// ---------------------------------------------------------------------------
// Programs that model a small set of named barbell lifts
// ---------------------------------------------------------------------------

/**
 * The lifts the built-in programs are projected from.
 *
 * `press` is the overhead press, which Candito does not use and both 5/3/1 and
 * StrongLifts do. `row` is the barbell row, which only StrongLifts uses. A
 * program declares which of these it needs as parameters; nothing here forces a
 * program to use all of them.
 */
export type LiftKey = "bench" | "squat" | "deadlift" | "press" | "row";

export const LIFT_KEYS: readonly LiftKey[] = [
  "bench",
  "squat",
  "deadlift",
  "press",
  "row",
] as const;

export const LIFT_LABELS: Record<LiftKey, string> = {
  bench: "Bench Press",
  squat: "Squat",
  deadlift: "Deadlift",
  press: "Overhead Press",
  row: "Barbell Row",
};

/** The three Candito projects from — kept named because several rules key on it. */
export const CANDITO_LIFTS: readonly LiftKey[] = ["bench", "squat", "deadlift"] as const;

/**
 * Which slot an exercise fills, where a program models slots.
 *
 * The slot is fixed by the program; the exercise that fills it is a parameter.
 */
export type ExerciseRole =
  | "primary"
  | "deadliftVariation"
  | "upperBackHorizontal"
  | "shoulder"
  | "upperBackVertical"
  | "optional"
  | "optionalLower"
  | "assistance";

/**
 * A rule a program can only state in prose, made computable.
 *
 * Bands are declared in descending order and are exhaustive; the first whose
 * `[minReps, maxReps]` window contains the achieved count wins.
 */
export interface ConditionalRule {
  triggerExercise: ExerciseName;
  description: string;
  outcomes: ConditionalOutcome[];
}

export interface ConditionalOutcome {
  minReps?: number;
  maxReps?: number;
  work?: { sets: number; reps: number; weightDelta: number };
  /** Multiplier applied to the seed max going forward. `0.975` is "reduce by 2.5%". */
  oneRepMaxFactor?: number;
  description: string;
}

/** The options Candito offers for its sixth week. */
export type WeekSixChoice = "skip" | "deload" | "test";

/**
 * A proposed seed for the next block, derived from a test set.
 *
 * A PROPOSAL: recorded, presented, and only becoming a `BlockConfig` when the
 * athlete accepts it (ADR-0013).
 */
export interface ProjectedMax {
  lift: LiftKey;
  achievedWeight: number;
  achievedReps: number;
  projected: number;
  projectedRounded: number;
  factor: number;
}

/** The eight accessory slots Candito leaves to the athlete. */
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
