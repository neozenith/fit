/**
 * `@fit/program` — the training domain as pure functions.
 *
 * One implementation, imported by both the SPA and the API handler (ADR-0019),
 * so the browser's instant re-projection and the server's authoritative
 * prescription can never disagree about a 2.5kg rounding step.
 *
 * The vocabulary, from the atom upward, is in `types.ts`:
 *
 *   Exercise → ExerciseActivity (Prescribed | Logged) → SessionPlan
 *            → Program (parametrised) → Block (instantiated)
 *
 * Nothing in this package touches the network, the clock, or storage.
 */

export * from "./calendar.js";
export * from "./catalogue.js";
export * from "./completion.js";
export * from "./custom.js";
export { ACCESSORY_OPTIONS, DEFAULT_ACCESSORIES } from "./defaults.js";
export * from "./exercises.js";
export * from "./identifiers.js";
export * from "./notes.js";
export * from "./observations.js";
export * from "./plan.js";
export * from "./programs/index.js";
export * from "./projection.js";
export * from "./rollout.js";
export * from "./types.js";
export * from "./units.js";
