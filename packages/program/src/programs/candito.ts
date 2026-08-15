import {
  type ActivitySpec,
  fixed,
  freeChoice,
  ladder,
  MAX_REPS,
  maxRepsCapped,
  percentageOf,
  range,
  repeat,
  sessionPlan,
  UNPRESCRIBED,
} from "../plan.js";
import type {
  ConditionalRule,
  Program,
  ProgramParameters,
  ScheduledSession,
  SessionPlan,
  Units,
} from "../types.js";
import { LIFT_LABELS } from "../types.js";
import { increment } from "../units.js";

/**
 * The Candito 6-Week Strength Program.
 *
 * Six weeks projected from three one-rep maxes. Intensity climbs while volume
 * falls; two capped max-reps squat sets in Week 2 gate feedback rules, and Week
 * 5's single set at 97.5% per lift is the test that seeds the next block.
 *
 * Ported from the source workbook formula by formula. The golden tests assert
 * against the workbook's own computed cells, so a change here that moves a
 * weight by one increment fails loudly.
 */

const P = (key: string, pct: number, options: { preNudge?: number; nudge?: number } = {}) =>
  percentageOf(key, pct, options);

const primary = (
  lift: "squat" | "bench" | "deadlift",
  sets: Array<{ pct: number; reps: ActivitySpec["reps"]; preNudge?: number; nudge?: number }>,
  extra: { conditional?: ConditionalRule } = {},
): ActivitySpec[] =>
  sets.map((s) => ({
    exercise: LIFT_LABELS[lift],
    reps: s.reps,
    load: P(lift, s.pct, {
      ...(s.preNudge === undefined ? {} : { preNudge: s.preNudge }),
      ...(s.nudge === undefined ? {} : { nudge: s.nudge }),
    }),
    role: "primary",
    ...(extra.conditional === undefined ? {} : { conditional: extra.conditional }),
  }));

/** Same weight across `count` sets — the sheet's `=C5` chain. */
const primaryFlat = (
  lift: "squat" | "bench" | "deadlift",
  pct: number,
  reps: number,
  count: number,
): ActivitySpec[] =>
  primary(
    lift,
    Array.from({ length: count }, () => ({ pct, reps: fixed(reps) })),
  );

// --- The upper-body accessory ladders ----------------------------------------
// Four shapes recur across the block, so they are named once rather than
// repeated at nine call sites.

const CONDITIONING = {
  horizontal: [10, 10, 8, 6],
  shoulder: [12, 12, 10, 8],
  vertical: [12, 12, 10, 8],
};
const HYPERTROPHY = { horizontal: [10, 8, 8], shoulder: [10, 8, 6], vertical: [10, 8, 6] };
const STRENGTH = { horizontal: [6, 6, 6], shoulder: [6, 6, 6], vertical: [6, 6, 6] };
const TAPER = { horizontal: [8, 6, 6], shoulder: [8, 6, 6], vertical: [8, 6, 6] };

type Ladder = { horizontal: number[]; shoulder: number[]; vertical: number[] };

const upper = (p: ProgramParameters, l: Ladder): ActivitySpec[] => [
  ...ladder(String(p["upperBackHorizontal"]), l.horizontal, { role: "upperBackHorizontal" }),
  ...ladder(String(p["shoulder"]), l.shoulder, { role: "shoulder" }),
  ...ladder(String(p["upperBackVertical"]), l.vertical, { role: "upperBackVertical" }),
];

/** The two free-choice accessories, at the sheet's `x8-12` for `count` sets. */
const optional = (p: ProgramParameters, count: number): ActivitySpec[] => [
  ...repeat(count, {
    exercise: String(p["optional1"]),
    reps: range(8, 12),
    load: UNPRESCRIBED,
    role: "optional",
  }),
  ...repeat(count, {
    exercise: String(p["optional2"]),
    reps: range(8, 12),
    load: UNPRESCRIBED,
    role: "optional",
  }),
];

/** The same two, named but entirely unprescribed — the sheet's squat days. */
const optionalFree = (p: ProgramParameters): ActivitySpec[] => [
  freeChoice(String(p["optional1"]), "optional"),
  freeChoice(String(p["optional2"]), "optional"),
];

const lowerFree = (p: ProgramParameters): ActivitySpec[] => [
  freeChoice(String(p["optionalLower1"]), "optionalLower"),
  freeChoice(String(p["optionalLower2"]), "optionalLower"),
];

