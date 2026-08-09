/**
 * `@fit/program` — the Candito 6-Week Strength Program as a pure function.
 *
 * One implementation, imported by both the SPA and the API handler (ADR-0019),
 * so the browser's instant re-projection and the server's authoritative
 * prescription can never disagree about a 2.5kg rounding step.
 *
 * Nothing in this package touches the network, the clock, or storage.
 */

export * from "./calendar.js";
export * from "./catalogue.js";
export * from "./completion.js";
export { ACCESSORY_OPTIONS, DEFAULT_ACCESSORIES } from "./defaults.js";
export * from "./exercises.js";
export * from "./identifiers.js";
export * from "./observations.js";
export * from "./program.js";
export * from "./projection.js";
export * from "./types.js";
export * from "./units.js";
