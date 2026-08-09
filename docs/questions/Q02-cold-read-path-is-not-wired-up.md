# Q02 — The cold-read path exists but is not wired into training queries

**Status:** CLOSED, 2026-08-09. Settled by
[ADR-0026](../../ADRs.md) — option 2, an explicit archive surface.

**Raised:** 2026-08-08, while building the API.

## What settled it

The question ended on a test: *"whether 'show me my whole training history' is a
page the athlete actually wants or a hypothetical."*

It was real. A second workbook arrived carrying five years of training that
predate this app, and the answer became a concrete requirement rather than a
design preference.

## The resolution

Option 2 — an **explicit archive surface** — as predicted, for the reason
predicted: it keeps the archive off the interactive path.

- `/api/history/*` serves the imported archive, read-only, queried with DuckDB
  over Parquet in the environment's archive bucket (ADR-0025, ADR-0026).
- `/api/sets`, `/api/measurements` and `/api/progress` still read DynamoDB only,
  and now that is a *stated* boundary rather than a silent one.

Two premises of the original question have since changed and are recorded here
so the reasoning is not re-run against a world that no longer exists:

- **There is no Athena, and no round-trip ceiling.** ADR-0025 replaced it with
  DuckDB inside the Lambda, so the "seconds, not milliseconds" cost that pushed
  against option 1 is much smaller than it was. It is still not zero, and the
  separation is still the right shape — but on latency alone the argument is
  weaker now than when it was written.
- **Option 3 (precomputed rollups) is dead, not deferred.** With no catalogue
  and a full scan costing less than the bookkeeping to avoid it, precomputing
  aggregates would only fix the shape of a chart before knowing what the chart
  should show.

## What remains open

Nothing blocking. The one genuine gap: the age-out job's own Parquet output
(`tables/…`) is written but nothing reads it yet, because no environment has
data old enough to have aged out. When one does, the pattern is already built —
it is the same `read_parquet` glob the history routes use.
