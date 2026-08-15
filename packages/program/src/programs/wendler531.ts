import {
  type ActivitySpec,
  fixed,
  MAX_REPS,
  percentageOf,
  repeat,
  sessionPlan,
  UNPRESCRIBED,
} from "../plan.js";
import type { LiftKey, Program, ProgramParameters, ScheduledSession } from "../types.js";
import { LIFT_LABELS } from "../types.js";

/**
 * Jim Wendler's 5/3/1.
 *
 * Four main lifts, one per training day, on a repeating four-week cycle:
 *
 *   Week 1   5 / 5 / 5+     at 65, 75, 85% of the TRAINING max
 *   Week 2   3 / 3 / 3+     at 70, 80, 90%
 *   Week 3   5 / 3 / 1+     at 75, 85, 95%
 *   Week 4   5 / 5 / 5      at 40, 50, 60%  — deload, no AMRAP
 *
 * Two things about it are easy to get wrong and are the reason it is modelled
 * rather than approximated.
 *
 * **Percentages are of the TRAINING max, not the true max.** The training max is
 * 90% of a tested 1RM by default, and the whole program is calibrated around
 * finishing sets with reps in reserve. Feeding a true 1RM into these percentages
 * makes every session roughly 10% too heavy, which is precisely the failure mode
 * the training max exists to prevent. The parameters therefore take a 1RM and a
 * training-max percentage separately, and the reference specs resolve against a
 * derived key so the arithmetic happens in ONE place.
 *
 * **The `+` set is a measurement, not an instruction.** The last set of weeks 1
 * to 3 is AMRAP — it is the only feedback the program takes, and it is modelled
 * as `maxReps` for exactly the same reason Candito's `MR` sets are.
 *
 * Progression is between cycles, not within one: the training max rises by one
 * increment for upper-body lifts and two for lower-body after each four weeks.
 * A block covering several cycles therefore has a different training max per
 * cycle, which is why the reference key carries the cycle number.
 *
 * Source: https://www.jimwendler.com — summarised in `docs/domain-model.md`.
 */

/** The four lifts, in the order the program trains them across a week. */
const MAIN_LIFTS: readonly LiftKey[] = ["press", "deadlift", "bench", "squat"] as const;

/** Two on, one off, two on. The week's last three days are free. */
const DAY_OFFSETS: readonly number[] = [0, 1, 3, 4] as const;

/** Training-max rises per completed cycle, counted in INCREMENTS not kilograms. */
const CYCLE_STEP: Record<string, number> = {
  press: 1,
  bench: 1,
  squat: 2,
  deadlift: 2,
};

interface WeekShape {
  /** `[percentage, reps]` for the three main sets. */
  sets: ReadonlyArray<readonly [number, number]>;
  /** Whether the final set is AMRAP. */
  amrap: boolean;
  label: string;
  name: string;
}

const WEEKS: readonly WeekShape[] = [
  {
    sets: [
      [0.65, 5],
      [0.75, 5],
      [0.85, 5],
    ],
    amrap: true,
    label: "65, 75, 85%",
    name: "5 / 5 / 5+",
  },
  {
    sets: [
      [0.7, 3],
      [0.8, 3],
      [0.9, 3],
    ],
    amrap: true,
    label: "70, 80, 90%",
    name: "3 / 3 / 3+",
  },
  {
    sets: [
      [0.75, 5],
      [0.85, 3],
      [0.95, 1],
    ],
    amrap: true,
    label: "75, 85, 95%",
    name: "5 / 3 / 1+",
  },
  {
    sets: [
      [0.4, 5],
      [0.5, 5],
      [0.6, 5],
    ],
    amrap: false,
    label: "40, 50, 60%",
    name: "Deload",
  },
];

/**
 * The parameter key a lift's sets reference, for a given cycle.
 *
 * Derived keys rather than literal percentages of the 1RM parameter, so the
 * training-max arithmetic — including the per-cycle rise — lives in
 * `trainingMaxes()` alone. A percentage-of-a-percentage spread across sixty set
 * definitions is how a program grows two disagreeing definitions of its own
 * training max.
 */
const tmKey = (lift: LiftKey, cycle: number): string => `__tm_${lift}_c${cycle}`;

/**
 * Expand the declared 1RMs into a training max per lift per cycle.
 *
 * Injected into the parameter bag before the schedule resolves its references,
 * which is what lets the generic `reference` load spec express "95% of the
 * training max in cycle 3" without a program-specific resolver.
 */
export const trainingMaxes = (params: ProgramParameters, cycles: number): ProgramParameters => {
  const pct = Number(params["trainingMaxPct"] ?? 90) / 100;
  const derived: ProgramParameters = {};

  for (const lift of MAIN_LIFTS) {
    const oneRepMax = Number(params[lift]);
    if (!Number.isFinite(oneRepMax) || oneRepMax <= 0) continue;

    for (let cycle = 1; cycle <= cycles; cycle++) {
      // The rise is expressed in increments and applied as a percentage bump of
      // the ORIGINAL max, so the loadable-increment rounding still happens once,
      // in the rollout, rather than compounding rounding error per cycle.
      const step = (CYCLE_STEP[lift] ?? 1) * (cycle - 1);
      derived[tmKey(lift, cycle)] = oneRepMax * pct + step * incrementHint(params);
    }
  }
  return derived;
};

/** The nominal increment, in the block's units. Mirrored into params by the API. */
const incrementHint = (params: ProgramParameters): number => (params["units"] === "lb" ? 5 : 2.5);