const dlVariation = (p: ProgramParameters, reps: number, count: number): ActivitySpec[] =>
  repeat(count, {
    exercise: String(p["deadliftVariation"]),
    reps: fixed(reps),
    load: UNPRESCRIBED,
    role: "deadliftVariation",
  });

// --- Feedback rules ----------------------------------------------------------

/** Week 2 Day 1 — the fixed extra-volume block, gated on an 8-rep floor. */
const extraVolume = (units: Units): ConditionalRule => ({
  triggerExercise: LIFT_LABELS.squat,
  description:
    "Extra volume squats: add one increment, then 5 sets of 3 reps with 60 seconds rest. " +
    "Perform them regardless of the max-reps result.",
  outcomes: [
    {
      minReps: 8,
      work: { sets: 5, reps: 3, weightDelta: increment(units) },
      description: "5 sets of 3 at one increment above the max-reps weight, 60s rest.",
    },
    {
      maxReps: 7,
      work: { sets: 5, reps: 3, weightDelta: increment(units) },
      oneRepMaxFactor: 0.975,
      description:
        "Fewer than 8 reps: still perform 5 sets of 3, but reduce the entered max by 2.5% going forward.",
    },
  ],
});

/** Week 2 Day 3 — back-off volume scaled to the max-reps result. */
const backOff = (units: Units): ConditionalRule => {
  const delta = -2 * increment(units); // "reduce weight by 10 lbs or 5 kg"
  return {
    triggerExercise: LIFT_LABELS.squat,
    description:
      "Back-off squats: reduce by two increments, then perform volume scaled to the max-reps set.",
    outcomes: [
      {
        minReps: 10,
        work: { sets: 10, reps: 3, weightDelta: delta },
        description: "10 reps achieved: 10 sets of 3, 60s rest.",
      },
      {
        minReps: 8,
        maxReps: 9,
        work: { sets: 8, reps: 3, weightDelta: delta },
        description: "8-9 reps: 8 sets of 3, 60s rest.",
      },
      {
        minReps: 7,
        maxReps: 7,
        work: { sets: 5, reps: 3, weightDelta: delta },
        description: "7 reps: 5 sets of 3, 60s rest.",
      },
      {
        maxReps: 6,
        oneRepMaxFactor: 0.975,
        description:
          "Fewer than 7 reps: skip the back-off sets entirely and reduce the entered max by at least 2.5%.",
      },
    ],
  };
};

/**
 * Resolve a feedback rule against an achieved rep count.
 *
 * Bands are declared most-favourable first and are exhaustive, so a miss means
 * the rule itself is malformed rather than the input being unusual.
 */
export const resolveConditional = (rule: ConditionalRule, repsAchieved: number) =>
  rule.outcomes.find(
    (o) =>
      (o.minReps === undefined || repsAchieved >= o.minReps) &&
      (o.maxReps === undefined || repsAchieved <= o.maxReps),
  );

// --- The weeks ---------------------------------------------------------------

const PHASES: Record<number, string> = {
  1: "Muscular Conditioning (moderate difficulty)",
  2: "Muscular Conditioning / Hypertrophy (higher difficulty)",
  3: "Linear Max OT Phase",
  4: "Heavy Weight Acclimation",
  5: "High Intensity Strength",
  6: "Retest, Deload or Roll Forward",
};

const at = (week: number, day: number, dayOffset: number, plan: SessionPlan): ScheduledSession => ({
  week,
  day,
  dayOffset,
  phase: PHASES[week] ?? `Week ${week}`,
  plan,
});

const id = (week: number, day: number) => `candito-w${week}d${day}`;

