import type {
  AccessoryChoices,
  BlockConfig,
  ConditionalRule,
  ExerciseRole,
  LiftKey,
  PrescribedExercise,
  PrescribedSet,
  RepSpec,
  Session,
  Units,
  WeekSixChoice,
} from "./types.js";
import { LIFT_LABELS } from "./types.js";
import { increment, workingWeight } from "./units.js";

// ---------------------------------------------------------------------------
// Rep-spec shorthands. These read as the sheet writes them: `x6`, `x4-6`, `xMR`.
// ---------------------------------------------------------------------------

const x = (reps: number): RepSpec => ({ kind: "fixed", reps });
const xr = (min: number, max: number): RepSpec => ({ kind: "range", min, max });
const MR: RepSpec = { kind: "maxReps" };
const MR10: RepSpec = { kind: "maxRepsCapped", cap: 10 };

/** `n` sets of the same rep spec at no prescribed weight — accessory work. */
const bodyweightSets = (spec: RepSpec, count: number): PrescribedSet[] =>
  Array.from({ length: count }, () => ({ reps: spec }));

/** Sets at explicit rep counts, all unweighted: the sheet's `x10 | x10 | x8 | x6`. */
const repLadder = (...reps: number[]): PrescribedSet[] => reps.map((r) => ({ reps: x(r) }));

// ---------------------------------------------------------------------------
// The upper-body accessory ladders. Three shapes recur across the whole block,
// so they are named once rather than repeated at nine call sites.
// ---------------------------------------------------------------------------

/** Weeks 1 and 4 — conditioning volume. */
const ACCESSORY_CONDITIONING = {
  upperBackHorizontal: [10, 10, 8, 6],
  shoulder: [12, 12, 10, 8],
  upperBackVertical: [12, 12, 10, 8],
} as const;

/** Week 2 — hypertrophy, one set fewer and heavier. */
const ACCESSORY_HYPERTROPHY = {
  upperBackHorizontal: [10, 8, 8],
  shoulder: [10, 8, 6],
  upperBackVertical: [10, 8, 6],
} as const;

/** Week 3 — strength, flat sixes. */
const ACCESSORY_STRENGTH = {
  upperBackHorizontal: [6, 6, 6],
  shoulder: [6, 6, 6],
  upperBackVertical: [6, 6, 6],
} as const;

/** Week 5 — tapering into the test sets. */
const ACCESSORY_TAPER = {
  upperBackHorizontal: [8, 6, 6],
  shoulder: [8, 6, 6],
  upperBackVertical: [8, 6, 6],
} as const;

type AccessoryLadder = {
  readonly upperBackHorizontal: readonly number[];
  readonly shoulder: readonly number[];
  readonly upperBackVertical: readonly number[];
};

const upperAccessories = (
  accessories: AccessoryChoices,
  ladder: AccessoryLadder,
): PrescribedExercise[] => [
  {
    exercise: accessories.upperBackHorizontal,
    role: "upperBackHorizontal",
    sets: repLadder(...ladder.upperBackHorizontal),
  },
  { exercise: accessories.shoulder, role: "shoulder", sets: repLadder(...ladder.shoulder) },
  {
    exercise: accessories.upperBackVertical,
    role: "upperBackVertical",
    sets: repLadder(...ladder.upperBackVertical),
  },
];

/** The two free-choice accessories, at the sheet's `x8-12` for `count` sets. */
const optionalAccessories = (
  accessories: AccessoryChoices,
  count: number,
): PrescribedExercise[] => [
  {
    exercise: accessories.optional1,
    role: "optional",
    sets: bodyweightSets(xr(8, 12), count),
  },
  {
    exercise: accessories.optional2,
    role: "optional",
    sets: bodyweightSets(xr(8, 12), count),
  },
];

