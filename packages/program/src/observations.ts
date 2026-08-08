import type { LiftKey, Units } from "./types.js";

/**
 * Observations: what actually happened, as opposed to what was prescribed.
 *
 * Append-only by construction (ADR-0013). A correction is a new record whose
 * `supersedes` names the record it replaces; nothing is ever edited in place,
 * so "what did I believe in March" stays answerable.
 */

export interface SetRecord {
  /** ISO 8601 instant the set was logged. Part of the sort key. */
  timestamp: string;
  /** Free text — matches the prescription's exercise name when it can. */
  exercise: string;
  /**
   * Absolute load in `units`. Absent for bodyweight movements — explicitly
   * `| undefined` because the importer builds records positionally and a
   * bodyweight set must be able to carry the key with no value.
   */
  weight?: number | undefined;
  reps: number;
  units: Units;
  /** Set ordinal within the session, 1-indexed, when known. */
  setIndex?: number;
  /** Links the record to a prescribed session, when logged from one. */
  blockId?: string;
  week?: number;
  day?: number;
  /** Marks this record as replacing an earlier one. */
  supersedes?: string;
  notes?: string;
}

export interface CardioRecord {
  timestamp: string;
  activity: string;
  /** Elapsed time in seconds. */
  durationSeconds?: number;
  /** Distance in metres. */
  distanceMetres?: number;
  notes?: string;
}

export type MeasurementKind = "bodyWeight" | "waistCircumference";

export interface MeasurementRecord {
  timestamp: string;
  kind: MeasurementKind;
  /** Kilograms for body weight, centimetres for circumference. */
  value: number;
  supersedes?: string;
}

// ---------------------------------------------------------------------------
// Importers for the source spreadsheet's log sheets.
//
// The sheets were filled by hand over months and the formats drifted: a single
// "weight" cell might read `60`, or `50,60,60,60` meaning four sets, and a
// "time interval" might read `2m12s` or `2:02`. Parsing that mess belongs here,
// once, rather than in every consumer.
// ---------------------------------------------------------------------------

/**
 * Split a spreadsheet cell that packed several sets into one value.
 *
 * `"50,60,60,60"` with reps `6` means four sets of six at ascending loads;
 * `"10,8,6"` in the reps column with weight `50` means three sets at 50.
 * Returns `[]` for an empty cell so callers can distinguish "not recorded"
 * from "recorded as zero".
 */
export const splitPackedCell = (cell: string | number | undefined | null): number[] => {
  if (cell === undefined || cell === null || cell === "") return [];
  if (typeof cell === "number") return [cell];
  return String(cell)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
};

/**
 * Parse the two duration formats the sheet used interchangeably.
 *
 * Accepts `2m12s`, `2:02`, `1h02m03s`, `1:02:03` and a bare number of seconds.
 * Returns `undefined` rather than `NaN` for anything unrecognised, so a garbled
 * cell drops out of the import instead of poisoning an average.
 */
export const parseDuration = (raw: string | number | undefined | null): number | undefined => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  const text = String(raw).trim().toLowerCase();

  const colon = text.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/);
  if (colon) {
    const [, a, b, c] = colon;
    return c === undefined
      ? Number(a) * 60 + Number(b) // m:ss
      : Number(a) * 3600 + Number(b) * 60 + Number(c); // h:mm:ss
  }

  const units = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (units?.slice(1).some(Boolean)) {
    const [, h, m, s] = units;
    return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  }

  const bare = Number(text);
  return Number.isFinite(bare) ? bare : undefined;
};

/**
 * Expand one spreadsheet activity row into the set records it actually meant.
 *
 * The row is the ambiguous unit; the set is the unambiguous one. Whichever of
 * weight/reps carries multiple values decides how many sets the row describes,
 * and the scalar side is repeated across them. When both are packed they must
 * agree in length — a `50,60` weight against `10,8,6` reps is a data-entry
 * error, and the importer surfaces it rather than guessing an alignment.
 */
export const expandActivityRow = (row: {
  timestamp: string;
  exercise: string;
  weight?: string | number | null;
  sets?: number | null;
  reps?: string | number | null;
  units: Units;
}): SetRecord[] => {
  const weights = splitPackedCell(row.weight);
  const reps = splitPackedCell(row.reps);
  if (reps.length === 0) return [];

  const declaredSets = row.sets ?? 0;
  const count = Math.max(weights.length, reps.length, declaredSets, 1);

  if (weights.length > 1 && reps.length > 1 && weights.length !== reps.length) {
    throw new Error(
      `Ambiguous activity row for "${row.exercise}" at ${row.timestamp}: ` +
        `${weights.length} weights against ${reps.length} rep counts.`,
    );
  }

  return Array.from({ length: count }, (_, i) => ({
    timestamp: row.timestamp,
    exercise: row.exercise,
    weight: weights.length === 0 ? undefined : (weights[Math.min(i, weights.length - 1)] as number),
    reps: reps[Math.min(i, reps.length - 1)] as number,
    units: row.units,
    setIndex: i + 1,
  }));
};

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/**
 * Estimated 1RM from a real set, via the Epley formula (`w × (1 + r/30)`).
 *
 * Distinct from `projectMax` in `projection.ts`, which implements the
 * program's *own* rep table for seeding the next block. Epley is the general
 * estimator used for charting progress across every logged set; the program
 * table is the authority for what the next block is built on. Keeping them
 * separate means improving the chart cannot silently change the training plan.
 */
export const estimatedOneRepMax = (weight: number, reps: number): number =>
  reps <= 0 ? Number.NaN : weight * (1 + reps / 30);

/**
 * Best estimated 1RM per lift across a set of records.
 *
 * This is the "Max To Date" column the source sheet tracked by hand.
 */
export const personalBests = (
  records: SetRecord[],
  liftNames: Record<LiftKey, string>,
): Partial<
  Record<LiftKey, { weight: number; reps: number; estimated: number; timestamp: string }>
> => {
  const out: Partial<
    Record<LiftKey, { weight: number; reps: number; estimated: number; timestamp: string }>
  > = {};
  for (const [lift, name] of Object.entries(liftNames) as [LiftKey, string][]) {
    for (const r of records) {
      if (r.exercise.toLowerCase() !== name.toLowerCase() || r.weight === undefined) continue;
      const estimated = estimatedOneRepMax(r.weight, r.reps);
      const best = out[lift];
      if (!best || estimated > best.estimated) {
        out[lift] = { weight: r.weight, reps: r.reps, estimated, timestamp: r.timestamp };
      }
    }
  }
  return out;
};

/**
 * Median of a numeric series.
 *
 * The source sheet tracks *median* body weight per week, not mean, and that is
 * the right call: a single post-meal weigh-in skews a mean by a kilogram, and
 * the whole point of the weekly rollup is to see through daily noise.
 */
export const median = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
};

/** Weekly median per measurement kind — the sheet's two rollup columns. */
export const weeklyMedians = (
  records: MeasurementRecord[],
  weekStartDates: string[],
): Array<{ weekStart: string } & { [K in MeasurementKind]?: number | undefined }> =>
  weekStartDates.map((weekStart, i) => {
    const next = weekStartDates[i + 1];
    const inWeek = records.filter((r) => {
      const day = r.timestamp.slice(0, 10);
      return day >= weekStart && (next === undefined || day < next);
    });
    return {
      weekStart,
      bodyWeight: median(inWeek.filter((r) => r.kind === "bodyWeight").map((r) => r.value)),
      waistCircumference: median(
        inWeek.filter((r) => r.kind === "waistCircumference").map((r) => r.value),
      ),
    };
  });
