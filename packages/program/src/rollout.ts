import { sessionRef } from "./identifiers.js";
import type {
  Block,
  BlockConfig,
  LoadSpec,
  PrescribedExerciseActivity,
  Program,
  ProgramParameters,
  Session,
  Units,
} from "./types.js";
import { workingWeight } from "./units.js";

/**
 * Rollout: the one path from a stored BlockConfig to dated, weight-resolved
 * sessions.
 *
 * There is exactly one of these, and every program — built-in or hand-authored —
 * goes through it. A program's own job stops at "which plan, on which day
 * offset"; percentages, rounding, unit increments and calendars are resolved
 * here, once. That is what stops three programs from growing three subtly
 * different rounding rules (ADR-0037).
 *
 * Pure: no clock, no storage, no network.
 */

/** Parse `YYYY-MM-DD` as UTC so a timezone west of Greenwich cannot shift it. */
const addDays = (isoDate: string, days: number): string => {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

/**
 * Read a parameter as a number.
 *
 * Returns `undefined` rather than throwing, and returns `undefined` for a
 * non-finite value too — a parameter that is absent and one that is `"abc"` are
 * the same problem from the resolver's point of view, and both must produce an
 * unprescribed set rather than a `NaN` weight rendered as "NaN kg".
 */
const numericParam = (params: ProgramParameters, key: string): number | undefined => {
  const raw = params[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

/**
 * Resolve one load spec to an absolute weight, or to nothing.
 *
 * `undefined` is a legitimate, expected answer in two cases: the spec is
 * deliberately unprescribed, or it references a parameter this block did not
 * supply. The second is what lets a program declare an optional lift — a 5/3/1
 * block with no overhead-press max still rolls out, and its press sets simply
 * carry no weight rather than carrying a wrong one.
 */
export const resolveLoad = (
  load: LoadSpec,
  params: ProgramParameters,
  units: Units,
): number | undefined => {
  if (load.kind === "unprescribed") return undefined;
  if (load.kind === "absolute") return load.weight;

  const base = numericParam(params, load.ref);
  if (base === undefined) return undefined;

  return workingWeight(base, load.percentage, units, {
    preNudge: load.preNudge,
    nudge: load.nudge,
  });
};

const resolveActivity = (
  activity: PrescribedExerciseActivity,
  params: ProgramParameters,
  units: Units,
): PrescribedExerciseActivity => {
  const weight = resolveLoad(activity.load, params, units);
  return weight === undefined ? { ...activity } : { ...activity, weight };
};

/**
 * Project a whole block: schedule → dates → resolved weights.
 *
 * This is the function ADR-0001 is about. Nothing it returns is persisted; a
 * corrected parameter re-projects the entire block from one write.
 */
export const rolloutBlock = (program: Program, config: BlockConfig): Session[] => {
  // Derived parameters are merged UNDER the declared ones, never over them: a
  // program computing an intermediate value must not be able to overwrite what
  // the athlete actually entered.
  const params: ProgramParameters = {
    ...(program.derive ? program.derive(config.parameters) : {}),
    ...config.parameters,
  };
  const scheduled = program.schedule(params);

  return (
    scheduled
      // A program may declare a week's identical days together for readability, so
      // the schedule is not guaranteed to be in calendar order. Sort once here
      // rather than contorting every program into emitting chronologically.
      .slice()
      .sort((a, b) => a.dayOffset - b.dayOffset || a.week - b.week || a.day - b.day)
      .map((entry) => ({
        sessionRef: sessionRef(config.blockId, entry.week, entry.day),
        week: entry.week,
        day: entry.day,
        dayOffset: entry.dayOffset,
        date: addDays(config.startDate, entry.dayOffset),
        name: entry.plan.name,
        ...(entry.phase === undefined ? {} : { phase: entry.phase }),
        ...(entry.plan.intensityLabel === undefined
          ? {}
          : { intensityLabel: entry.plan.intensityLabel }),
        activities: entry.plan.activities.map((a) => resolveActivity(a, params, config.units)),
        notes: [...entry.plan.notes],
      }))
  );
};

/** The stored config plus its projection — the shape the app renders. */
export const rollout = (program: Program, config: BlockConfig): Block => ({
  ...config,
  program: { programId: program.programId, name: program.name, origin: program.origin },
  sessions: rolloutBlock(program, config),
});

/** The sessions of one week, for the week-at-a-time view. */
export const rolloutWeek = (program: Program, config: BlockConfig, week: number): Session[] =>
  rolloutBlock(program, config).filter((s) => s.week === week);

/**
 * Fill in a program's declared defaults for anything the caller left out.
 *
 * Defaults live on the parameter SPEC rather than in the schedule function, so
 * the SPA can render a pre-filled form from the same declaration the engine
 * validates against — one source, not two that drift.
 */
export const withDefaults = (program: Program, params: ProgramParameters): ProgramParameters => {
  const merged: ProgramParameters = { ...params };
  for (const spec of program.parameters) {
    if (merged[spec.key] === undefined && spec.default !== undefined) {
      merged[spec.key] = spec.default;
    }
  }
  return merged;
};

/**
 * Which declared parameters are missing or unusable.
 *
 * Reported rather than thrown: a half-configured block is a normal state while
 * someone is filling in a form, and the caller decides whether that is a 400 or
 * a disabled button.
 */
export const missingParameters = (program: Program, params: ProgramParameters): string[] =>
  program.parameters
    .filter((spec) => {
      const value = params[spec.key];
      if (value === undefined || value === "") return true;
      if (spec.kind === "oneRepMax" || spec.kind === "weight") {
        return numericParam(params, spec.key) === undefined;
      }
      return false;
    })
    .map((spec) => spec.key);
