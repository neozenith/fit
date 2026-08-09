# Q03 — Three surfaces have an API but no UI

**Status:** Open. Assumption taken, non-blocking.
**Raised:** 2026-08-08, on completing the first version of the SPA.
**Lenses checked:** ADR-0018 (single-user by construction), ADR-0013
(observations are append-only), ADR-0001 (derive, never store). None of them
speaks to *which* surfaces get a UI in a first version — that is scope, not
architecture.

## The question

Three capabilities are fully modelled, validated and reachable over HTTP, but
have no page:

| Capability | Endpoint | Why it was left out |
|---|---|---|
| **Accepting a Week 6 projection** | `POST /api/blocks/project` | The recursion works, and the Block page explains it in prose, but there is no button that takes the proposal and creates the next block from it. |
| **Editing the season plan** | `GET`/`PUT /api/season` | Blocks placed around fixed events (an FTP test, a timed 5km, a break). Modelled and seeded; not editable in the browser. |
| **Logging cardio** | table exists, no route | Rowing, running and riding are in the source workbook and in the data model, but the log page covers strength only. |

## Why they were left out

Each is a genuine feature rather than a missing edge case, and the first version
is deliberately the spine: *see the prescription, log against it, watch it move.*
Adding three more pages before that spine has been used once would be building
on a guess about how it feels to use.

The Week 6 acceptance is the most defensible omission and the most consequential
one, so it is worth naming precisely: **the projection is a proposal, and
accepting it is currently a manual act** — read the projected maxes off the
Block page and type them into a new block. That is exactly what the spreadsheet
required, so nothing regressed; it is just not yet better.

## Assumption taken

Ship the spine. The three surfaces stay API-complete so adding a page is a
frontend change with no backend work and no migration.

## What would settle it

Using the app through one real block. The Week 6 acceptance becomes obviously
worth building the first time a block ends; the season editor becomes worth
building the first time a fixture moves; cardio logging becomes worth building
the first time a row is worth recording next to a squat. In each case the
trigger is an event that has not happened yet, which is precisely why the
question is queued rather than answered.

---

## Update, 2026-08-09

Cardio logging now has a **read** surface: the History page charts weekly
distance, moving time, elevation and watts-per-kilogram from the imported
Strava export (ADR-0026). That is not the same as the *write* surface this
question asks about — nothing in the app records a ride — but it does change
what "no UI" means for cardio, and the charts are the thing an athlete would
have wanted the write surface for.

Week 6 acceptance and season editing are unchanged: still API-only.
