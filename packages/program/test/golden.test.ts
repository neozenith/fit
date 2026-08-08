import { describe, expect, test } from "bun:test";
import { DEFAULT_ACCESSORIES } from "../src/defaults.js";
import { generateBlock } from "../src/program.js";
import type { BlockConfig, PrescribedExercise, Session } from "../src/types.js";

/**
 * Golden tests against the source spreadsheet.
 *
 * Every expected weight below was read out of the workbook's own computed
 * cells with these exact seeds, so a failure here means the engine and the
 * spreadsheet disagree — which is the only regression that matters for
 * ADR-0001's claim that the program is a faithful pure function.
 *
 * Two expectations deliberately differ from the sheet; both are marked
 * DEVIATION and explained in `docs/questions/Q01-spreadsheet-formula-deviations.md`.
 */

const CONFIG: BlockConfig = {
  blockId: "golden",
  startDate: "2026-01-05",
  units: "kg",
  oneRepMax: { bench: 40, squat: 70, deadlift: 80 },
  accessories: DEFAULT_ACCESSORIES,
};

const block = generateBlock(CONFIG);

const session = (week: number, day: number): Session => {
  const found = block.find((s) => s.week === week && s.day === day);
  if (!found) throw new Error(`No session for week ${week} day ${day}`);
  return found;
};

const lift = (s: Session, exercise: string): PrescribedExercise => {
  const found = s.exercises.find((e) => e.exercise === exercise);
  if (!found) throw new Error(`No "${exercise}" in week ${s.week} day ${s.day}`);
  return found;
};

const weights = (s: Session, exercise: string): (number | undefined)[] =>
  lift(s, exercise).sets.map((set) => set.weight);

