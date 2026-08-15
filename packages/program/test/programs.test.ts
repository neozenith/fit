import { describe, expect, test } from "bun:test";
import { compileCustomProgram, danglingReferences, UnknownPlanError } from "../src/custom.js";
import { fixed, groupByExercise, percentageOf, sessionPlan } from "../src/plan.js";
import { BUILTIN_PROGRAMS, findBuiltinProgram } from "../src/programs/index.js";
import { STRONGLIFTS_5X5 } from "../src/programs/stronglifts5x5.js";
import { WENDLER_531 } from "../src/programs/wendler531.js";
import { missingParameters, rolloutBlock, withDefaults } from "../src/rollout.js";
import type { BlockConfig, ProgramParameters, Session } from "../src/types.js";

/**
 * The built-in programs, and the claim that a custom one is the same kind of
 * thing (ADR-0037).
 *
 * The 5/3/1 and 5x5 expectations are read from the published programs, not from
 * this implementation — the percentages, the set counts and the deadlift's
 * single set are all things a reimplementation routinely gets wrong, so they are
 * asserted as facts about the programs rather than as facts about the code.
 */

const block = (
  programId: string,
  parameters: ProgramParameters,
  startDate = "2026-01-05",
): BlockConfig => ({
  blockId: "B-20260105",
  programId,
  startDate,
  units: "kg",
  parameters,
});

const roll = (programId: string, parameters: ProgramParameters): Session[] => {
  const program = findBuiltinProgram(programId);
  if (!program) throw new Error(`no such program: ${programId}`);
  return rolloutBlock(program, block(programId, withDefaults(program, parameters)));
};

const weights = (s: Session, exercise: string): (number | undefined)[] =>
  groupByExercise(s.activities)
    .find((g) => g.exercise === exercise)
    ?.activities.map((a) => a.weight) ?? [];

// ---------------------------------------------------------------------------

