import { describe, expect, test } from "bun:test";
import { CANDITO_6_WEEK, groupByExercise, rolloutBlock, type Session } from "@fit/program";

import { activitiesFromBody, adaptBlock, isLegacyBlock } from "./legacy.js";

/**
 * Reading blocks written before the domain rebuild.
 *
 * This is the test that matters most about ADR-0038: an append-only store
 * changed shape, and the claim is that history is adapted rather than rewritten
 * or stranded. The claim is only true if a pre-rebuild block rolls out to
 * BYTE-IDENTICAL sessions, so that is what is asserted, not merely that it
 * parses.
 */

/** Exactly what the table holds for a block created before the rebuild. */
const LEGACY_ITEM = {
  pk: "USER#someone@example.com",
  sk: "BLOCK#2026-01-05#B-20260105",
  blockId: "B-20260105",
  startDate: "2026-01-05",
  units: "kg" as const,
  oneRepMax: { bench: 40, squat: 70, deadlift: 80 },
  accessories: {
    upperBackHorizontal: "Barbell Row",
    shoulder: "Dumbbell Shoulder Press",
    upperBackVertical: "Lat Pulldown",
    optional1: "Barbell Curl",
    optional2: "Tricep Pushdown",
    optionalLower1: "Leg Press",
    optionalLower2: "Standing Calf Raise",
    deadliftVariation: "Romanian Deadlift",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** The same block, written after the rebuild. */
const CURRENT_ITEM = {
  pk: "USER#someone@example.com",
  sk: "BLOCK#2026-01-05#B-20260105",
  blockId: "B-20260105",
  programId: "candito-6-week",
  startDate: "2026-01-05",
  units: "kg" as const,
  parameters: {
    bench: 40,
    squat: 70,
    deadlift: 80,
    units: "kg",
    upperBackHorizontal: "Barbell Row",
    shoulder: "Dumbbell Shoulder Press",
    upperBackVertical: "Lat Pulldown",
    optional1: "Barbell Curl",
    optional2: "Tricep Pushdown",
    optionalLower1: "Leg Press",
    optionalLower2: "Standing Calf Raise",
    deadliftVariation: "Romanian Deadlift",
    week6: "skip",
  },
};

const weights = (s: Session, exercise: string): (number | undefined)[] =>
  groupByExercise(s.activities)
    .find((g) => g.exercise === exercise)
    ?.activities.map((a) => a.weight) ?? [];

describe("detecting the old shape", () => {
  test("a pre-rebuild item is recognised", () => {
    expect(isLegacyBlock(LEGACY_ITEM)).toBe(true);
  });

  test("a current item is not", () => {
    expect(isLegacyBlock(CURRENT_ITEM)).toBe(false);
  });
});

describe("adapting a pre-rebuild block", () => {
  test("the nested maxes and accessories flatten into parameters", () => {
    const config = adaptBlock(LEGACY_ITEM);
    expect(config.parameters["squat"]).toBe(70);
    expect(config.parameters["deadliftVariation"]).toBe("Romanian Deadlift");
  });

  test("it is attributed to Candito, the only program that existed", () => {
    expect(adaptBlock(LEGACY_ITEM).programId).toBe("candito-6-week");
  });

  test("the DynamoDB key attributes are dropped", () => {
    const config = adaptBlock(LEGACY_ITEM);
    expect("pk" in config).toBe(false);
    expect("sk" in config).toBe(false);
  });

  test("it rolls out to BYTE-IDENTICAL sessions", () => {
    // The whole claim of ADR-0038 in one assertion. If this fails, a block from
    // before the rebuild renders different weights than it did — which is data
    // loss wearing a refactor's clothes.
    const fromLegacy = rolloutBlock(CANDITO_6_WEEK, adaptBlock(LEGACY_ITEM));
    const fromCurrent = rolloutBlock(CANDITO_6_WEEK, adaptBlock(CURRENT_ITEM));
    expect(JSON.stringify(fromLegacy)).toBe(JSON.stringify(fromCurrent));
  });

  test("and those sessions still match the workbook", () => {
    const sessions = rolloutBlock(CANDITO_6_WEEK, adaptBlock(LEGACY_ITEM));
    const w1d1 = sessions.find((s) => s.week === 1 && s.day === 1) as Session;
    expect(weights(w1d1, "Squat")).toEqual([55, 55, 55, 55]);
    expect(weights(w1d1, "Deadlift")).toEqual([65, 65]);
  });
});

describe("adapting is idempotent", () => {
  test("a current block passes through untouched", () => {
    const once = adaptBlock(CURRENT_ITEM);
    // The caller never has to ask which shape it is holding.
    expect(adaptBlock(once)).toEqual(once);
  });

  test("derivedFrom survives both shapes", () => {
    expect(adaptBlock({ ...LEGACY_ITEM, derivedFrom: "B-20251124" }).derivedFrom).toBe(
      "B-20251124",
    );
    expect(adaptBlock({ ...CURRENT_ITEM, derivedFrom: "B-20251124" }).derivedFrom).toBe(
      "B-20251124",
    );
  });

  test("an absent derivedFrom is absent, not undefined-valued", () => {
    // `exactOptionalPropertyTypes` makes these different, and a present-undefined
    // key is what DynamoDB rejects on write.
    expect("derivedFrom" in adaptBlock(LEGACY_ITEM)).toBe(false);
  });
});

describe("normalising a logged-activity request across the rebuild", () => {
  test("the current shape passes through", () => {
    const body = { activities: [{ exercise: "Squat", reps: 5 }] };
    expect(activitiesFromBody(body)).toBe(body);
  });

  test("the pre-rebuild shape is renamed, not rejected", () => {
    // A browser tab open across the release still posts `sets`. Losing a
    // session's work for the sake of a field name is not an acceptable trade.
    expect(activitiesFromBody({ sets: [{ exercise: "Squat", reps: 5 }] })).toEqual({
      activities: [{ exercise: "Squat", reps: 5 }],
    });
  });

  test("`activities` wins when a client somehow sends both", () => {
    const body = { activities: [{ exercise: "Squat", reps: 5 }], sets: [] };
    expect(activitiesFromBody(body)).toBe(body);
  });

  test("anything else is handed on untouched, to fail in the schema", () => {
    // Guessing at a third shape here would turn a clear 400 into a silent
    // mis-parse.
    expect(activitiesFromBody(null)).toBeNull();
    expect(activitiesFromBody({ nonsense: true })).toEqual({ nonsense: true });
  });
});
