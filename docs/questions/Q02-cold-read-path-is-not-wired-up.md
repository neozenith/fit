# Q02 — The Athena cold-read path exists but is not wired into training queries

**Status:** Open. Assumption taken, non-blocking.
**Raised:** 2026-08-08, while building the API.
**Lenses checked:** ADR-0012 (hot in DynamoDB, cold in Parquet), ADR-0001
(derive rather than store). ADR-0012 states the *storage* rule and the age-out
ordering, but says nothing about how a read spanning the boundary behaves. That
is a genuinely open design question.

## The question

ADR-0012 says the API "reads DynamoDB for the hot window and Athena for anything
older, transparently". Today only half of that is true:

- **Built:** the age-out job writes and registers Parquet partitions; the Glue
  database and the app's Athena workgroup exist; the API has an Athena client
  and uses it for the FinOps page.
- **Not built:** `/api/sets`, `/api/measurements` and `/api/progress` read
  DynamoDB *only*. A query reaching past the hot window silently returns fewer
  results rather than falling through to Parquet.

"Silently" is the problem. The chart would simply start at the hot-window
boundary and look like the athlete began training thirteen months ago.

## Why it is not blocking

Nothing has aged out yet, and nothing can for thirteen months in `test` or
`prod` (one month in `dev`). The gap is invisible until the first age-out runs,
which gives a large and precisely-known window to close it.

## Assumption taken

The API reads the hot window only, and that is **not** disguised: a response
that may be truncated by the boundary should say so rather than looking
complete. That framing is deliberate — an honest partial answer is recoverable,
a silently truncated one is not.

## The design question behind it

Three plausible shapes, and they are meaningfully different:

1. **Transparent union.** Every query hits DynamoDB, and hits Athena too when
   the requested range crosses the cut-off. Simplest to consume, but it puts an
   Athena round trip (seconds, not milliseconds) on a page load, and the
   deduplication story matters because the age-out tolerates duplicates.
2. **Explicit archive endpoint.** `/api/archive/sets` is separate, and the UI
   asks for it only when a user requests history. Keeps every interactive page
   fast; makes "show me everything" a deliberate act.
3. **Precomputed rollups.** The age-out job writes monthly aggregates back into
   DynamoDB as it archives. Charts stay instant forever, at the cost of deciding
   the aggregate shape now — and a chart is exactly the thing whose shape
   changes.

Option 2 fits the existing grain best: it keeps the Athena timeout ceiling off
the interactive path, and it matches how the FinOps page already works.

## What would settle it

Whether "show me my whole training history" is a page the athlete actually wants
or a hypothetical. If it is real, option 2. If nobody ever scrolls past a year,
the hot window alone is the whole answer and this closes as won't-do.
