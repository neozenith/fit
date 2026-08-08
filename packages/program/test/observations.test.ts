import { describe, expect, test } from "bun:test";
import { expandSeason, planSeason, seasonOfMonth } from "../src/calendar.js";
import type { MeasurementRecord, SetRecord } from "../src/observations.js";
import {
  estimatedOneRepMax,
  expandActivityRow,
  median,
  parseDuration,
  personalBests,
  splitPackedCell,
  weeklyMedians,
} from "../src/observations.js";
import { LIFT_LABELS } from "../src/types.js";

describe("importing the spreadsheet's drifted log formats", () => {
  test.each([
    ["2m12s", 132],
    ["2:02", 122],
    ["1h02m03s", 3723],
    ["1:02:03", 3723],
    ["45s", 45],
    [90, 90],
  ])("parseDuration(%p) = %p seconds", (raw, expected) => {
    expect(parseDuration(raw)).toBe(expected);
  });

  test("an unparseable duration drops out rather than becoming NaN", () => {
    expect(parseDuration("about two minutes")).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
    expect(parseDuration(null)).toBeUndefined();
  });

  test("packed cells split into their values", () => {
    expect(splitPackedCell("50,60,60,60")).toEqual([50, 60, 60, 60]);
    expect(splitPackedCell("10, 8, 6")).toEqual([10, 8, 6]);
    expect(splitPackedCell(60)).toEqual([60]);
    expect(splitPackedCell("")).toEqual([]);
  });

  test("a packed weight column expands into one record per set", () => {
    // Verbatim from the source sheet: Squat, "50,60,60,60", 6 reps.
    const records = expandActivityRow({
      timestamp: "2026-01-06T00:51:52Z",
      exercise: "Squat",
      weight: "50,60,60,60",
      reps: 6,
      units: "kg",
    });
    expect(records).toHaveLength(4);
    expect(records.map((r) => r.weight)).toEqual([50, 60, 60, 60]);
    expect(records.every((r) => r.reps === 6)).toBe(true);
    expect(records.map((r) => r.setIndex)).toEqual([1, 2, 3, 4]);
  });

  test("a packed reps column against a scalar weight does the same", () => {
    // Verbatim: Barbell Row, 50kg, "10,8,6".
    const records = expandActivityRow({
      timestamp: "2026-01-07T18:42:03Z",
      exercise: "Barbell Row",
      weight: 50,
      reps: "10,8,6",
      units: "kg",
    });
    expect(records.map((r) => r.reps)).toEqual([10, 8, 6]);
    expect(records.every((r) => r.weight === 50)).toBe(true);
  });

  test("an explicit sets count repeats a scalar row", () => {
    const records = expandActivityRow({
      timestamp: "2026-01-06T02:17:44Z",
      exercise: "Landmine SA OH Press",
      weight: 15,
      sets: 3,
      reps: 8,
      units: "kg",
    });
    expect(records).toHaveLength(3);
  });

  test("mismatched packed columns are surfaced, not silently aligned", () => {
    expect(() =>
      expandActivityRow({
        timestamp: "2026-01-07T18:00:00Z",
        exercise: "Bench press",
        weight: "50,60",
        reps: "10,8,6",
        units: "kg",
      }),
    ).toThrow(/Ambiguous activity row/);
  });

  test("a row with no reps yields nothing (cardio rows live elsewhere)", () => {
    expect(
      expandActivityRow({
        timestamp: "2026-01-06T00:22:55Z",
        exercise: "Rower",
        units: "kg",
      }),
    ).toEqual([]);
  });
});

