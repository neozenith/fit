import { describe, expect, test } from "bun:test";
import { sessionCompletion, sessionState } from "./completion.js";
import { fixed, freeChoice, percentageOf, sessionPlan } from "./plan.js";
import type { Session } from "./types.js";

const session = (): Session => {
  const plan = sessionPlan("test-w1d1", "Squat & Deadlift", [
    { exercise: "Squat", reps: fixed(6), load: percentageOf("squat", 0.8), role: "primary" },
    { exercise: "Deadlift", reps: fixed(6), load: percentageOf("deadlift", 0.8), role: "primary" },
    // The two the program deliberately leaves unprescribed.
    freeChoice("Landmine SA OHP", "optional"),
    freeChoice("Landmine SA Row", "optional"),
  ]);

  return {
    sessionRef: "B-20260803-W1D1",
    week: 1,
    day: 1,
    date: "2026-08-03",
    dayOffset: 0,
    name: plan.name,
    phase: "Muscular Conditioning",
    activities: plan.activities,
    notes: [],
  };
};

describe("session completion", () => {
  test("counts EVERY exercise, including unprescribed ones", () => {
    // The bug this replaced: filtering on "has prescribed sets" reported a
    // session of four exercises as having two, which disagreed with the list
    // beneath it.
    expect(sessionCompletion(session()).total).toBe(4);
  });

  test("an unprescribed exercise needs one activity; a prescribed one needs all of them", () => {
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
    // Three activities logged against a one-set prescription still counts as one.
    expect(result.setsDone).toBe(2);
    expect(result.setsTotal).toBe(4);
  });

  test("a multi-set exercise needs every one of its sets", () => {
    const plan = sessionPlan("multi", "Squat only", [
      { exercise: "Squat", reps: fixed(5), load: percentageOf("squat", 0.8) },
      { exercise: "Squat", reps: fixed(5), load: percentageOf("squat", 0.8) },
      { exercise: "Squat", reps: fixed(5), load: percentageOf("squat", 0.8) },
    ]);
    const s: Session = { ...session(), activities: plan.activities };

    expect(sessionCompletion(s, { Squat: [{}, {}] }).done).toBe(0);
    expect(sessionCompletion(s, { Squat: [{}, {}, {}] }).done).toBe(1);
  });
});
