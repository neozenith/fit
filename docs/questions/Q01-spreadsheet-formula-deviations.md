# Q01 — Two spreadsheet formulas look like units bugs. Fix or preserve?

**Status:** ✅ **ANSWERED 2026-08-08 — fix both. The assumptions taken were correct.**
**Raised:** 2026-08-08, during the engine port.
**Lens checked:** ADR-0001 (program is a pure function), ADR-0020 (queue, don't block).
Neither Lens rules on *fidelity to a defective source*, so this was a genuine open question.

## Answer

> "It is a copy-paste error, it should have been *one increment*."

Both deviations stand as implemented. The engine is correct as written and the
`DEVIATION` markers in `packages/program/test/golden.test.ts` now record a
*confirmed correction* rather than a pending assumption — they stay in place so
a future reader comparing against the workbook is not confused by the mismatch.

**Rule this establishes:** where the workbook writes a literal `+2.5` / `-5`,
the intent is always *one increment* in the athlete's own units. Any further
formula ported from the workbook applies the same reading without re-asking.
Recorded as the Lens on ADR-0021.

The rest of this file is the original analysis, kept because it is the evidence
behind the correction.

## The question

Two cells in the source workbook compute a weight that appears to be wrong
rather than merely surprising. The engine implements what the formula seems to
have *meant*, not what it *says*. Both choices are recorded in
`packages/program/test/golden.test.ts`, marked `DEVIATION`.

## Deviation 1 — Week 4, Day 2 bench subtracts a literal 5

**The sheet** (`Week 4!C12`, `E12`):

```
=IF(Inputs!B11="kg", MROUND((Inputs!B14*0.875)-5, 2.5),
                     MROUND((Inputs!B14*0.875)-5, 5))
```

The `-5` is identical in both branches. In pounds that is one plate step; in
kilograms it is two. On the workbook's own 40kg bench seed the kilogram branch
yields `MROUND(35 - 5, 2.5) = 30`, a 12.5% drop below the intended 87.5%
working weight — and it makes the day's *first* set lighter than a set that is
supposed to be part of a heavy ramp.

Every other nudge in the workbook is one increment. This one reads as a formula
written in pounds and copied into the kilogram branch without conversion.

**Assumption taken.** Subtract **one increment** (2.5kg / 5lb), giving
`[32.5, 32.5, 35]` where the sheet gives `[30, 30, 35]`.

**To reverse:** change `preNudge: -1` to `preNudge: -2` on the two Week 4 Day 2
bench sets in `packages/program/src/program.ts`, and update the golden test.

## Deviation 2 — Week 1, Day 4 tests an empty cell

**The sheet** (`Week 1!C30`, `C31`):

```
=IF((Inputs!B36="kg"), MROUND((Inputs!B15*0.7),2.5), MROUND((Inputs!B15*0.7),5))
```

`Inputs!B36` is empty. The units flag actually lives in `Inputs!B11`, which
every other formula in the workbook uses. So this condition is always false and
the day always rounds to the pound multiple, regardless of the athlete's chosen
units — a copy/paste slip of a row reference.

At the workbook's own seeds both branches happen to agree (49 → 50 either way),
so the bug is invisible there. It is not invisible at other seeds: a 100kg squat
gives `MROUND(70, 2.5) = 70` correctly, but `MROUND(70, 5) = 70` too — while a
102.5kg squat gives 71.5 → **72.5** correct versus **70** buggy.

**Assumption taken.** Read the units flag, like every other formula does.
The golden test asserts the unchanged values at the workbook's seeds and notes
the divergence.

**To reverse:** nothing to change in the engine — it would mean *introducing*
the bug, which is not worth doing.

## Why this was not worth blocking on

Both are single-line changes with full test coverage either way, and both only
move a prescribed weight by one increment. The cost of guessing wrong is one
slightly-off training session; the cost of stopping to ask is the whole build.
Per ADR-0020, decide and record.

## What would settle it

Confirmation of whether the athlete has been *training* to the sheet's literal
numbers. If yes, preserving the literal values keeps continuity with logged
history and the deviations should be reverted; if the sheet is fresh, the
corrected arithmetic is strictly better.