const week1 = (p: ProgramParameters): ScheduledSession[] => [
  at(
    1,
    1,
    0,
    sessionPlan(
      id(1, 1),
      "Squat & Deadlift — volume",
      [
        ...primaryFlat("squat", 0.8, 6, 4),
        ...primaryFlat("deadlift", 0.8, 6, 2),
        ...optionalFree(p),
      ],
      { intensityLabel: "80%" },
    ),
  ),
  ...[1, 3].map((dayOffset, i) =>
    at(
      1,
      i + 2,
      dayOffset,
      sessionPlan(
        id(1, i + 2),
        "Bench — conditioning ladder",
        [
          ...primary("bench", [
            { pct: 0.5, reps: fixed(10) },
            { pct: 0.675, reps: fixed(10) },
            { pct: 0.75, reps: fixed(8) },
            { pct: 0.775, reps: fixed(6) },
          ]),
          ...upper(p, CONDITIONING),
          ...optional(p, 4),
        ],
        { intensityLabel: "50, 67.5, 75, 77.5%" },
      ),
    ),
  ),
  at(
    1,
    4,
    4,
    sessionPlan(
      id(1, 4),
      "Squat & Deadlift — higher reps",
      [
        ...primaryFlat("squat", 0.7, 8, 4),
        ...primaryFlat("deadlift", 0.7, 8, 2),
        ...optionalFree(p),
      ],
      { intensityLabel: "70%" },
    ),
  ),
  at(
    1,
    5,
    5,
    sessionPlan(
      id(1, 5),
      "Bench — max reps",
      [
        ...primary("bench", [{ pct: 0.8, reps: MAX_REPS }]),
        ...upper(p, CONDITIONING),
        ...optional(p, 4),
      ],
      { intensityLabel: "80%" },
    ),
  ),
];

const week2 = (p: ProgramParameters, units: Units): ScheduledSession[] => [
  at(
    2,
    1,
    7,
    sessionPlan(
      id(2, 1),
      "Squat — capped max reps",
      [
        ...primary("squat", [{ pct: 0.8, reps: maxRepsCapped(10) }], {
          conditional: extraVolume(units),
        }),
        ...dlVariation(p, 8, 3),
        ...optionalFree(p),
      ],
      {
        intensityLabel: "80%",
        notes: [
          "If you cannot complete a minimum of 8 reps on the max-reps set, reduce the entered max by 2.5% going forward.",
          "Complete the 5 sets of 3 regardless, even if fewer than 8 reps were achieved.",
        ],
      },
    ),
  ),
  ...[8, 11].map((dayOffset, i) =>
    at(
      2,
      i === 0 ? 2 : 4,
      dayOffset,
      sessionPlan(
        id(2, i === 0 ? 2 : 4),
        "Bench — hypertrophy",
        [
          ...primary("bench", [
            { pct: 0.725, reps: fixed(10) },
            { pct: 0.775, reps: fixed(8) },
            { pct: 0.8, nudge: 1, reps: range(6, 8) },
          ]),
          ...upper(p, HYPERTROPHY),
          ...optional(p, 4),
        ],
        { intensityLabel: "72-80%" },
      ),
    ),
  ),
  at(
    2,
    3,
    10,
    sessionPlan(
      id(2, 3),
      "Squat — capped max reps, back-off",
      [
        ...primary("squat", [{ pct: 0.8, nudge: 1, reps: maxRepsCapped(10) }], {
          conditional: backOff(units),
        }),
        ...dlVariation(p, 8, 3),
        ...optionalFree(p),
      ],
      { intensityLabel: "80%" },
    ),
  ),
  at(
    2,
    5,
    13,
    sessionPlan(
      id(2, 5),
      "Bench — max reps",
      [
        ...primary("bench", [{ pct: 0.8, nudge: -1, reps: MAX_REPS }]),
        ...upper(p, HYPERTROPHY),
        ...optional(p, 4),
      ],
      { intensityLabel: "80%" },
    ),
  ),
];

