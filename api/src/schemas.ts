import { z } from "zod";

/**
 * Every shape that crosses the trust boundary.
 *
 * The compiler validates shapes *inside* the service; these validate shapes
 * coming *into* it. `.parse()` throws, and a thrown `ZodError` at the boundary
 * is the correct failure signal — the router turns it into a 400 naming the
 * offending field, which is far more useful than a 500 three frames deeper.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
// `z.string().datetime()` is deprecated in zod 4; `z.iso.datetime()` is the
// replacement and accepts an offset, which matters because a client in
// Australia sends `+11:00`, not `Z`.
const isoInstant = z.iso.datetime({ offset: true });

export const unitsSchema = z.enum(["kg", "lb"]);

/**
 * A weight-shaped parameter has to be a positive, finite number under 1000.
 *
 * The upper bound is not paranoia about world records — it is a guard against a
 * units mix-up. Someone entering a kilogram max into a pound-configured block
 * produces a plausible-looking number; someone fat-fingering an extra digit
 * produces 4000, and every prescribed weight in the block silently becomes
 * unliftable.
 *
 * It is enforced inside `parameterValue` below rather than as a named schema,
 * because the parameter bag is open: which keys are weights is a fact the
 * PROGRAM declares, not one this file can enumerate.
 */

/**
 * One program parameter value.
 *
 * A bounded string OR a number, and deliberately nothing else. The parameter bag
 * is open by design — a program declares its own keys, and a custom program's
 * keys are authored by the athlete — so the schema cannot enumerate them. What
 * it CAN do is bound each value, which is where the real risk is: a 4000 in a
 * max makes every prescribed weight in the block unliftable.
 */
const parameterValue = z.union([z.number().finite().min(-10000).max(10000), z.string().max(120)]);

export const programParametersSchema = z
  .record(z.string().min(1).max(60), parameterValue)
  // A bag with a thousand keys is not a training block, it is an attack.
  .refine((p) => Object.keys(p).length <= 100, {
    message: "a program may declare at most 100 parameters",
  });

/**
 * Instantiate a Program into a Block.
 *
 * `programId` is required and NOT defaulted here. A block whose program is
 * implicit is a block nobody can re-roll correctly later, and the historical
 * default belongs at the migration boundary (`repo`/read path), not at the
 * write path where it would quietly stamp new blocks with an assumption.
 */
export const createBlockSchema = z.object({
  programId: z.string().min(1).max(80),
  startDate: isoDate,
  units: unitsSchema,
  parameters: programParametersSchema,
  derivedFrom: z.string().optional(),
});

export const testResultsSchema = z.object({
  blockId: z.string().min(1),
  startDate: isoDate,
  results: z
    .array(
      z.object({
        lift: z.enum(["bench", "squat", "deadlift", "press", "row"]),
        weight: z.number().positive().max(1000),
        // The program defines behaviour for 1-4; beyond that the engine
        // extrapolates and says so. Zero is a failed lift and projects nothing.
        reps: z.number().int().min(0).max(20),
      }),
    )
    .max(3),
});

/**
 * ONE logged exercise activity — one set of reps of one exercise.
 *
 * Everything attributing it to a plan is OPTIONAL, and that is the model, not a
 * convenience (ADR-0036). Logging is the primary act: an activity with an
 * exercise, a rep count and a timestamp is complete. `blockId`, `sessionRef`,
 * `week` and `day` are metadata a session-driven log happens to know.
 *
 * `week` is bounded at 60 rather than 6 because a 5×5 block runs twelve weeks by
 * default and a 5/3/1 block runs four per cycle. The old bound of 6 was Candito
 * leaking into a shape that is not Candito's.
 */
export const logActivitySchema = z.object({
  timestamp: isoInstant.optional(),
  exercise: z.string().min(1).max(120),
  weight: z.number().nonnegative().max(1000).optional(),
  reps: z.number().int().min(0).max(200),
  units: unitsSchema,
  setIndex: z.number().int().positive().max(50).optional(),
  blockId: z.string().max(80).optional(),
  sessionRef: z.string().max(120).optional(),
  week: z.number().int().min(1).max(60).optional(),
  day: z.number().int().min(1).max(7).optional(),
  notes: z.string().max(500).optional(),
  /** A correction names the record it replaces; nothing is edited in place. */
  supersedes: z.string().max(80).optional(),
});

/** A whole session's activities in one request — the normal case, not the exception. */
export const logActivitiesSchema = z.object({
  activities: z.array(logActivitySchema).min(1).max(200),
});

