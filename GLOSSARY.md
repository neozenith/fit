# Glossary

The ubiquitous language of this repository. Terms are used with exactly these
meanings in code, docs and commit messages — where a word appears as an
identifier, that identifier is given.

## The training program

**Block** (`BlockConfig`, `blockId`)
A six-week training cycle. It is defined by *three one-rep maxes*, a units flag,
a start date and a set of accessory choices — and by nothing else. Every
prescribed weight in the block is projected from those. A new block is always a
new item, never an edit of the previous one (ADR-0013).

**Seed** / **seed maxes** (`oneRepMax`)
The three numbers a block is projected from: bench, squat, deadlift. Distinct
from a *personal best*, which is an observation, and from an *estimated 1RM*,
which is a derivation.

**Prescription** (`Session`, `PrescribedExercise`, `PrescribedSet`)
What the program says to do. Computed on every read and **never persisted**
(ADR-0001). If you find a prescribed weight in DynamoDB, that is a bug.

**Observation** (`SetRecord`, `MeasurementRecord`, `CardioRecord`)
What actually happened. Append-only; a correction is a new record that
supersedes by timestamp, never an overwrite.

**Increment** (`increment()`)
The smallest loadable weight change: **2.5kg** or **5lb**. Every projected
weight is rounded to it, and every adjustment the source workbook writes as a
literal number means *one* of these (ADR-0021).

**Nudge** (`preNudge`, `nudge`)
An adjustment of ±N increments applied to a projected weight. `preNudge` is
applied *before* rounding, `nudge` *after* — and the two genuinely differ. Week
3 uses one form on each of its squat days; that difference is the week's
progression, not an inconsistency.

**Max-reps set** (`MR`, `maxReps`) / **capped max-reps set** (`MR10`,
`maxRepsCapped`)
A set taken to failure, optionally stopping at a cap. These are
**measurements**, not instructions: every feedback rule in the program keys off
one of them, and they are the only points at which the program listens back.

**Feedback rule** (`ConditionalRule`, `ConditionalOutcome`)
A rule the source workbook states in prose and this application makes
computable — "10 reps → 10 sets of 3; 8-9 → 8 sets; 7 → 5 sets; fewer → skip and
cut the max 2.5%". Resolved the moment the triggering set is logged.

**Test set**
Week 5's single set of 1-4 reps at 97.5%. The measurement the next block is
seeded from.

**Projection** / **projected max** (`ProjectedMax`, `proposeNextBlock`)
The next block's seed, derived from a test set by the program's own rep table
(×1.00 / 1.03 / 1.06 / 1.09 for 1 / 2 / 3 / 4 reps). A **proposal**: presented
and accepted, never applied silently.

**Estimated 1RM** (`estimatedOneRepMax`)
An Epley estimate — `weight × (1 + reps/30)` — computed from *any* logged set,
for charting. Deliberately **not** the projection: keeping them apart means
improving a chart can never change a training plan.

**Deload**
Week 6's middle option: take the projection, but repeat Week 1's loads first,
omitting its final upper-body day.

**Season** / **season plan** (`SeasonPlan`, `SeasonWeek`)
A year laid out as blocks placed *around* fixed events. Hand-authored, because
six-week blocks do not tile a year and the gaps are the point.

**Fixture** (`SeasonEvent`)
A non-block week: a cycling FTP test, a timed 5km, a break. A fixture landing
mid-block ends that block early rather than pausing it.

## The platform

**Stack**
A Terraform root module with its own state key, deployed independently. Six of
them, sized by *change cadence* rather than by diagram proximity (ADR-0008).

**Module**
Where `resource` blocks live. Stacks compose modules and own naming; modules
own resources. `grep -rn '^resource' infra/stacks/` must return nothing.

**Cold start**
Standing up an environment from empty, in dependency order, via a
dispatch-only workflow. Needed because a stack cannot *plan* until its upstream
has *applied* (ADR-0022). Unrelated to a Lambda cold start.

**Hot window**
The rolling **13 months** of observations kept in DynamoDB. Thirteen, not
twelve, so a year-on-year comparison never has to reach Athena (ADR-0012).

**Age-out**
The monthly job that moves observations past the hot window into Parquet.
Always **copy → verify → delete**, in that order.

**Shell** (SSM)
A parameter Terraform creates with a placeholder and whose *value* it never
owns — the EntraID client secret. Seeded out of band; `ignore_changes` on the
value stops the next apply reverting it.

**Minted session** / **agent session**
A short-lived `__session` cookie derived from an environment's SSM signing key
at use time, for testing (ADR-0011). Carries `actor=agent`, so it is
distinguishable from a human sign-in everywhere it appears.

**The edge** / **the authenticator**
The Lambda@Edge viewer-request function. The *sole* authenticator — it strips
inbound `x-auth-*` headers, validates the `Host`, answers `/oauth2/*`, and
injects a signed identity the origin verifies (ADR-0009).

**Lens**
The forward-looking rule attached to every ADR. Where a Lens covers a question,
the answer is already made and the question is not open (ADR-0020).

## Terms deliberately not used

| Avoid | Use instead | Why |
|---|---|---|
| "workout" | **session** | The program's own unit, and what the type is called. |
| "1RM" alone | **seed max**, **estimated 1RM**, or **projected max** | Three different things; the bare term hides which. |
| "plan" (training) | **block** or **prescription** | `plan` means a Terraform plan everywhere in this repo. |
| "archive" (verb, for deletion) | **age-out** | Age-out copies and verifies before deleting; "archive" suggests one step. |
| "environment" (for a stack) | **stack** | An environment has six stacks. |