const week3 = (p: ProgramParameters): ScheduledSession[] => [
  at(
    3,
    1,
    14,
    sessionPlan(
      id(3, 1),
      "Squat & Deadlift — triples",
      [
        ...primary("squat", [
          { pct: 0.85, nudge: 1, reps: range(4, 6) },
          { pct: 0.85, nudge: 1, reps: range(4, 6) },
          { pct: 0.85, nudge: 1, reps: range(4, 6) },
        ]),
        ...primary("deadlift", [
          { pct: 0.875, reps: range(3, 6) },
          { pct: 0.875, reps: range(3, 6) },
        ]),
      ],
      { notes: ["No accessory lifts."] },
    ),
  ),
  at(
    3,
    2,
    16,
    sessionPlan(
      id(3, 2),
      "Bench — strength",
      [
        ...primary("bench", [
          { pct: 0.85, reps: range(4, 6) },
          { pct: 0.85, reps: range(4, 6) },
          { pct: 0.85, reps: range(4, 6) },
        ]),
        ...upper(p, STRENGTH),
      ],
      { notes: ["No optional exercises."] },
    ),
  ),
  at(
    3,
    3,
    18,
    sessionPlan(
      id(3, 3),
      "Squat — linear progression",
      [
        // The INNER nudge is the week's built-in progression, not a duplicate of
        // the outer one. See `workingWeight` and ADR-0021.
        ...primary("squat", [{ pct: 0.85, preNudge: 1, nudge: 1, reps: range(4, 6) }]),
        ...dlVariation(p, 8, 1),
      ],
      { notes: ["No accessory lifts."] },
    ),
  ),
  at(
    3,
    4,
    19,
    sessionPlan(
      id(3, 4),
      "Bench — strength",
      [
        ...primary("bench", [
          { pct: 0.85, nudge: 1, reps: range(4, 6) },
          { pct: 0.85, nudge: 1, reps: range(4, 6) },
          { pct: 0.85, nudge: 1, reps: range(4, 6) },
        ]),
        ...upper(p, STRENGTH),
      ],
      { notes: ["No optional exercises."] },
    ),
  ),
];

const week4 = (p: ProgramParameters): ScheduledSession[] => [
  at(
    4,
    1,
    21,
    sessionPlan(id(4, 1), "Squat — ramped triples", [
      ...primary("squat", [
        { pct: 0.9, nudge: -1, reps: fixed(3) },
        { pct: 0.9, reps: fixed(3) },
        { pct: 0.9, nudge: 1, reps: fixed(3) },
      ]),
      ...dlVariation(p, 6, 2),
      ...optionalFree(p),
    ]),
  ),
  at(
    4,
    2,
    22,
    sessionPlan(id(4, 2), "Bench — ramped triples", [
      ...primary("bench", [
        { pct: 0.875, preNudge: -1, reps: fixed(3) },
        { pct: 0.9, preNudge: -1, reps: fixed(3) },
        { pct: 0.9, reps: fixed(3) },
      ]),
      ...upper(p, CONDITIONING),
      ...optional(p, 4),
    ]),
  ),
  at(
    4,
    3,
    24,
    sessionPlan(id(4, 3), "Squat & Deadlift — first singles", [
      ...primary("squat", [
        { pct: 0.9, nudge: 1, reps: fixed(3) },
        { pct: 0.95, reps: range(1, 2) },
      ]),
      ...primary("deadlift", [
        { pct: 0.9, nudge: 1, reps: fixed(3) },
        { pct: 0.95, reps: range(1, 2) },
      ]),
      ...optionalFree(p),
    ]),
  ),
  at(
    4,
    4,
    25,
    sessionPlan(id(4, 4), "Bench — first singles", [
      ...primary("bench", [
        { pct: 0.875, reps: fixed(3) },
        { pct: 0.9, reps: range(2, 4) },
        { pct: 0.95, reps: range(1, 2) },
      ]),
      ...upper(p, CONDITIONING),
      ...optional(p, 4),
    ]),
  ),
];

const TEST_SET_NOTE = (lift: string) =>
  `The ${lift} set is the test set — its rep count seeds the next block.`;

const week5 = (p: ProgramParameters): ScheduledSession[] => [
  at(
    5,
    1,
    28,
    sessionPlan(
      id(5, 1),
      "Squat — test set",
      [
        ...primary("squat", [{ pct: 0.975, reps: range(1, 4) }]),
        ...primary("deadlift", [
          { pct: 0.675, reps: fixed(4) },
          { pct: 0.7, reps: fixed(4) },
          { pct: 0.725, reps: fixed(2) },
        ]),
        ...lowerFree(p),
      ],
      { notes: [TEST_SET_NOTE("squat")] },
    ),
  ),
  at(
    5,
    2,
    30,
    sessionPlan(
      id(5, 2),
      "Bench — test set",
      [
        ...primary("bench", [{ pct: 0.975, reps: range(1, 4) }]),
        ...upper(p, TAPER),
        ...optional(p, 3),
      ],
      { notes: [TEST_SET_NOTE("bench")] },
    ),
  ),
  at(
    5,
    3,
    32,
    sessionPlan(
      id(5, 3),
      "Deadlift — test set",
      [...primary("deadlift", [{ pct: 0.975, reps: range(1, 4) }]), ...lowerFree(p)],
      { notes: [TEST_SET_NOTE("deadlift")] },
    ),
  ),
];

