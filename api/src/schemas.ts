import { EQUIPMENT, MOVEMENTS } from "@fit/program";
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

export const accessoriesSchema = z.object({
  upperBackHorizontal: z.string().min(1),
  shoulder: z.string().min(1),
  upperBackVertical: z.string().min(1),
  optional1: z.string().min(1),
  optional2: z.string().min(1),
  optionalLower1: z.string().min(1),
  optionalLower2: z.string().min(1),
  deadliftVariation: z.string().min(1),
});

/**
 * A one-rep max has to be a positive, finite number.
 *
 * The upper bound is not paranoia about world records — it is a guard against
 * a units mix-up. Someone entering a kilogram max into a pound-configured
 * block produces a plausible-looking number; someone fat-fingering an extra
 * digit produces 4000, and every prescribed weight in the block silently
 * becomes unliftable.
 */
const oneRepMax = z.number().positive().max(1000);

export const createBlockSchema = z.object({
  startDate: isoDate,
  units: unitsSchema,
  oneRepMax: z.object({
    bench: oneRepMax,
    squat: oneRepMax,
    deadlift: oneRepMax,
  }),
  accessories: accessoriesSchema.partial().optional(),
  derivedFrom: z.string().optional(),
});

export const testResultsSchema = z.object({
  blockId: z.string().min(1),
  startDate: isoDate,
  results: z
    .array(
      z.object({
        lift: z.enum(["bench", "squat", "deadlift"]),
        weight: z.number().positive().max(1000),
        // The program defines behaviour for 1-4; beyond that the engine
        // extrapolates and says so. Zero is a failed lift and projects nothing.
        reps: z.number().int().min(0).max(20),
      }),
    )
    .max(3),
});

export const logSetSchema = z.object({
  timestamp: isoInstant.optional(),
  exercise: z.string().min(1).max(120),
  weight: z.number().nonnegative().max(1000).optional(),
  reps: z.number().int().min(0).max(200),
  units: unitsSchema,
  setIndex: z.number().int().positive().max(50).optional(),
  blockId: z.string().optional(),
  week: z.number().int().min(1).max(6).optional(),
  day: z.number().int().min(1).max(7).optional(),
  notes: z.string().max(500).optional(),
});

/** A whole session's sets in one request — the normal case, not the exception. */
export const logSetsSchema = z.object({
  sets: z.array(logSetSchema).min(1).max(200),
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
 * `equipment` and `movement` are enums drawn from the program package, so the
 * two axes cannot drift between the client, the API and the seed data.
 */
export const catalogueEntrySchema = z.object({
  exercise: z.string().trim().min(1).max(120),
  equipment: z.enum(EQUIPMENT),
  movement: z.enum(MOVEMENTS),
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
