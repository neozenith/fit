import { type ActivitySpec, fixed, percentageOf, repeat, sessionPlan } from "../plan.js";
import type { LiftKey, Program, ProgramParameters, ScheduledSession } from "../types.js";
import { LIFT_LABELS } from "../types.js";

/**
 * StrongLifts 5×5.
 *
 * Two alternating full-body sessions, three days a week:
 *
 *   Workout A   Squat 5×5 · Bench Press 5×5 · Barbell Row 5×5
 *   Workout B   Squat 5×5 · Overhead Press 5×5 · Deadlift 1×5
 *
 * A week runs A, B, A; the next runs B, A, B. You squat every session.
 *
 * Two details are load-bearing and routinely got wrong by reimplementations.
 *
 * **The deadlift is ONE set of five, not five sets.** Five sets of five
 * deadlifts is a different and much harder program, and modelling it that way
 * would quietly triple the hardest lift's volume.
 *
 * **Progression is per SESSION, not per week.** The weight rises by one
 * increment every time a lift is performed, so the squat — trained three times a
 * week — climbs three times as fast as the presses. That is the entire
 * mechanism, and it is why the starting weights are WORKING weights rather than
 * one-rep maxes: the program starts deliberately light and lets the linear
 * progression do the work.
 *
 * The block is therefore a straight arithmetic ramp with no percentages of a
 * max at all. It is expressed with `reference` load specs against derived
 * per-session parameters so it goes through the same resolver and the same
 * rounding as every other program.
 *
 * Source: https://stronglifts.com/5x5/ — summarised in `docs/domain-model.md`.
 */

/** Which lifts each workout trains, in order. */
const WORKOUT_A: readonly LiftKey[] = ["squat", "bench", "row"] as const;
const WORKOUT_B: readonly LiftKey[] = ["squat", "press", "deadlift"] as const;

/** Deadlift is the exception: one set of five. */
const setsFor = (lift: LiftKey): number => (lift === "deadlift" ? 1 : 5);

/** Sessions per week, on Monday / Wednesday / Friday offsets. */
const DAY_OFFSETS: readonly number[] = [0, 2, 4] as const;

/**
 * The parameter key one lift's load references on its Nth performance.
 *
 * Derived per occurrence rather than per week, because the progression is per
 * session: squat occurrence 7 and press occurrence 4 happen on the same day and
 * are at different points on their own ramps.
 */
const rampKey = (lift: LiftKey, occurrence: number): string => `__ramp_${lift}_${occurrence}`;

/**
 * Expand starting weights into a weight per lift per occurrence.
 *
 * Every value is the starting weight plus `n` increments. It is emitted as an
 * absolute number and referenced at 100%, so the rollout's rounding still runs
 * once over it — which matters when a user enters 42.5kg and a 2.5kg increment.
 */
export const linearRamp = (params: ProgramParameters, sessions: number): ProgramParameters => {
  const step = Number(params["stepKg"] ?? (params["units"] === "lb" ? 5 : 2.5));
  const derived: ProgramParameters = {};

  const occurrences: Record<string, number> = {};
  for (let session = 0; session < sessions; session++) {
    const lifts = session % 2 === 0 ? WORKOUT_A : WORKOUT_B;
    for (const lift of lifts) {
      const n = (occurrences[lift] ?? 0) + 1;
      occurrences[lift] = n;

      const start = Number(params[lift]);
      if (!Number.isFinite(start) || start <= 0) continue;

      // Deadlift steps at double rate in the published program — it starts
      // heaviest and is trained least often, so a single increment per session
      // would leave it trailing the squat within a month.
      const perSession = lift === "deadlift" ? step * 2 : step;
      derived[rampKey(lift, n)] = start + (n - 1) * perSession;
    }
  }
  return derived;
};

const workSets = (lift: LiftKey, occurrence: number): ActivitySpec[] =>
  repeat(setsFor(lift), {
    exercise: LIFT_LABELS[lift],
    reps: fixed(5),
    load: percentageOf(rampKey(lift, occurrence), 1),
    role: "primary",
    ...(lift === "deadlift"
      ? { note: "One set of five. Not five sets — that is a different program." }
      : {}),
  });

export const STRONGLIFTS_5X5: Program = {
  programId: "stronglifts-5x5",
  name: "StrongLifts 5×5",
  description:
    "Two alternating full-body sessions, three days a week. Five sets of five on everything " +
    "except the deadlift, which is one set of five, and the bar goes up every single session.",
  attribution: "Mehdi Hadim",
  origin: "builtin",
  parameters: [
    {
      key: "squat",
      label: "Squat starting weight",
      kind: "weight",
      group: "Starting weights",
      help: "A WORKING weight, not a max. The program is designed to start light — an empty bar is a legitimate answer.",
    },
    {
      key: "bench",
      label: "Bench Press starting weight",
      kind: "weight",
      group: "Starting weights",
    },
    { key: "row", label: "Barbell Row starting weight", kind: "weight", group: "Starting weights" },
    {
      key: "press",
      label: "Overhead Press starting weight",
      kind: "weight",
      group: "Starting weights",
    },
    {
      key: "deadlift",
      label: "Deadlift starting weight",
      kind: "weight",
      group: "Starting weights",
      help: "One set of five, and it climbs at double rate.",
    },
    {
      key: "weeks",
      label: "Weeks",
      kind: "integer",
      default: 12,
      group: "Options",
      help: "Three sessions a week. Beginners typically run this for three to six months before stalls become frequent.",
    },
    {
      key: "stepKg",
      label: "Increment per session",
      kind: "weight",
      group: "Options",
      help: "Defaults to the smallest loadable change in your units. Halve it with micro-plates once the squat stalls.",
    },
  ],
  schedule: (params) => {
    const weeks = Math.max(1, Math.min(52, Math.round(Number(params["weeks"] ?? 12))));
    const totalSessions = weeks * 3;
    const sessions: ScheduledSession[] = [];

    const occurrences: Record<string, number> = {};

    for (let session = 0; session < totalSessions; session++) {
      const isA = session % 2 === 0;
      const lifts = isA ? WORKOUT_A : WORKOUT_B;
      const week = Math.floor(session / 3) + 1;
      const dayInWeek = session % 3;

      const activities: ActivitySpec[] = [];
      for (const lift of lifts) {
        const n = (occurrences[lift] ?? 0) + 1;
        occurrences[lift] = n;
        activities.push(...workSets(lift, n));
      }

      sessions.push({
        week,
        day: dayInWeek + 1,
        dayOffset: (week - 1) * 7 + (DAY_OFFSETS[dayInWeek] ?? dayInWeek * 2),
        phase: `Week ${week}`,
        plan: sessionPlan(`stronglifts-s${session + 1}`, `Workout ${isA ? "A" : "B"}`, activities, {
          intensityLabel: isA ? "Squat · Bench · Row" : "Squat · Press · Deadlift",
          notes:
            session === 0
              ? [
                  "Add one increment to every lift each time you perform it.",
                  "Fail to complete 5×5 and the weight stays the same next session. Fail three times and cut that lift by 10%.",
                ]
              : [],
        }),
      });
    }

    return sessions;
  },
  derive: (params) =>
    linearRamp(params, Math.max(1, Math.min(52, Math.round(Number(params["weeks"] ?? 12)))) * 3),
};
