import { describe, expect, test } from "bun:test";
import { DEFAULT_ACCESSORIES } from "../src/defaults.js";
import {
  applyFailureAdjustment,
  projectMax,
  proposeNextBlock,
  repFactor,
} from "../src/projection.js";
import type { BlockConfig } from "../src/types.js";
import { increment, mround, workingWeight } from "../src/units.js";

const CONFIG: BlockConfig = {
  blockId: "block-1",
  startDate: "2026-01-05",
  units: "kg",
  oneRepMax: { bench: 40, squat: 70, deadlift: 80 },
  accessories: DEFAULT_ACCESSORIES,
};

describe("MROUND matches Excel's semantics", () => {
  test.each([
    [49, 2.5, 50],
    [56, 2.5, 55],
    [68.25, 2.5, 67.5],
    [27, 2.5, 27.5],
    [0, 2.5, 0],
    [77, 5, 75],
    [78, 5, 80],
  ])("mround(%p, %p) = %p", (value, multiple, expected) => {
    expect(mround(value, multiple)).toBe(expected);
  });

  test("float dust never leaks into a displayed weight", () => {
    // 0.675 * 40 is 26.999999999999996 in binary floating point.
    expect(workingWeight(40, 0.675, "kg")).toBe(27.5);
    expect(Number.isInteger(workingWeight(40, 0.675, "kg") * 10)).toBe(true);
  });

  test("pounds use a 5 lb increment throughout", () => {
    expect(increment("lb")).toBe(5);
    expect(workingWeight(225, 0.85, "lb")).toBe(190);
    expect(workingWeight(225, 0.85, "lb", { nudge: 1 })).toBe(195);
  });

  test("a nudge inside the rounding can differ from one outside it", () => {
    // The case `workingWeight`'s docstring names: a 100 unit max at 85%.
    expect(workingWeight(100, 0.85, "kg", { nudge: 1 })).toBe(87.5);
    expect(workingWeight(100, 0.85, "kg", { preNudge: 1 })).toBe(87.5);
    // ...and one where they diverge:
    expect(workingWeight(71, 0.85, "kg", { nudge: 1 })).toBe(62.5);
    expect(workingWeight(71, 0.85, "kg", { preNudge: 1 })).toBe(62.5);
    expect(workingWeight(71, 0.85, "kg", { preNudge: 1, nudge: 1 })).toBe(65);
  });
});

describe("the program's own rep-to-max table", () => {
  test.each([
    [1, 1.0],
    [2, 1.03],
    [3, 1.06],
    [4, 1.09],
  ])("%i reps gives a factor of %p", (reps, factor) => {
    expect(repFactor(reps)).toBeCloseTo(factor, 10);
  });

  test("beyond four reps the table's own slope continues", () => {
    expect(repFactor(5)).toBeCloseTo(1.12, 10);
    expect(repFactor(6)).toBeCloseTo(1.15, 10);
  });

  test("a failed set projects nothing rather than a fabricated number", () => {
    expect(projectMax("squat", 67.5, 0, "kg")).toBeNull();
  });

  test("a 3-rep set at 67.5kg projects to a rounded 71.5 -> 72.5", () => {
    const p = projectMax("squat", 67.5, 3, "kg");
    expect(p?.projected).toBeCloseTo(71.55, 6);
    expect(p?.projectedRounded).toBe(72.5);
  });
});

describe("block-to-block recursion (ADR-0013)", () => {
  test("the next block is a NEW item pointing back at its parent", () => {
    const { config } = proposeNextBlock(
      CONFIG,
      [
        { lift: "squat", weight: 67.5, reps: 3 },
        { lift: "bench", weight: 40, reps: 2 },
        { lift: "deadlift", weight: 77.5, reps: 4 },
      ],
      { blockId: "block-2", startDate: "2026-02-16" },
    );

    expect(config.blockId).toBe("block-2");
    expect(config.derivedFrom).toBe("block-1");
    expect(CONFIG.oneRepMax.squat).toBe(70); // the parent is untouched
    expect(config.oneRepMax).toEqual({ squat: 72.5, bench: 40, deadlift: 85 });
  });

  test("an untested lift carries its seed forward rather than being dropped", () => {
    const { config, carriedForward } = proposeNextBlock(
      CONFIG,
      [{ lift: "squat", weight: 67.5, reps: 3 }],
      { blockId: "block-2", startDate: "2026-02-16" },
    );
    expect(carriedForward).toEqual(["bench", "deadlift"]);
    expect(config.oneRepMax.bench).toBe(40);
    expect(config.oneRepMax.deadlift).toBe(80);
  });

  test("accessories carry forward by value, not by reference", () => {
    const { config } = proposeNextBlock(CONFIG, [], {
      blockId: "block-2",
      startDate: "2026-02-16",
    });
    config.accessories.shoulder = "Push Press";
    expect(CONFIG.accessories.shoulder).toBe("Military Press");
  });
});

describe("the 2.5% failure rule", () => {
  test("reduces one lift and leaves the others alone", () => {
    const next = applyFailureAdjustment(CONFIG, "squat", { blockId: "block-1b" });
    expect(next.oneRepMax.squat).toBe(67.5); // mround(68.25, 2.5)
    expect(next.oneRepMax.bench).toBe(40);
    expect(next.derivedFrom).toBe("block-1");
  });

  test("never mutates the block it adjusts", () => {
    applyFailureAdjustment(CONFIG, "squat", { blockId: "block-1b" });
    expect(CONFIG.oneRepMax.squat).toBe(70);
  });
});
