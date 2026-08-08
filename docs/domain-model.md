# Domain model — the Candito 6-Week Strength Program

What the application actually models, derived by reading every formula in the
source workbook. The workbook itself stays out of the repository (it holds
personal body metrics); this file is the durable record of what it *meant*.

The engine that implements all of it is `packages/program`, and its golden tests
assert against the workbook's own computed cells.

## The one idea that shapes everything

A six-week block is a **projection of three numbers**. Bench, squat and deadlift
one-rep maxes, plus a units flag and a start date, determine every prescribed
weight across roughly 22 training sessions. Not one working weight is entered by
hand.

```
                        ┌──────────────────────────┐
   3 one-rep maxes ────►│                          │
   units (kg | lb) ────►│   generateBlock()        │────► ~22 dated sessions
   start date      ────►│   pure, no I/O           │      with every set's
   accessory picks ────►│                          │      weight and rep target
                        └──────────────────────────┘
```

That is why nothing prescribed is persisted (ADR-0001). Correcting a max
re-projects the entire block from one write.

### The rounding rule

Every weight is `MROUND(1RM × percentage, increment)`, where the increment is
2.5kg or 5lb — the smallest change that can actually be loaded on a bar. Some
weights carry an extra nudge of one increment, and **whether that nudge falls
inside or outside the rounding changes the answer**. Week 3 uses one form on its
first squat day and the other on its second; that difference *is* the week's
built-in progression, not an inconsistency.

## The six weeks

| Week | Phase | Shape |
|---|---|---|
| 1 | Muscular conditioning, moderate | 5 days. Flat volume at 70-80%, one max-reps bench set to finish. |
| 2 | Conditioning / hypertrophy, harder | 5 days. Two capped max-reps squat sets, each gating a **feedback rule**. |
| 3 | Linear max overload | 4 days. Triples at 85%, accessories stripped back to flat sixes, optional work removed entirely. |
| 4 | Heavy weight acclimation | 4 days. Ramped triples around 90%, first exposure to 95% singles. |
| 5 | High intensity strength | 3 days. One 97.5% set of 1-4 reps per lift — **these are the test sets**. |
| 6 | Retest, deload, or roll forward | The athlete's choice of three paths. |

Session dates are day offsets from the start date, exactly as the workbook
computes them: week 1 lands on days 0, 1, 3, 4, 5; week 2 on 7, 8, 10, 11, 13;
and so on. The pattern is deliberately irregular — it is a real training week,
not a tiling.

### Rep notation

The workbook writes rep targets four ways, and the distinction matters because
two of them are measurements rather than instructions:

| Notation | Meaning | Role |
|---|---|---|
| `x6` | exactly six reps | instruction |
| `x4-6` | anywhere in four to six | instruction |
| `xMR` | max reps — go to failure | **measurement** |
| `xMR10` | max reps, stop at ten | **measurement** |

Every feedback rule in the program keys off an `MR` or `MR10` set. They are the
only points where the program listens back.

## The feedback rules

The workbook states these in prose in merged cells. The engine makes them
computable, so the app can resolve them the moment the athlete logs the set —
something the spreadsheet could never do.

**Week 2, Day 1 — extra volume.** After the capped max-reps squat, add one
increment and perform 5 × 3 with 60s rest. Perform them *regardless* of the
result. If fewer than 8 reps were achieved, also reduce the entered max by 2.5%
going forward.

**Week 2, Day 3 — back-off volume, scaled to the result.** Reduce by two
increments, then:

| Reps achieved | Back-off work | 1RM adjustment |
|---|---|---|
| 10 | 10 sets × 3 | — |
| 8-9 | 8 sets × 3 | — |
| 7 | 5 sets × 3 | — |
| < 7 | none — skip entirely | reduce by at least 2.5% |

**Standing rule, any session.** "If you ever fail a required rep, reduce your
max by 2.5%."

Every one of these produces a *new* block config rather than editing the current
one (ADR-0013), so what was believed and when stays reconstructible.

## The recursion — how one block seeds the next

This is what makes the program a cycle rather than a plan. Week 5's single
1-4 rep set at 97.5% is converted into a projected one-rep max:

| Reps on the Week 5 test set | Multiplier |
|---|---|
| 1 | 1.00 |
| 2 | 1.03 |
| 3 | 1.06 |
| 4 | 1.09 |

The projection, rounded to the increment, becomes the next block's seed for that
lift. Week 6 offers three ways to get there:

1. **Skip** — take the projection and start the next block immediately.
2. **Deload** — take the projection, but repeat Week 1's loads first, omitting
   its final upper-body day.
3. **Test** — spend the week finding a true one-rep max, then deload or start.

A projection is a **proposal**, not a mutation. It is presented and accepted;
an unaccepted projection never silently changes the next block's prescription.
A lift with no usable test result carries its seed forward unchanged — an
untested lift has not got weaker.

Beyond four reps the program is silent, because a set that runs past 4 at 97.5%
means the entered max was too low. The engine continues the table's own linear
3-points-per-rep slope, which errs toward a larger jump that Week 2's feedback
rules will correct downward if it proves optimistic.

## The season calendar

Six-week blocks do not tile a year, and the gaps are the point. The workbook's
year sheet is **hand-authored**: blocks are placed around fixed events — a
cycling FTP test, a timed 5km, an end-of-year break — and a fixture landing
mid-block ends that block early rather than pausing it.

So the calendar is athlete configuration, not a derivation. The only derived
value is each week's start date (start + 7n) and its month, quarter and season.
Seasons are **southern-hemisphere**: December through February is Summer.

## Observations — what actually happened

Two append-only logs, both timestamp-keyed, both aged out to Parquet after 13
months (ADR-0012).

**Training sets.** Exercise, weight, reps, and the session they belong to.

**Body measurements.** Body weight (kg) and waist circumference (cm), rolled up
weekly by **median** rather than mean — a single post-meal weigh-in moves a mean
by a kilogram, and the whole purpose of the weekly figure is to see through
daily noise.

### Importing the old logs

The workbook's log sheets were filled by hand over months and the formats
drifted. The importer handles it in one place:

- A weight cell may read `60` or `50,60,60,60` — the latter meaning four sets.
- A reps cell may read `6` or `10,8,6`.
- Whichever column carries multiple values decides how many sets the row
  describes; the scalar side repeats across them.
- If **both** are packed and their lengths disagree, that is a data-entry error
  and the importer raises rather than guessing an alignment.
- Durations appear as `2m12s` *and* `2:02`; both parse. Anything unrecognisable
  returns nothing rather than `NaN`, so a garbled cell drops out of the import
  instead of poisoning an average.

### Two different one-rep-max estimators, deliberately

| Estimator | Formula | Used for |
|---|---|---|
| Program table | `weight × {1.00, 1.03, 1.06, 1.09}` | Seeding the next block. **Authoritative.** |
| Epley | `weight × (1 + reps/30)` | Charting progress across every logged set. |

They are kept separate so that improving the progress chart can never silently
change the training plan.

## Known deviations from the source workbook

Two formulas in the workbook appear to be units bugs, and the engine implements
the intent instead. Both are recorded, tested, and reversible — see
[`questions/Q01-spreadsheet-formula-deviations.md`](questions/Q01-spreadsheet-formula-deviations.md).