/** Lower-body free choices, unprescribed — Week 5's squat/deadlift days. */
const optionalLower = (accessories: AccessoryChoices): PrescribedExercise[] => [
  { exercise: accessories.optionalLower1, role: "optionalLower", sets: [] },
  { exercise: accessories.optionalLower2, role: "optionalLower", sets: [] },
];

/** The two unprescribed upper accessories that ride the sheet's squat days. */
const optionalUnprescribed = (accessories: AccessoryChoices): PrescribedExercise[] => [
  { exercise: accessories.optional1, role: "optional", sets: [] },
  { exercise: accessories.optional2, role: "optional", sets: [] },
];

// ---------------------------------------------------------------------------
// Feedback rules. The program states these in prose; here they are computable.
// ---------------------------------------------------------------------------

/** Week 2 Day 1 — the fixed extra-volume block, gated on an 8-rep floor. */
const week2ExtraVolume = (units: Units): ConditionalRule => ({
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
const week2BackOff = (units: Units): ConditionalRule => {
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
 * Bands are declared most-favourable first and are exhaustive over 0..cap, so a
 * miss means the rule itself is malformed rather than the input being unusual.
 */
export const resolveConditional = (rule: ConditionalRule, repsAchieved: number) =>
  rule.outcomes.find(
    (o) =>
      (o.minReps === undefined || repsAchieved >= o.minReps) &&
      (o.maxReps === undefined || repsAchieved <= o.maxReps),
  );

// ---------------------------------------------------------------------------
// Week builders. Each returns the week's sessions with day offsets exactly as
// the source sheet computes them from `Inputs!B8`.
// ---------------------------------------------------------------------------

interface WeekContext {
  units: Units;
  max: Record<LiftKey, number>;
  accessories: AccessoryChoices;
}

/** A primary lift at a set of (percentage, nudge, reps) triples. */
const primary = (
  lift: LiftKey,
  ctx: WeekContext,
  sets: Array<{ pct: number; reps: RepSpec; preNudge?: number; nudge?: number }>,
): PrescribedExercise => ({
  exercise: LIFT_LABELS[lift],
  role: "primary",
  sets: sets.map((s) => ({
    weight: workingWeight(ctx.max[lift], s.pct, ctx.units, {
      preNudge: s.preNudge,
      nudge: s.nudge,
    }),
    reps: s.reps,
  })),
});

/** Same weight repeated across `count` sets — the sheet's `=C5` chain. */
const primaryFlat = (
  lift: LiftKey,
  ctx: WeekContext,
  pct: number,
  reps: number,
  count: number,
): PrescribedExercise =>
  primary(
    lift,
    ctx,
    Array.from({ length: count }, () => ({ pct, reps: x(reps) })),
  );

const deadliftVariation = (ctx: WeekContext, reps: number, count: number): PrescribedExercise => ({
  exercise: ctx.accessories.deadliftVariation,
  role: "deadliftVariation",
  sets: bodyweightSets(x(reps), count),
});

const WEEK_TITLES: Record<number, string> = {
  1: "Muscular Conditioning (moderate difficulty)",
  2: "Muscular Conditioning / Hypertrophy (higher difficulty)",
  3: "Linear Max OT Phase",
  4: "Heavy Weight Acclimation",
  5: "High Intensity Strength",
  6: "Retest, Deload or Roll Forward",
};

type SessionSeed = Omit<Session, "date" | "weekTitle">;

const week1 = (ctx: WeekContext): SessionSeed[] => [
  {
    week: 1,
    day: 1,
    dayOffset: 0,
    intensityLabel: "80%",
    exercises: [
      primaryFlat("squat", ctx, 0.8, 6, 4),
      primaryFlat("deadlift", ctx, 0.8, 6, 2),
      ...optionalUnprescribed(ctx.accessories),
    ],
    notes: [],
  },
  ...[1, 3].map((dayOffset, i) => ({
    week: 1,
    day: i + 2,
    dayOffset,
    intensityLabel: "50, 67.5, 75, 77.5%",
    exercises: [
      primary("bench", ctx, [
        { pct: 0.5, reps: x(10) },
        { pct: 0.675, reps: x(10) },
        { pct: 0.75, reps: x(8) },
        { pct: 0.775, reps: x(6) },
      ]),
      ...upperAccessories(ctx.accessories, ACCESSORY_CONDITIONING),
      ...optionalAccessories(ctx.accessories, 4),
    ],
    notes: [],
  })),
  {
    week: 1,
    day: 4,
    dayOffset: 4,
    intensityLabel: "70%",
    exercises: [
      primaryFlat("squat", ctx, 0.7, 8, 4),
      primaryFlat("deadlift", ctx, 0.7, 8, 2),
      ...optionalUnprescribed(ctx.accessories),
    ],
    notes: [],
  },
  {
    week: 1,
    day: 5,
    dayOffset: 5,
    intensityLabel: "80%",
    exercises: [
      primary("bench", ctx, [{ pct: 0.8, reps: MR }]),
      ...upperAccessories(ctx.accessories, ACCESSORY_CONDITIONING),
      ...optionalAccessories(ctx.accessories, 4),
    ],
    notes: [],
  },
];

const week2 = (ctx: WeekContext): SessionSeed[] => [
  {
    week: 2,
    day: 1,
    dayOffset: 7,
    intensityLabel: "80%",
    exercises: [
      {
        ...primary("squat", ctx, [{ pct: 0.8, reps: MR10 }]),
        conditional: week2ExtraVolume(ctx.units),
      },
      deadliftVariation(ctx, 8, 3),
      ...optionalUnprescribed(ctx.accessories),
    ],
    notes: [
      "If you cannot complete a minimum of 8 reps on the max-reps set, reduce the entered max by 2.5% going forward.",
      "Complete the 5 sets of 3 regardless, even if fewer than 8 reps were achieved.",
    ],
  },
  ...[8, 11].map((dayOffset, i) => ({
    week: 2,
    day: i === 0 ? 2 : 4,
    dayOffset,
    intensityLabel: "72-80%",
    exercises: [
      primary("bench", ctx, [
        { pct: 0.725, reps: x(10) },
        { pct: 0.775, reps: x(8) },
        { pct: 0.8, nudge: 1, reps: xr(6, 8) },
      ]),
      ...upperAccessories(ctx.accessories, ACCESSORY_HYPERTROPHY),
      ...optionalAccessories(ctx.accessories, 4),
    ],
    notes: [],
  })),
  {
    week: 2,
    day: 3,
    dayOffset: 10,
    intensityLabel: "80%",
    exercises: [
      {
        ...primary("squat", ctx, [{ pct: 0.8, nudge: 1, reps: MR10 }]),
        conditional: week2BackOff(ctx.units),
      },
      deadliftVariation(ctx, 8, 3),
      ...optionalUnprescribed(ctx.accessories),
    ],
    notes: [],
  },
  {
    week: 2,
    day: 5,
    dayOffset: 13,
    intensityLabel: "80%",
    exercises: [
      primary("bench", ctx, [{ pct: 0.8, nudge: -1, reps: MR }]),
      ...upperAccessories(ctx.accessories, ACCESSORY_HYPERTROPHY),
      ...optionalAccessories(ctx.accessories, 4),
    ],
    notes: [],
  },
];

const week3 = (ctx: WeekContext): SessionSeed[] => [
  {
    week: 3,
    day: 1,
    dayOffset: 14,
    exercises: [
      primary("squat", ctx, [
        { pct: 0.85, nudge: 1, reps: xr(4, 6) },
        { pct: 0.85, nudge: 1, reps: xr(4, 6) },
        { pct: 0.85, nudge: 1, reps: xr(4, 6) },
      ]),
      primary("deadlift", ctx, [
        { pct: 0.875, reps: xr(3, 6) },
        { pct: 0.875, reps: xr(3, 6) },
      ]),
    ],
    notes: ["No accessory lifts."],
  },
  {
    week: 3,
    day: 2,
    dayOffset: 16,
    exercises: [
      primary("bench", ctx, [
        { pct: 0.85, reps: xr(4, 6) },
        { pct: 0.85, reps: xr(4, 6) },
        { pct: 0.85, reps: xr(4, 6) },
      ]),
      ...upperAccessories(ctx.accessories, ACCESSORY_STRENGTH),
    ],
    notes: ["No optional exercises."],
  },
  {
    week: 3,
    day: 3,
    dayOffset: 18,
    exercises: [
      // The inner nudge is the week's linear progression — see `workingWeight`.
      primary("squat", ctx, [{ pct: 0.85, preNudge: 1, nudge: 1, reps: xr(4, 6) }]),
      deadliftVariation(ctx, 8, 1),
    ],
    notes: ["No accessory lifts."],
  },
  {
    week: 3,
    day: 4,
    dayOffset: 19,
    exercises: [
      primary("bench", ctx, [
        { pct: 0.85, nudge: 1, reps: xr(4, 6) },
        { pct: 0.85, nudge: 1, reps: xr(4, 6) },
        { pct: 0.85, nudge: 1, reps: xr(4, 6) },
      ]),
      ...upperAccessories(ctx.accessories, ACCESSORY_STRENGTH),
    ],
    notes: ["No optional exercises."],
  },
];

const week4 = (ctx: WeekContext): SessionSeed[] => [
  {
    week: 4,
    day: 1,
    dayOffset: 21,
    exercises: [
      primary("squat", ctx, [
        { pct: 0.9, nudge: -1, reps: x(3) },
        { pct: 0.9, reps: x(3) },
        { pct: 0.9, nudge: 1, reps: x(3) },
      ]),
      deadliftVariation(ctx, 6, 2),
      ...optionalUnprescribed(ctx.accessories),
    ],
    notes: [],
  },
  {
    week: 4,
    day: 2,
    dayOffset: 22,
    exercises: [
      primary("bench", ctx, [
        { pct: 0.875, preNudge: -1, reps: x(3) },
        { pct: 0.9, preNudge: -1, reps: x(3) },
        { pct: 0.9, reps: x(3) },
      ]),
      ...upperAccessories(ctx.accessories, ACCESSORY_CONDITIONING),
      ...optionalAccessories(ctx.accessories, 4),
    ],
    notes: [],
  },
  {
    week: 4,
    day: 3,
    dayOffset: 24,
    exercises: [
      primary("squat", ctx, [
        { pct: 0.9, nudge: 1, reps: x(3) },
        { pct: 0.95, reps: xr(1, 2) },
      ]),
      primary("deadlift", ctx, [
        { pct: 0.9, nudge: 1, reps: x(3) },
        { pct: 0.95, reps: xr(1, 2) },
      ]),
      ...optionalUnprescribed(ctx.accessories),
    ],
    notes: [],
  },
  {
    week: 4,
    day: 4,
    dayOffset: 25,
    exercises: [
      primary("bench", ctx, [
        { pct: 0.875, reps: x(3) },
        { pct: 0.9, reps: xr(2, 4) },
        { pct: 0.95, reps: xr(1, 2) },
      ]),
      ...upperAccessories(ctx.accessories, ACCESSORY_CONDITIONING),
      ...optionalAccessories(ctx.accessories, 4),
    ],
    notes: [],
  },
];

const week5 = (ctx: WeekContext): SessionSeed[] => [
  {
    week: 5,
    day: 1,
    dayOffset: 28,
    exercises: [
      primary("squat", ctx, [{ pct: 0.975, reps: xr(1, 4) }]),
      primary("deadlift", ctx, [
        { pct: 0.675, reps: x(4) },
        { pct: 0.7, reps: x(4) },
        { pct: 0.725, reps: x(2) },
      ]),
      ...optionalLower(ctx.accessories),
    ],
    notes: ["The squat set is the test set — its rep count seeds the next block."],
  },
  {
    week: 5,
    day: 2,
    dayOffset: 30,
    exercises: [
      primary("bench", ctx, [{ pct: 0.975, reps: xr(1, 4) }]),
      ...upperAccessories(ctx.accessories, ACCESSORY_TAPER),
      ...optionalAccessories(ctx.accessories, 3),
    ],
    notes: ["The bench set is the test set — its rep count seeds the next block."],
  },
  {
    week: 5,
    day: 3,
    dayOffset: 32,
    exercises: [
      primary("deadlift", ctx, [{ pct: 0.975, reps: xr(1, 4) }]),
      ...optionalLower(ctx.accessories),
    ],
    notes: ["The deadlift set is the test set — its rep count seeds the next block."],
  },
];

/**
 * Week 6 has no prescription of its own — it is a choice between three paths
 * (ADR-0013). The sessions it yields depend on `WeekSixChoice`, which the
 * athlete makes; `deload` replays Week 1 without its final upper day.
 */
const week6 = (ctx: WeekContext, choice: WeekSixChoice): SessionSeed[] => {
  if (choice === "skip") return [];
  if (choice === "deload") {
    return week1(ctx)
      .filter((s) => s.day !== 5)
      .map((s) => ({
        ...s,
        week: 6,
        dayOffset: s.dayOffset + 35,
        notes: ["Deload — Week 1 loads, final upper day omitted."],
      }));
  }
  return [
    {
      week: 6,
      day: 1,
      dayOffset: 35,
      exercises: [primary("squat", ctx, [{ pct: 1, reps: x(1) }])],
      notes: ["Work up to a true 1RM. Record the result as the next block's seed."],
    },
    {
      week: 6,
      day: 2,
      dayOffset: 37,
      exercises: [primary("bench", ctx, [{ pct: 1, reps: x(1) }])],
      notes: ["Work up to a true 1RM. Record the result as the next block's seed."],
    },
    {
      week: 6,
      day: 3,
      dayOffset: 39,
      exercises: [primary("deadlift", ctx, [{ pct: 1, reps: x(1) }])],
      notes: ["Work up to a true 1RM. Record the result as the next block's seed."],
    },
  ];
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const addDays = (isoDate: string, days: number): string => {
  // Parse as UTC so a local timezone west of Greenwich cannot shift the date.
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

/**
 * Project a whole block. This is the function ADR-0001 is about: every weight
 * in the returned sessions is derived here and nowhere persisted.
 */
export const generateBlock = (
  config: BlockConfig,
  weekSixChoice: WeekSixChoice = "skip",
): Session[] => {
  const ctx: WeekContext = {
    units: config.units,
    max: config.oneRepMax,
    accessories: config.accessories,
  };
  const seeds = [
    ...week1(ctx),
    ...week2(ctx),
    ...week3(ctx),
    ...week4(ctx),
    ...week5(ctx),
    ...week6(ctx, weekSixChoice),
  ];
  // Week 2 declares its two identical upper days together for readability, so
  // the seed list is not in calendar order. Sort once, here, rather than
  // contorting the week builders to emit chronologically.
  return seeds
    .slice()
    .sort((a, b) => a.dayOffset - b.dayOffset)
    .map((s) => ({
      ...s,
      weekTitle: WEEK_TITLES[s.week] ?? `Week ${s.week}`,
      date: addDays(config.startDate, s.dayOffset),
    }));
};

/** The sessions of a single week, for the week-at-a-time view. */
export const generateWeek = (
  config: BlockConfig,
  week: number,
  weekSixChoice: WeekSixChoice = "skip",
): Session[] => generateBlock(config, weekSixChoice).filter((s) => s.week === week);

export type { ExerciseRole, PrescribedExercise, PrescribedSet, Session };