/**
 * The pre-rebuild request shape, still accepted.
 *
 * A deployed SPA is not upgraded atomically with the API — a browser tab open
 * across the release still posts `{sets: [...]}`. Rejecting it would lose a
 * session's work for the sake of a field name, so both shapes are accepted and
 * normalised at the boundary (ADR-0038).
 */
export const legacyLogSetsSchema = z.object({
  sets: z.array(logActivitySchema).min(1).max(200),
});

export const measurementSchema = z.object({
  timestamp: isoInstant.optional(),
  kind: z.enum(["bodyWeight", "waistCircumference"]),
  // Covers both a body weight in kilograms and a circumference in centimetres.
  // A single bound for two units is loose by construction; it is here to catch
  // a decimal-point slip, not to validate physiology.
  value: z.number().positive().max(500),
});

export const seasonPlanSchema = z.object({
  startDate: isoDate,
  weeks: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("block"),
          blockNumber: z.number().int().positive(),
          weekOfBlock: z.number().int().min(1).max(6),
        }),
        z.object({
          kind: z.literal("event"),
          event: z.enum(["ZWIFT_FTP", "PARKRUN", "BREAK", "DELOAD"]),
        }),
      ]),
    )
    .max(60),
});

/**
 * Relative windows, counted back from today.
 *
 * Relative rather than absolute because that is what a cost question actually
 * is — "what did the last week cost", not "what did 2026-08-02 to 2026-08-09
 * cost". It also keeps a shared URL meaningful next month instead of frozen on
 * a week nobody is asking about any more.
 */
export const FINOPS_RANGE_DAYS: Record<string, number | null> = {
  "1d": 1,
  "3d": 3,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

/** Bucket widths, coarsest-last. The export is HOURLY, so `hour` is real data. */
export const FINOPS_GRAINS = ["hour", "day", "week", "month"] as const;

export const finopsQuerySchema = z.object({
  range: z.enum(["1d", "3d", "7d", "30d", "90d", "all"]).default("30d"),

  /**
   * Bucket width. Omitted, it is derived from the range.
   *
   * An hourly bucket over a year is 8760 points of noise; a monthly bucket over
   * three hours is one bar. Deriving it means the common case needs no second
   * parameter, and naming it means a URL can still pin an unusual pair.
   */
  grain: z.enum(FINOPS_GRAINS).optional(),

  /**
   * Restrict to one environment, or omit for all three.
   *
   * Every environment can see every environment's costs (ADR-0015) — the data
   * is account-scoped, and hiding dev's spend from prod's page would only make
   * the total unexplainable.
   */
  environment: z.enum(["dev", "test", "prod"]).optional(),
  groupBy: z.enum(["service", "environment", "stack"]).default("service"),
});

const historyWindowShape = {
  /** Inclusive, `YYYY-MM-DD`. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
};

/**
 * Query for the imported-history volume series.
 *
 * `grain` is an enum rather than a string because it is interpolated into
 * `date_trunc()` — the one place in the history queries where a value reaches
 * SQL as text rather than as a bound parameter, since DuckDB will not bind an
 * identifier. Constraining it here is what makes that interpolation safe.
 */
export const historyVolumeQuerySchema = z.object({
  grain: z.enum(["day", "week", "month"]).default("month"),
  /** Restrict to one movement; omit for every exercise. */
  exercise: z.string().min(1).max(120).optional(),
  /** Restrict to one equipment category, as classified by the curation step. */
  equipment: z.string().min(1).max(60).optional(),
  ...historyWindowShape,
});

/**
 * The date window shared by every history subpage.
 *
 * ABSOLUTE dates, unlike the FinOps ranges, and the difference is the data. The
 * archive ends in 2023; a relative "last 30 days" window over it is empty every
 * time, so a preset has to be counted back from the last RECORDED day rather
 * than from today. The API therefore takes explicit bounds and reports the
 * dataset's own extent, and the UI turns that into presets.
 */
export const historyWindowSchema = z.object(historyWindowShape);

/**
 * One curated catalogue entry.
 *
 * The WHOLE entry, not a patch: the UI edits one row with every field on
 * screen, so a partial update would add a merge step that could disagree with
 * what the editor was looking at.
 *
 * `equipment` and `movement` are BOUNDED STRINGS, not enums.
 *
 * They used to be `z.enum` over the program package's constants, which is what
 * made the two axes un-extendable without a deploy. They are vocabularies now
 * (see vocabulary.ts), so the schema's job here is length and shape only.
 *
 * That is a real loosening and worth naming: a typo'd movement is no longer
 * rejected at the boundary. It is caught where it matters instead — the
 * catalogue UI picks from the stored vocabulary rather than free-typing, and a
 * movement no slot can satisfy shows up as an empty picker with a warning
 * rather than as a 400 nobody sees.
 */
export const catalogueEntrySchema = z.object({
  exercise: z.string().trim().min(1).max(120),
  equipment: z.string().trim().min(1).max(40),
  movement: z.string().trim().min(1).max(40),
  unilateral: z.boolean().optional(),
  isometric: z.boolean().optional(),
  bodyweightLoaded: z.boolean().optional(),
  /** Hidden from pickers without erasing its history (ADR-0013). */
  retired: z.boolean().optional(),
});

/**
 * Delete, restore or reset one block.
 *
 * All three are APPEND-ONLY state records, not mutations — the API role has no
 * `DeleteItem` (ADR-0013), so "delete" hides a block and "reset" watermarks its
 * progress. Nothing written is ever unwritten, which is what makes `restore` a
 * first-class action rather than a recovery procedure.
 */
export const blockStateSchema = z.object({
  action: z.enum(["delete", "restore", "reset"]),
});

/**
 * One vocabulary word.
 *
 * The key is what catalogue entries and `SLOT_MOVEMENT` reference, so it is
 * immutable by construction: a relabel keeps the key and only the display text
 * moves. Retiring is how a word is removed, because storage is append-only
 * (ADR-0013) and every historical entry that used the word still has to read.
 */
export const vocabularyWordSchema = z.object({
  key: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(60),
  retired: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Authoring: SessionPlans, and the custom Programs built from them
// ---------------------------------------------------------------------------

/**
 * How many reps a prescribed activity asks for.
 *
 * A discriminated union rather than a loose object, so `{kind: "range"}` with no
 * bounds is rejected at the boundary instead of rendering as "×undefined-undefined".
 */
export const repSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), reps: z.number().int().min(0).max(200) }),
  z.object({
    kind: z.literal("range"),
    min: z.number().int().min(0).max(200),
    max: z.number().int().min(0).max(200),
  }),
  z.object({ kind: z.literal("maxReps") }),
  z.object({ kind: z.literal("maxRepsCapped"), cap: z.number().int().min(1).max(200) }),
  z.object({ kind: z.literal("unprescribed") }),
]);

