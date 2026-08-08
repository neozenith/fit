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

export const finopsQuerySchema = z.object({
  /** Inclusive start month, `YYYY-MM`. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
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