const mainWork = (lift: LiftKey, cycle: number, shape: WeekShape): ActivitySpec[] =>
  shape.sets.map(([pct, reps], i) => ({
    exercise: LIFT_LABELS[lift],
    reps: shape.amrap && i === shape.sets.length - 1 ? MAX_REPS : fixed(reps),
    load: percentageOf(tmKey(lift, cycle), pct),
    role: "primary",
    ...(shape.amrap && i === shape.sets.length - 1
      ? {
          note: "AMRAP — as many reps as possible with good form. This is the set the program listens to.",
        }
      : {}),
  }));

/**
 * Boring But Big: five sets of ten of the same lift at 50-60% of the training max.
 *
 * The best-known assistance template, and the only one modelled, because the
 * others ("50-100 reps of a push, a pull and a single-leg movement") are
 * categories rather than prescriptions. Offering a category as though it were a
 * prescription would be inventing a program Wendler did not write.
 */
const boringButBig = (lift: LiftKey, cycle: number, pct: number): ActivitySpec[] =>
  repeat(5, {
    exercise: LIFT_LABELS[lift],
    reps: fixed(10),
    load: percentageOf(tmKey(lift, cycle), pct),
    role: "assistance",
    note: "Boring But Big — same lift, 5 sets of 10.",
  });

const accessory = (p: ProgramParameters, key: string): ActivitySpec[] => {
  const name = String(p[key] ?? "").trim();
  if (!name) return [];
  return repeat(5, {
    exercise: name,
    reps: fixed(10),
    load: UNPRESCRIBED,
    role: "assistance",
  });
};

export const WENDLER_531: Program = {
  programId: "wendler-531",
  name: "Wendler 5/3/1",
  description:
    "Four main lifts on a repeating four-week cycle — 5/5/5+, 3/3/3+, 5/3/1+, deload — " +
    "with every percentage taken from a training max set below your true one-rep max.",
  attribution: "Jim Wendler",
  origin: "builtin",
  parameters: [
    { key: "squat", label: "Squat 1RM", kind: "oneRepMax", group: "Maxes" },
    { key: "bench", label: "Bench Press 1RM", kind: "oneRepMax", group: "Maxes" },
    { key: "deadlift", label: "Deadlift 1RM", kind: "oneRepMax", group: "Maxes" },
    { key: "press", label: "Overhead Press 1RM", kind: "oneRepMax", group: "Maxes" },
    {
      key: "trainingMaxPct",
      label: "Training max (% of 1RM)",
      kind: "percentage",
      default: 90,
      group: "Options",
      help: "Wendler recommends 90%, or 85% if your tested max was a grind. Every percentage below is taken from this, not from your 1RM.",
    },
    {
      key: "cycles",
      label: "Cycles",
      kind: "integer",
      default: 2,
      group: "Options",
      help: "Each cycle is four weeks. The training max rises one increment for the presses and two for squat and deadlift after each one.",
    },
    {
      key: "assistance",
      label: "Assistance",
      kind: "choice",
      default: "bbb",
      group: "Options",
      options: [
        { value: "bbb", label: "Boring But Big — 5×10 of the same lift" },
        { value: "accessory", label: "Named accessories — 5×10, your choice" },
        { value: "none", label: "None — main work only" },
      ],
    },
    {
      key: "bbbPct",
      label: "Boring But Big (% of training max)",
      kind: "percentage",
      default: 50,
      group: "Options",
      help: "50 to 60% is the usual range. Higher is not better here.",
    },
    {
      key: "pull",
      label: "Pull accessory",
      kind: "exercise",
      default: "Barbell Row",
      group: "Accessories",
      help: "Used when assistance is set to named accessories.",
    },
    {
      key: "single",
      label: "Single-leg or core accessory",
      kind: "exercise",
      default: "Hanging Leg Raise",
      group: "Accessories",
    },
  ],
  schedule: (params) => {
    const cycles = Math.max(1, Math.min(12, Math.round(Number(params["cycles"] ?? 2))));
    const assistance = String(params["assistance"] ?? "bbb");
    const bbbPct = Number(params["bbbPct"] ?? 50) / 100;

    const sessions: ScheduledSession[] = [];

    for (let cycle = 1; cycle <= cycles; cycle++) {
      WEEKS.forEach((shape, weekIndex) => {
        const week = (cycle - 1) * 4 + weekIndex + 1;

        MAIN_LIFTS.forEach((lift, dayIndex) => {
          // Four training days a week, on days 0, 1, 3 and 4 — the standard
          // two-on / one-off / two-on split, with the week's last three days
          // free. Not a tiling: it is a real training week.
          const dayOffset = (week - 1) * 7 + (DAY_OFFSETS[dayIndex] ?? dayIndex);

          const extras =
            shape.name === "Deload" || assistance === "none"
              ? []
              : assistance === "bbb"
                ? boringButBig(lift, cycle, bbbPct)
                : [...accessory(params, "pull"), ...accessory(params, "single")];

          sessions.push({
            week,
            day: dayIndex + 1,
            dayOffset,
            phase: `Cycle ${cycle} · ${shape.name}`,
            plan: sessionPlan(
              `wendler-c${cycle}w${weekIndex + 1}d${dayIndex + 1}`,
              `${LIFT_LABELS[lift]} — ${shape.name}`,
              [...mainWork(lift, cycle, shape), ...extras],
              {
                intensityLabel: shape.label,
                notes:
                  shape.name === "Deload"
                    ? ["Deload week. No AMRAP set — leave the reps in the tank."]
                    : [],
              },
            ),
          });
        });
      });
    }

    return sessions;
  },
  /** Training maxes per lift per cycle, so `reference` specs resolve normally. */
  derive: (params) =>
    trainingMaxes(params, Math.max(1, Math.min(12, Math.round(Number(params["cycles"] ?? 2))))),
};
