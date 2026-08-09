import { describe, expect, test } from "bun:test";
import { blockId, blockLabel, blockStartDate, parseSessionRef, sessionRef } from "./identifiers.js";

describe("block identifiers", () => {
  test("the identity is the start date, so it sorts chronologically", () => {
    const ids = ["2027-08-10", "2026-01-05", "2027-08-09"].map(blockId);
    // Plain string sort. This is the whole reason for the format: no comparator,
    // no parsing, and a DynamoDB range query over it is already in date order.
    expect([...ids].sort()).toEqual(["B-20260105", "B-20270809", "B-20270810"]);
  });

  test("two blocks starting the same day share an identity", () => {
    // Not a collision — the supersede rule (ADR-0029) expressed in the key.
    expect(blockId("2027-08-10")).toBe(blockId("2027-08-10"));
  });

  test.each([
    ["B-20270810", "B-2027AUG10"],
    ["B-20260105", "B-2026JAN05"],
    ["B-20261231", "B-2026DEC31"],
  ])("%s displays as %s", (id, label) => {
    expect(blockLabel(id)).toBe(label);
  });

  test("an identifier of the older shape is abbreviated, not reinterpreted", () => {
    // Blocks created before this scheme carry a UUID and are append-only, so
    // they cannot be rewritten. A short one prints whole; a UUID is truncated,
    // because 36 characters in a timeline row pushes everything else off screen.
    expect(blockLabel("seed-block-1")).toBe("seed-block-1");
    expect(blockLabel("6d3f700d-dc6f-4f14-bf5a-23b9aea00722")).toBe("6d3f700d…");
    expect(blockStartDate("seed-block-1")).toBeNull();
  });

  test("a session reference round-trips", () => {
    const ref = sessionRef("B-20270810", 5, 1);
    expect(ref).toBe("B-20270810-W5D1");
    expect(parseSessionRef(ref)).toEqual({ blockId: "B-20270810", week: 5, day: 1 });
  });

  test("a malformed session reference parses to null rather than to nonsense", () => {
    expect(parseSessionRef("B-20270810")).toBeNull();
    expect(parseSessionRef("W5D1")).toBeNull();
    expect(parseSessionRef("seed-block-1-W5D1")).toBeNull();
  });
});