/**
 * Week 6 has no prescription of its own — it is a choice between three paths.
 *
 * `deload` replays Week 1's loads without its final upper day; `test` spends the
 * week finding a true one-rep max; `skip` yields nothing and the next block
 * starts immediately.
 */
const week6 = (p: ProgramParameters): ScheduledSession[] => {
  const choice = String(p["week6"] ?? "skip");
  if (choice === "skip") return [];

  if (choice === "deload") {
    return week1(p)
      .filter((s) => s.day !== 5)
      .map((s) => ({
        ...s,
        week: 6,
        dayOffset: s.dayOffset + 35,
        phase: PHASES[6] as string,
        plan: {
          ...s.plan,
          planId: `candito-w6d${s.day}`,
          notes: ["Deload — Week 1 loads, final upper day omitted."],
        },
      }));
  }

  return (["squat", "bench", "deadlift"] as const).map((lift, i) =>
    at(
      6,
      i + 1,
      35 + i * 2,
      sessionPlan(
        id(6, i + 1),
        `${LIFT_LABELS[lift]} — retest`,
        primary(lift, [{ pct: 1, reps: fixed(1) }]),
        {
          notes: ["Work up to a true 1RM. Record the result as the next block's seed."],
        },
      ),
    ),
  );
};

// --- The program ------------------------------------------------------------

export const CANDITO_6_WEEK: Program = {
  programId: "candito-6-week",
  name: "Candito 6-Week Strength",
  description:
    "Six weeks projected from three one-rep maxes. Volume falls as intensity climbs, " +
    "two Week 2 max-reps sets feed back into the loads, and Week 5's 97.5% test sets seed the next block.",
  attribution: "Jonnie Candito",
  origin: "builtin",
  parameters: [
    { key: "squat", label: "Squat 1RM", kind: "oneRepMax", group: "Maxes" },
    { key: "bench", label: "Bench Press 1RM", kind: "oneRepMax", group: "Maxes" },
    { key: "deadlift", label: "Deadlift 1RM", kind: "oneRepMax", group: "Maxes" },
    {
      key: "upperBackHorizontal",
      label: "Upper back, horizontal pull",
      kind: "exercise",
      default: "Barbell Row",
      group: "Accessories",
    },
    {
      key: "shoulder",
      label: "Shoulder",
      kind: "exercise",
      default: "Dumbbell Shoulder Press",
      group: "Accessories",
    },
    {
      key: "upperBackVertical",
      label: "Upper back, vertical pull",
      kind: "exercise",
      default: "Lat Pulldown",
      group: "Accessories",
    },
    {
      key: "optional1",
      label: "Optional 1",
      kind: "exercise",
      default: "Barbell Curl",
      group: "Accessories",
    },
    {
      key: "optional2",
      label: "Optional 2",
      kind: "exercise",
      default: "Tricep Pushdown",
      group: "Accessories",
    },
    {
      key: "optionalLower1",
      label: "Optional lower 1",
      kind: "exercise",
      default: "Leg Press",
      group: "Accessories",
    },
    {
      key: "optionalLower2",
      label: "Optional lower 2",
      kind: "exercise",
      default: "Standing Calf Raise",
      group: "Accessories",
    },
    {
      key: "deadliftVariation",
      label: "Deadlift variation",
      kind: "exercise",
      default: "Romanian Deadlift",
      group: "Accessories",
    },
    {
      key: "week6",
      label: "Week 6",
      kind: "choice",
      default: "skip",
      group: "Options",
      help: "Skip straight to the next block, deload on Week 1 loads, or spend the week retesting.",
      options: [
        { value: "skip", label: "Skip — start the next block" },
        { value: "deload", label: "Deload — repeat Week 1" },
        { value: "test", label: "Test — find a true 1RM" },
      ],
    },
  ],
  schedule: (params) => {
    // Units decide the increment a feedback rule's weight delta is counted in.
    // They are a block-level property, so the rule reads them from the parameter
    // bag where the API mirrors them rather than declaring them itself.
    const units: Units = params["units"] === "lb" ? "lb" : "kg";
    return [
      ...week1(params),
      ...week2(params, units),
      ...week3(params),
      ...week4(params),
      ...week5(params),
      ...week6(params),
    ];
  },
};