describe("dates follow the sheet's day offsets from the start date", () => {
  test.each([
    [1, 1, "2026-01-05"],
    [1, 2, "2026-01-06"],
    [1, 3, "2026-01-08"],
    [1, 4, "2026-01-09"],
    [1, 5, "2026-01-10"],
    [2, 1, "2026-01-12"],
    [2, 3, "2026-01-15"],
    [2, 5, "2026-01-18"],
    [3, 1, "2026-01-19"],
    [3, 4, "2026-01-24"],
    [4, 1, "2026-01-26"],
    [4, 4, "2026-01-30"],
    [5, 1, "2026-02-02"],
    [5, 3, "2026-02-06"],
  ])("week %i day %i falls on %s", (week, day, expected) => {
    expect(session(week, day).date).toBe(expected);
  });

  test("sessions are emitted in calendar order", () => {
    const offsets = block.map((s) => s.dayOffset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });
});

describe("week 1 — muscular conditioning", () => {
  test("day 1 squats four sets at 80%, deadlifts two", () => {
    expect(weights(session(1, 1), "Squat")).toEqual([55, 55, 55, 55]);
    expect(weights(session(1, 1), "Deadlift")).toEqual([65, 65]);
  });

  test("day 2 bench ramps 50 / 67.5 / 75 / 77.5%", () => {
    expect(weights(session(1, 2), "Bench Press")).toEqual([20, 27.5, 30, 30]);
  });

  test("day 3 repeats day 2 exactly", () => {
    expect(weights(session(1, 3), "Bench Press")).toEqual(weights(session(1, 2), "Bench Press"));
  });

  test("day 4 drops to 70%", () => {
    // DEVIATION (harmless): the sheet's formula tests `Inputs!B36`, an empty
    // cell, so it always takes the pound-rounding branch. At these seeds both
    // branches agree, so the expected values are unchanged.
    expect(weights(session(1, 4), "Squat")).toEqual([50, 50, 50, 50]);
    expect(weights(session(1, 4), "Deadlift")).toEqual([55, 55]);
  });

  test("day 5 is a single max-reps bench set at 80%", () => {
    const bench = lift(session(1, 5), "Bench Press");
    expect(bench.sets).toHaveLength(1);
    expect(bench.sets[0]?.weight).toBe(32.5);
    expect(bench.sets[0]?.reps).toEqual({ kind: "maxReps" });
  });
});

describe("week 2 — hypertrophy with feedback rules", () => {
  test("day 1 squat is a capped max-reps set carrying the extra-volume rule", () => {
    const squat = lift(session(2, 1), "Squat");
    expect(squat.sets[0]?.weight).toBe(55);
    expect(squat.sets[0]?.reps).toEqual({ kind: "maxRepsCapped", cap: 10 });
    expect(squat.conditional?.outcomes).toHaveLength(2);
  });

  test("day 2 bench nudges the top set one increment above 80%", () => {
    expect(weights(session(2, 2), "Bench Press")).toEqual([30, 30, 35]);
  });

  test("day 3 squat sits one increment above day 1 and carries the back-off rule", () => {
    const squat = lift(session(2, 3), "Squat");
    expect(squat.sets[0]?.weight).toBe(57.5);
    expect(squat.conditional?.outcomes.map((o) => o.work?.sets)).toEqual([10, 8, 5, undefined]);
  });

  test("day 5 bench sits one increment below 80%", () => {
    expect(weights(session(2, 5), "Bench Press")).toEqual([30]);
  });
});

describe("week 3 — linear max overload", () => {
  test("day 1 triples at 85% plus one increment", () => {
    expect(weights(session(3, 1), "Squat")).toEqual([62.5, 62.5, 62.5]);
    expect(weights(session(3, 1), "Deadlift")).toEqual([70, 70]);
  });

  test("day 2 benches flat at 85%", () => {
    expect(weights(session(3, 2), "Bench Press")).toEqual([35, 35, 35]);
  });

  test("day 3 squat nudges INSIDE the rounding, landing above day 1", () => {
    // mround(59.5 + 2.5, 2.5) + 2.5 = 65, not mround(59.5, 2.5) + 2.5 + 2.5 = 65
    // — here they agree, but the general case does not. See `workingWeight`.
    expect(weights(session(3, 3), "Squat")).toEqual([65]);
  });

  test("day 4 bench is day 2 plus one increment", () => {
    expect(weights(session(3, 4), "Bench Press")).toEqual([37.5, 37.5, 37.5]);
  });

  test("weeks 3 accessory work drops the optional lifts entirely", () => {
    expect(session(3, 1).notes).toContain("No accessory lifts.");
    expect(session(3, 2).exercises.some((e) => e.role === "optional")).toBe(false);
  });
});

describe("week 4 — heavy weight acclimation", () => {
  test("day 1 squat steps down, level, up around 90%", () => {
    expect(weights(session(4, 1), "Squat")).toEqual([60, 62.5, 65]);
  });

  test("day 2 bench subtracts ONE increment, not a literal five", () => {
    // DEVIATION: the sheet subtracts a literal `5` inside MROUND in both the kg
    // and lb branches. In kilograms that is two increments — a 12.5% drop on a
    // 40kg bench, which reads as a units bug rather than programming intent.
    // The sheet yields [30, 30, 35]; one increment yields:
    expect(weights(session(4, 2), "Bench Press")).toEqual([32.5, 32.5, 35]);
  });

  test("day 3 pairs a heavy triple with a 95% single across both lower lifts", () => {
    expect(weights(session(4, 3), "Squat")).toEqual([65, 67.5]);
    expect(weights(session(4, 3), "Deadlift")).toEqual([75, 75]);
  });

  test("day 4 bench ramps 87.5 / 90 / 95%", () => {
    expect(weights(session(4, 4), "Bench Press")).toEqual([35, 35, 37.5]);
  });
});

describe("week 5 — the test week", () => {
  test("each primary lift gets one 97.5% set of 1-4 reps", () => {
    expect(weights(session(5, 1), "Squat")).toEqual([67.5]);
    expect(weights(session(5, 2), "Bench Press")).toEqual([40]);
    expect(weights(session(5, 3), "Deadlift")).toEqual([77.5]);
    for (const [week, day, name] of [
      [5, 1, "Squat"],
      [5, 2, "Bench Press"],
      [5, 3, "Deadlift"],
    ] as const) {
      expect(lift(session(week, day), name).sets[0]?.reps).toEqual({
        kind: "range",
        min: 1,
        max: 4,
      });
    }
  });

  test("day 1 deadlift is submaximal volume beneath the squat test", () => {
    expect(weights(session(5, 1), "Deadlift")).toEqual([55, 55, 57.5]);
  });
});

describe("week 6 options", () => {
  test("skip yields no sessions", () => {
    expect(generateBlock(CONFIG, "skip").filter((s) => s.week === 6)).toHaveLength(0);
  });

  test("deload replays week 1 minus its final upper day", () => {
    const deload = generateBlock(CONFIG, "deload").filter((s) => s.week === 6);
    expect(deload).toHaveLength(4);
    expect(deload.map((s) => s.day)).toEqual([1, 2, 3, 4]);
    expect(deload[0]?.date).toBe("2026-02-09");
  });

  test("test yields one single-rep session per lift", () => {
    const retest = generateBlock(CONFIG, "test").filter((s) => s.week === 6);
    expect(retest.map((s) => s.exercises[0]?.exercise)).toEqual([
      "Squat",
      "Bench Press",
      "Deadlift",
    ]);
  });
});

describe("nothing prescribed depends on wall-clock time (ADR-0001)", () => {
  test("regenerating the same config is byte-identical", () => {
    expect(JSON.stringify(generateBlock(CONFIG))).toBe(JSON.stringify(generateBlock(CONFIG)));
  });
});
