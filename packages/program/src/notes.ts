/**
 * The program's own prose, carried across from the source workbook.
 *
 * The spreadsheet said what each accessory slot was FOR — its `Inputs!` labels
 * read "Upper Back Exercise #1 (horizontal pull)", not "upperBackHorizontal" —
 * and it carried a short glossary that every rep target depends on. Neither
 * survived the port, so a prescribed slot arrived in the app as a bare exercise
 * name with no statement of what it is meant to be training.
 *
 * That is a real loss, not a cosmetic one: the whole point of a slot is that
 * the program asks for a *movement* and the athlete picks the lift. Without the
 * intent, an accessory is just a name someone once chose, and there is nothing
 * on screen to judge a replacement against.
 *
 * Everything here is prose ABOUT the program, never a number used BY it. The
 * 2.5% rule appears below as a sentence and in `types.ts` as
 * `oneRepMaxFactor: 0.975`; the computable form is the one the engine reads
 * (ADR-0001), and this one is what it says to a human.
 */

import type { ExerciseRole } from "./types.js";

/**
 * What each prescribed slot is for.
 *
 * Keyed on `ExerciseRole`, which every `PrescribedExercise` already carries, so
 * surfacing this needs no new field on any stored or projected record.
 */
export const ROLE_INTENT: Record<ExerciseRole, string> = {
  primary: "The projected lift — its weight comes from the block's 1RM.",
  deadliftVariation: "A deadlift variation: stiff-legged, snatch-grip, deficit or paused.",
  upperBackHorizontal: "Upper back #1 — a horizontal pull.",
  shoulder: "Shoulders — a vertical push.",
  upperBackVertical: "Upper back #2 — a vertical pull.",
  optional: "Optional accessory — free choice, and fine to skip.",
  optionalLower: "Optional lower body — free choice, and fine to skip.",
};

/**
 * The workbook's `Additional Information` block, verbatim in meaning.
 *
 * `MR` and `MR10` are not decoration: every conditional rule in the program
 * keys off the reps achieved on one of those sets, so a reader who does not
 * know what the notation means cannot follow their own prescription.
 */
export const GLOSSARY: readonly { term: string; meaning: string }[] = [
  { term: "MR", meaning: "Max reps — take the set to as many reps as you can." },
  { term: "MR10", meaning: "Max reps, but stop at 10 even if more are there." },
  {
    term: "Deadlift variation",
    meaning: "Stiff-legged, snatch-grip, deficit or paused deadlift — your choice.",
  },
  {
    term: "Failing a rep",
    meaning: "If you ever fail a required rep, reduce that lift's max by 2.5%.",
  },
];

/**
 * Week 6 is a decision, not a prescription.
 *
 * The sheet devotes its sixth tab to three options and the arithmetic for
 * projecting a new max. The app models the choice (`WeekSixChoice`), but the
 * reasoning behind it lived only in the spreadsheet until now.
 */
export const WEEK_SIX_NOTES: readonly string[] = [
  "Week 6 has three options.",
  "1. Skip week 6 — use the projected max from last week's 1-4 rep set and start the next cycle.",
  "2. Use the projected max for the next cycle, but take a deload week (repeat week 1, skipping the last upper workout).",
  "3. Use week 6 to actually find your 1RM, then either deload or start a new cycle.",
  "Projected max: take what you lifted in week 5 and multiply by 1.03 for 2 reps, 1.06 for 3, or 1.09 for 4.",
];
