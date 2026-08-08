import type { AccessoryChoices } from "./types.js";

/**
 * The accessory menus the source spreadsheet offers per slot.
 *
 * These are *suggestions*, not a closed set — the athlete may type anything.
 * They exist so the UI can offer the same picks the sheet did without the user
 * having to remember them.
 */
export const ACCESSORY_OPTIONS = {
  upperBackHorizontal: ["Dumbbell Row", "Barbell Row", "Machine Row", "Olympic Ring Row"],
  shoulder: [
    "Seated Dumbbell OHP",
    "Standing Dumbbell OHP",
    "Military Press",
    "Lateral Dumbbell Raise",
  ],
  upperBackVertical: [
    "Weighted Pull-up",
    "Weighted Chin-up",
    "Lat Pulldown",
    "Banded Lat Pulldown",
  ],
  deadliftVariation: [
    "Stiff Legged Deadlift",
    "Snatch Grip Deadlift",
    "Deficit Deadlift",
    "Pause Deadlift",
  ],
} as const;

/**
 * A sensible starting set, matching the source spreadsheet's own selections.
 * Every field is overridable per block — accessories are block config, so a
 * change takes effect at the next block boundary rather than mid-cycle.
 */
export const DEFAULT_ACCESSORIES: AccessoryChoices = {
  upperBackHorizontal: "Barbell Row",
  shoulder: "Military Press",
  upperBackVertical: "Banded Lat Pulldown",
  optional1: "Landmine Single-Arm Overhead Press",
  optional2: "Landmine Single-Arm Row",
  optionalLower1: "Plate Push Press",
  optionalLower2: "Dumbbell Lunges",
  deadliftVariation: "Stiff Legged Deadlift",
};