/**
 * How a prescribed activity's load is determined.
 *
 * Nudges are bounded tightly: they are counted in INCREMENTS, so ±10 is already
 * a 25kg swing. A four-digit nudge is a typo or an attack, never a program.
 */
export const loadSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absolute"), weight: z.number().nonnegative().max(1000) }),
  z.object({
    kind: z.literal("reference"),
    ref: z.string().min(1).max(60),
    percentage: z.number().min(0).max(3),
    preNudge: z.number().int().min(-10).max(10).optional(),
    nudge: z.number().int().min(-10).max(10).optional(),
  }),
  z.object({ kind: z.literal("unprescribed") }),
]);

/**
 * ONE prescribed set, as the plan editor posts it.
 *
 * No `setIndex`: the server re-derives it from position, so a reordered or
 * partially-deleted list cannot leave a gap in the numbering.
 */
export const planActivitySchema = z.object({
  exercise: z.string().trim().min(1).max(120),
  reps: repSpecSchema,
  load: loadSpecSchema,
  role: z.string().max(40).optional(),
  note: z.string().max(300).optional(),
});

export const sessionPlanSchema = z.object({
  planId: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
  intensityLabel: z.string().max(120).optional(),
  notes: z.array(z.string().max(500)).max(20).default([]),
  activities: z.array(planActivitySchema).min(1).max(200),
});

export const programParameterSpecSchema = z.object({
  key: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(120),
  kind: z.enum(["oneRepMax", "weight", "exercise", "integer", "percentage", "choice"]),
  options: z
    .array(z.object({ value: z.string().max(60), label: z.string().max(120) }))
    .max(20)
    .optional(),
  default: z.union([z.number().finite(), z.string().max(120)]).optional(),
  help: z.string().max(500).optional(),
  group: z.string().max(60).optional(),
});

/**
 * A custom Program definition.
 *
 * `dayOffset` is authored directly rather than derived from week and day,
 * because a real training week is irregular — Candito's own week 1 lands on days
 * 0, 1, 3, 4 and 5. Deriving the offset would force every custom program onto a
 * tiling that no actual program uses.
 */
export const customProgramSchema = z.object({
  programId: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(""),
  parameters: z.array(programParameterSpecSchema).max(60).default([]),
  schedule: z
    .array(
      z.object({
        planId: z.string().min(1).max(80),
        week: z.number().int().min(1).max(60),
        day: z.number().int().min(1).max(7),
        dayOffset: z.number().int().min(0).max(420),
        phase: z.string().max(120).optional(),
      }),
    )
    .max(400)
    .default([]),
  retired: z.boolean().optional(),
});