describe("derived views", () => {
  const records: SetRecord[] = [
    {
      timestamp: "2026-01-07T18:11:00Z",
      exercise: "Bench press",
      weight: 50,
      reps: 10,
      units: "kg",
    },
    {
      timestamp: "2026-01-07T18:24:55Z",
      exercise: "Bench press",
      weight: 60,
      reps: 6,
      units: "kg",
    },
    { timestamp: "2026-01-06T00:52:07Z", exercise: "Deadlift", weight: 60, reps: 6, units: "kg" },
  ];

  test("Epley estimates a 1RM from a real set", () => {
    expect(estimatedOneRepMax(60, 6)).toBeCloseTo(72, 6);
    expect(estimatedOneRepMax(100, 1)).toBeCloseTo(103.333, 3);
    expect(Number.isNaN(estimatedOneRepMax(100, 0))).toBe(true);
  });

  test("personal bests pick the best estimate, not the heaviest bar", () => {
    const best = personalBests(records, LIFT_LABELS);
    // 50x10 estimates 66.7; 60x6 estimates 72 — the heavier set also wins here.
    expect(best.bench?.weight).toBe(60);
    expect(best.bench?.reps).toBe(6);
    expect(best.deadlift?.estimated).toBeCloseTo(72, 6);
    expect(best.squat).toBeUndefined();
  });

  test("exercise matching is case-insensitive, as the sheet's entries were", () => {
    // The sheet logs "Bench press" while the program prescribes "Bench Press".
    expect(personalBests(records, LIFT_LABELS).bench).toBeDefined();
  });

  test("median sees through daily noise where a mean would not", () => {
    expect(median([99.5, 99.7, 100.5, 99.4])).toBeCloseTo(99.6, 6);
    expect(median([99.4])).toBe(99.4);
    expect(median([])).toBeUndefined();
  });

  test("weekly medians roll body metrics up per week", () => {
    const measurements: MeasurementRecord[] = [
      { timestamp: "2026-01-05T22:30:57Z", kind: "bodyWeight", value: 99.5 },
      { timestamp: "2026-01-06T13:59:33Z", kind: "bodyWeight", value: 99.7 },
      { timestamp: "2026-01-07T17:46:52Z", kind: "bodyWeight", value: 100.5 },
      { timestamp: "2026-01-05T22:31:08Z", kind: "waistCircumference", value: 106 },
      { timestamp: "2026-01-13T14:17:18Z", kind: "bodyWeight", value: 99.4 },
    ];
    const rollup = weeklyMedians(measurements, ["2026-01-05", "2026-01-12"]);
    expect(rollup[0]?.bodyWeight).toBe(99.7);
    expect(rollup[0]?.waistCircumference).toBe(106);
    expect(rollup[1]?.bodyWeight).toBe(99.4);
  });
});

describe("season calendar", () => {
  test("seasons are southern-hemisphere: January is Summer", () => {
    expect(seasonOfMonth(1)).toBe("Summer");
    expect(seasonOfMonth(4)).toBe("Autumn");
    expect(seasonOfMonth(7)).toBe("Winter");
    expect(seasonOfMonth(10)).toBe("Spring");
    expect(seasonOfMonth(12)).toBe("Summer");
  });

  test("weeks step seven days from the season start", () => {
    const weeks = expandSeason(planSeason({ startDate: "2026-01-05", weeks: 3 }));
    expect(weeks.map((w) => w.startDate)).toEqual(["2026-01-05", "2026-01-12", "2026-01-19"]);
    expect(weeks[0]?.quarter).toBe(1);
  });

  test("fixtures interrupt a block and the next strength week starts a new one", () => {
    // Mirrors the source calendar: block 1 runs weeks 1-6, weeks 7-8 are
    // fixtures, block 2 picks up at week 9.
    const plan = planSeason({
      startDate: "2026-01-05",
      weeks: 14,
      fixtures: { 7: "ZWIFT_FTP", 8: "PARKRUN" },
    });
    const weeks = expandSeason(plan);
    expect(weeks[5]?.block).toEqual({ blockNumber: 1, weekOfBlock: 6 });
    expect(weeks[6]?.event).toBe("ZWIFT_FTP");
    expect(weeks[7]?.event).toBe("PARKRUN");
    expect(weeks[8]?.block).toEqual({ blockNumber: 2, weekOfBlock: 1 });
    expect(weeks[13]?.block).toEqual({ blockNumber: 2, weekOfBlock: 6 });
  });

  test("a mid-block fixture ends that block early", () => {
    const weeks = expandSeason(
      planSeason({ startDate: "2026-01-05", weeks: 6, fixtures: { 3: "PARKRUN" } }),
    );
    expect(weeks[1]?.block).toEqual({ blockNumber: 1, weekOfBlock: 2 });
    expect(weeks[2]?.event).toBe("PARKRUN");
    expect(weeks[3]?.block).toEqual({ blockNumber: 2, weekOfBlock: 1 });
  });
});