describe("the registry", () => {
  test("every built-in has a unique id and at least one parameter", () => {
    const ids = BUILTIN_PROGRAMS.map((p) => p.programId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const program of BUILTIN_PROGRAMS) {
      expect(program.parameters.length).toBeGreaterThan(0);
      expect(program.origin).toBe("builtin");
    }
  });

  test("every declared choice parameter offers its own default", () => {
    for (const program of BUILTIN_PROGRAMS) {
      for (const spec of program.parameters) {
        if (spec.kind !== "choice" || spec.default === undefined) continue;
        expect(spec.options?.map((o) => o.value)).toContain(String(spec.default));
      }
    }
  });

  test("a block missing a required max is reported, not silently rolled out wrong", () => {
    // Only the maxes: the accessory names and the options all carry defaults,
    // so `withDefaults` has already satisfied them.
    expect(missingParameters(WENDLER_531, withDefaults(WENDLER_531, { squat: 100 }))).toEqual([
      "bench",
      "deadlift",
      "press",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("Wendler 5/3/1", () => {
  const PARAMS: ProgramParameters = {
    squat: 200,
    bench: 140,
    deadlift: 240,
    press: 100,
    cycles: 1,
    assistance: "none",
    units: "kg",
  };

  test("one cycle is four weeks of four training days", () => {
    const sessions = roll("wendler-531", PARAMS);
    expect(sessions).toHaveLength(16);
    expect(new Set(sessions.map((s) => s.week))).toEqual(new Set([1, 2, 3, 4]));
  });

  test("percentages are of the TRAINING max, not the entered 1RM", () => {
    // Squat 200 → training max 180 at the default 90%. Week 1 is 65/75/85% of
    // 180 = 117 / 135 / 153, rounded to the 2.5kg increment.
    const w1 = roll("wendler-531", PARAMS).find(
      (s) => s.week === 1 && s.activities[0]?.exercise === "Squat",
    );
    expect(weights(w1 as Session, "Squat")).toEqual([117.5, 135, 152.5]);
  });

  test("the last set of weeks 1-3 is AMRAP and the deload's is not", () => {
    const sessions = roll("wendler-531", PARAMS);
    const squatDay = (week: number) =>
      sessions.find((s) => s.week === week && s.activities[0]?.exercise === "Squat") as Session;

    for (const week of [1, 2, 3]) {
      expect(squatDay(week).activities.at(-1)?.reps.kind).toBe("maxReps");
    }
    expect(squatDay(4).activities.at(-1)?.reps).toEqual({ kind: "fixed", reps: 5 });
  });

  test("week 3 is the 5/3/1 week", () => {
    const w3 = roll("wendler-531", PARAMS).find(
      (s) => s.week === 3 && s.activities[0]?.exercise === "Squat",
    ) as Session;
    const reps = w3.activities.map((a) => (a.reps.kind === "fixed" ? a.reps.reps : "AMRAP"));
    expect(reps).toEqual([5, 3, "AMRAP"]);
  });

  test("a lower training max percentage moves every load down", () => {
    const heavy = roll("wendler-531", PARAMS);
    const light = roll("wendler-531", { ...PARAMS, trainingMaxPct: 85 });
    const top = (ss: Session[]) =>
      (
        ss.find((s) => s.week === 3 && s.activities[0]?.exercise === "Squat") as Session
      ).activities.at(-1)?.weight as number;
    expect(top(light)).toBeLessThan(top(heavy));
  });

  test("the training max rises between cycles, not within one", () => {
    const two = roll("wendler-531", { ...PARAMS, cycles: 2 });
    const squatW1 = (
      two.find((s) => s.week === 1 && s.activities[0]?.exercise === "Squat") as Session
    ).activities[0]?.weight as number;
    const squatW5 = (
      two.find((s) => s.week === 5 && s.activities[0]?.exercise === "Squat") as Session
    ).activities[0]?.weight as number;
    expect(squatW5).toBeGreaterThan(squatW1);
    expect(two).toHaveLength(32);
  });

  test("Boring But Big adds five sets of ten of the same lift", () => {
    const bbb = roll("wendler-531", { ...PARAMS, assistance: "bbb", bbbPct: 50 });
    const day = bbb.find((s) => s.week === 1 && s.activities[0]?.exercise === "Squat") as Session;
    const squat = groupByExercise(day.activities).find((g) => g.exercise === "Squat");
    // Three main sets plus five BBB sets.
    expect(squat?.activities).toHaveLength(8);
    expect(squat?.activities.slice(3).every((a) => a.reps.kind === "fixed")).toBe(true);
  });

  test("the deload week carries no assistance", () => {
    const bbb = roll("wendler-531", { ...PARAMS, assistance: "bbb" });
    const deload = bbb.find(
      (s) => s.week === 4 && s.activities[0]?.exercise === "Squat",
    ) as Session;
    expect(deload.activities).toHaveLength(3);
  });

  test("a block with no overhead press max still rolls out, with unweighted press sets", () => {
    // Escalators, not stairs: the block is not silently reduced to three lifts.
    // The press sessions are still there, and they are visibly unprescribed.
    const noPress = roll("wendler-531", { ...PARAMS, press: 0 });
    const day = noPress.find((s) => s.activities[0]?.exercise === "Overhead Press") as Session;
    expect(day).toBeDefined();
    expect(day.activities.every((a) => a.weight === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("StrongLifts 5×5", () => {
  const PARAMS: ProgramParameters = {
    squat: 40,
    bench: 30,
    row: 30,
    press: 20,
    deadlift: 50,
    weeks: 2,
    units: "kg",
  };

  test("three sessions a week, alternating A and B", () => {
    const sessions = roll("stronglifts-5x5", PARAMS);
    expect(sessions).toHaveLength(6);
    expect(sessions.map((s) => s.name)).toEqual([
      "Workout A",
      "Workout B",
      "Workout A",
      "Workout B",
      "Workout A",
      "Workout B",
    ]);
  });

  test("workout A is squat, bench and row; workout B is squat, press and deadlift", () => {
    const [a, b] = roll("stronglifts-5x5", PARAMS) as [Session, Session];
    expect(groupByExercise(a.activities).map((g) => g.exercise)).toEqual([
      "Squat",
      "Bench Press",
      "Barbell Row",
    ]);
    expect(groupByExercise(b.activities).map((g) => g.exercise)).toEqual([
      "Squat",
      "Overhead Press",
      "Deadlift",
    ]);
  });

  test("the deadlift is ONE set of five, not five sets", () => {
    // Five sets of five deadlifts is a different and much harder program.
    const b = roll("stronglifts-5x5", PARAMS)[1] as Session;
    expect(weights(b, "Deadlift")).toHaveLength(1);
    expect(weights(b, "Squat")).toHaveLength(5);
  });

  test("the bar goes up every session, so the squat climbs three times a week", () => {
    const sessions = roll("stronglifts-5x5", PARAMS);
    const squats = sessions.map((s) => weights(s, "Squat")[0]);
    expect(squats).toEqual([40, 42.5, 45, 47.5, 50, 52.5]);
  });

  test("a lift trained once a week climbs once a week", () => {
    const sessions = roll("stronglifts-5x5", PARAMS);
    const benches = sessions
      .map((s) => weights(s, "Bench Press")[0])
      .filter((w) => w !== undefined);
    expect(benches).toEqual([30, 32.5, 35]);
  });

  test("the deadlift steps at double rate", () => {
    const sessions = roll("stronglifts-5x5", PARAMS);
    const pulls = sessions.map((s) => weights(s, "Deadlift")[0]).filter((w) => w !== undefined);
    expect(pulls).toEqual([50, 55, 60]);
  });

  test("sessions land on Monday, Wednesday and Friday offsets", () => {
    const sessions = roll("stronglifts-5x5", PARAMS);
    expect(sessions.map((s) => s.dayOffset)).toEqual([0, 2, 4, 7, 9, 11]);
  });
});

// ---------------------------------------------------------------------------

describe("a custom program is the same kind of thing as a built-in (ADR-0037)", () => {
  const heavyDay = sessionPlan("my-heavy-day", "Heavy Squat Day", [
    { exercise: "Squat", reps: fixed(3), load: percentageOf("squat", 0.9), role: "primary" },
    { exercise: "Squat", reps: fixed(3), load: percentageOf("squat", 0.9), role: "primary" },
    { exercise: "Barbell Row", reps: fixed(8), load: percentageOf("row", 0.7) },
  ]);

  const definition = {
    programId: "custom-abc",
    name: "My Split",
    description: "Two heavy days a week.",
    parameters: [
      { key: "squat", label: "Squat 1RM", kind: "oneRepMax" as const },
      { key: "row", label: "Row 1RM", kind: "oneRepMax" as const },
    ],
    schedule: [
      { planId: "my-heavy-day", week: 1, day: 1, dayOffset: 0 },
      { planId: "my-heavy-day", week: 1, day: 2, dayOffset: 3 },
    ],
  };

  test("it compiles to the Program interface the built-ins implement", () => {
    const program = compileCustomProgram(definition, [heavyDay]);
    expect(program.origin).toBe("custom");
    expect(typeof program.schedule).toBe("function");
  });

  test("it goes through the SAME rollout, with the same rounding", () => {
    const program = compileCustomProgram(definition, [heavyDay]);
    const sessions = rolloutBlock(program, block("custom-abc", { squat: 71, row: 60 }));

    expect(sessions).toHaveLength(2);
    // mround(71 * 0.9, 2.5) — the identical arithmetic every built-in gets.
    expect(weights(sessions[0] as Session, "Squat")).toEqual([65, 65]);
    expect(sessions[1]?.date).toBe("2026-01-08");
  });

  test("a dangling plan reference fails loudly instead of dropping the session", () => {
    // A schedule that silently loses a day produces a block that looks complete
    // and is missing a session.
    expect(() => compileCustomProgram(definition, [])).toThrow(UnknownPlanError);
  });

  test("a load referencing an undeclared parameter is reported before it renders blank", () => {
    const typo = sessionPlan("typo", "Typo", [
      { exercise: "Squat", reps: fixed(5), load: percentageOf("squatMax", 0.8) },
    ]);
    const withTypo = {
      ...definition,
      schedule: [{ planId: "typo", week: 1, day: 1, dayOffset: 0 }],
    };
    expect(danglingReferences(withTypo, [typo])).toEqual(["squatMax"]);
  });

  test("an unresolvable reference yields no weight rather than NaN", () => {
    const program = compileCustomProgram(definition, [heavyDay]);
    const sessions = rolloutBlock(program, block("custom-abc", { squat: 71 }));
    expect(weights(sessions[0] as Session, "Barbell Row")).toEqual([undefined]);
  });
});

// ---------------------------------------------------------------------------

describe("rollout invariants that hold for every program", () => {
  test.each(
    BUILTIN_PROGRAMS.map((p) => [p.programId] as const),
  )("%s emits sessions in calendar order with unique refs", (programId) => {
    const program = findBuiltinProgram(programId);
    if (!program) throw new Error("unreachable");
    const params = withDefaults(program, {
      squat: 100,
      bench: 80,
      deadlift: 120,
      press: 60,
      row: 70,
      units: "kg",
    });
    const sessions = rolloutBlock(program, block(programId, params));

    expect(sessions.length).toBeGreaterThan(0);
    const offsets = sessions.map((s) => s.dayOffset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(new Set(sessions.map((s) => s.sessionRef)).size).toBe(sessions.length);
  });

  test.each(
    BUILTIN_PROGRAMS.map((p) => [p.programId] as const),
  )("%s never persists a computed weight, so two rollouts are identical (ADR-0001)", (programId) => {
    const program = findBuiltinProgram(programId);
    if (!program) throw new Error("unreachable");
    const config = block(
      programId,
      withDefaults(program, {
        squat: 100,
        bench: 80,
        deadlift: 120,
        press: 60,
        row: 70,
        units: "kg",
      }),
    );
    expect(JSON.stringify(rolloutBlock(program, config))).toBe(
      JSON.stringify(rolloutBlock(program, config)),
    );
  });

  test("StrongLifts starting weights are working weights, so they are used literally", () => {
    // The one program whose parameters are NOT maxes. If this ever starts
    // taking a percentage, every starting weight silently halves.
    const first = roll("stronglifts-5x5", {
      squat: 40,
      bench: 30,
      row: 30,
      press: 20,
      deadlift: 50,
      weeks: 1,
    })[0];
    expect(weights(first as Session, "Squat")[0]).toBe(40);
    expect(STRONGLIFTS_5X5.parameters.find((p) => p.key === "squat")?.kind).toBe("weight");
  });
});
