import { groupByExercise } from "./plan.js";
import type { Session } from "./types.js";

/**
 * How much of a session is done.
 *
 * One implementation, because three had already drifted: the overview, the log
 * page and the header bars each decided "complete" for themselves, and the
 * overview's version counted only exercises with PRESCRIBED sets. That made
 * W1D1 report `0/2` while the session below it listed four exercises — the two
 * free-choice accessories the program deliberately leaves unprescribed were
 * silently excluded from the denominator.
 *
 * Every exercise counts. An unprescribed one needs a single logged activity to
 * be done, because "do some rows" has no set count to satisfy; a prescribed one
 * needs all of its sets. Skipping an optional accessory therefore reads as
 * `3/4` — accurate, and better than a denominator that quietly disagrees with
 * what is on screen.
 *
 * Completion is a FOLD over logged activities, never a stored status (ADR-0001).
 * A status field can disagree with the log; a fold cannot.
 */

/** Logged activities per exercise name, for one session. */
export type SessionLog = Record<string, unknown[]>;

/** Activities required before an exercise counts as done. Unprescribed means one. */
export const requiredSets = (prescribed: number): number => Math.max(1, prescribed);

export interface SessionCompletion {
  /** Exercises finished. */
  done: number;
  /** Exercises in the session — ALL of them, prescribed or not. */
  total: number;
  /** Activities logged, capped per exercise at what that exercise required. */
  setsDone: number;
  /** Activities required across the session. */
  setsTotal: number;
  /** At least one activity logged against at least one exercise. */
  started: boolean;
}

export const sessionCompletion = (session: Session, log: SessionLog = {}): SessionCompletion => {
  // Grouped, because "done" is a question about EXERCISES and the session holds
  // a flat list of one activity per set.
  const groups = groupByExercise(session.activities);

  let done = 0;
  let setsDone = 0;
  let setsTotal = 0;
  let started = false;

  for (const group of groups) {
    const prescribed = group.activities.filter((a) => a.reps.kind !== "unprescribed").length;
    const need = requiredSets(prescribed);
    const got = log[group.exercise]?.length ?? 0;
    if (got > 0) started = true;
    if (got >= need) done += 1;
    setsDone += Math.min(got, need);
    setsTotal += need;
  }

  return { done, total: groups.length, setsDone, setsTotal, started };
};

export type SessionState = "done" | "partial" | "todo" | "future";

export const sessionState = (session: Session, log: SessionLog, today: string): SessionState => {
  const { done, total, started } = sessionCompletion(session, log);
  if (total > 0 && done >= total) return "done";
  if (started) return "partial";
  return session.date > today ? "future" : "todo";
};
