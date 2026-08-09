import { describe, expect, test } from "bun:test";
import { sessionCompletion, sessionState } from "./completion.js";
import type { Session } from "./types.js";

const session = (): Session => ({
  week: 1,
  day: 1,
  date: "2026-08-03",
  dayOffset: 0,
  weekTitle: "Muscular Conditioning",
  exercises: [
    {
      exercise: "Squat",
      role: "primary",
      sets: [{ weight: 55, reps: { kind: "fixed", reps: 6 } }],
    },
    {
      exercise: "Deadlift",
      role: "primary",
      sets: [{ weight: 65, reps: { kind: "fixed", reps: 6 } }],
    },
    // The two the program deliberately leaves unprescribed.
    { exercise: "Landmine SA OHP", role: "optional", sets: [] },
    { exercise: "Landmine SA Row", role: "optional", sets: [] },
  ],
  notes: [],
});

describe("session completion", () => {
  test("counts EVERY exercise, including unprescribed ones", () => {
    // The bug this replaced: filtering on `sets.length > 0` reported a session
    // of four exercises as having two, which disagreed with the list beneath it.
    expect(sessionCompletion(session()).total).toBe(4);
  });

  test("an unprescribed exercise needs one set; a prescribed one needs all of them", () => {
    const partial = sessionCompletion(session(), {
      Squat: [{}],
      "Landmine SA OHP": [{}],
    });
    expect(partial.done).toBe(2);
    expect(partial.total).toBe(4);
  });

  test("skipping an optional accessory reads as incomplete rather than as done", () => {
    // Accurate: you did skip it. Better than a denominator that hides the fact.
    const log = { Squat: [{}], Deadlift: [{}], "Landmine SA OHP": [{}] };
    expect(sessionState(session(), log, "2026-08-05")).toBe("partial");
  });

  test("every exercise logged is complete", () => {
    const log = {
      Squat: [{}],
      Deadlift: [{}],
      "Landmine SA OHP": [{}],
      "Landmine SA Row": [{}],
    };
    expect(sessionState(session(), log, "2026-08-05")).toBe("done");
  });

  test("an untouched session is upcoming before its date and outstanding after", () => {
    expect(sessionState(session(), {}, "2026-08-01")).toBe("future");
    expect(sessionState(session(), {}, "2026-08-05")).toBe("todo");
  });

  test("set totals cap per exercise, so extra sets cannot exceed the target", () => {
    const log = { Squat: [{}, {}, {}], Deadlift: [{}] };
    const result = sessionCompletion(session(), log);
    // Three sets logged against a one-set prescription still counts as one.
    expect(result.setsDone).toBe(2);
    expect(result.setsTotal).toBe(4);
  });
});
