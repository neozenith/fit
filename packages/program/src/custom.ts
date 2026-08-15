import { sessionPlan } from "./plan.js";
import type {
  LoadSpec,
  PrescribedExerciseActivity,
  Program,
  ProgramParameterSpec,
  RepSpec,
  ScheduledSession,
  SessionPlan,
} from "./types.js";

/**
 * Hand-authored SessionPlans and the Programs built from them.
 *
 * This is the foundation claim made concrete (ADR-0037): a custom program is
 * compiled into exactly the `Program` interface the three built-ins implement,
 * and it goes through exactly the same rollout. There is no second engine, no
 * "simple mode", and no capability a built-in has that an author cannot reach.
 *
 * The one real difference is where the definition lives — a built-in is a
 * TypeScript literal, a custom one is a row the athlete edited — and that
 * difference stops at this file.
 */

/**
 * A stored SessionPlan.
 *
 * Structurally identical to a plan a built-in emits, because it IS one. The
 * extra fields are provenance, not shape.
 */
export interface StoredSessionPlan extends SessionPlan {
  /** Author-visible description, shown when picking a plan for a schedule slot. */
  description?: string | undefined;
  updatedAt?: string | undefined;
}

/** One slot in a custom program's schedule. */
export interface ScheduleEntry {
  planId: string;
  week: number;
  day: number;
  /** Days from the block start. Authored directly, so an irregular week is expressible. */
  dayOffset: number;
  phase?: string | undefined;
}

/**
 * A stored custom Program.
 *
 * The parameters an author declares are the same `ProgramParameterSpec`s a
 * built-in declares, which is what lets one generic form render both and one
 * validator check both.
 */
export interface CustomProgramDefinition {
  programId: string;
  name: string;
  description: string;
  parameters: ProgramParameterSpec[];
  schedule: ScheduleEntry[];
  updatedAt?: string | undefined;
  /** Hidden from pickers without erasing blocks built from it (ADR-0013). */
  retired?: boolean | undefined;
}

export class UnknownPlanError extends Error {
  constructor(public readonly planId: string) {
    super(
      `The schedule references plan "${planId}", which does not exist. ` +
        `Create the plan, or remove the slot that references it.`,
    );
    this.name = "UnknownPlanError";
  }
}

/**
 * Compile a stored definition plus its plans into a runnable Program.
 *
 * Throws on a dangling plan reference rather than dropping the slot. A schedule
 * that silently loses a day produces a block that looks complete and is missing
 * a session — the failure mode this whole codebase treats as unacceptable.
 */
export const compileCustomProgram = (
  definition: CustomProgramDefinition,
  plans: readonly StoredSessionPlan[],
): Program => {
  const byId = new Map(plans.map((p) => [p.planId, p]));

  // Resolved EAGERLY, at compile time, so a dangling reference fails when the
  // program is loaded rather than when a block is rendered weeks later.
  const resolved: ScheduledSession[] = definition.schedule.map((entry) => {
    const plan = byId.get(entry.planId);
    if (!plan) throw new UnknownPlanError(entry.planId);
    return {
      week: entry.week,
      day: entry.day,
      dayOffset: entry.dayOffset,
      ...(entry.phase === undefined ? {} : { phase: entry.phase }),
      plan,
    };
  });

  return {
    programId: definition.programId,
    name: definition.name,
    description: definition.description,
    origin: "custom",
    parameters: definition.parameters,
    // A custom schedule does not vary with its parameters — the author placed
    // every session by hand. Parameters still drive the LOADS, through the same
    // `reference` specs a built-in uses.
    schedule: () => resolved,
  };
};

/**
 * Build a plan from the shape the editor posts.
 *
 * The editor sends one row per prescribed set, which is the stored model
 * exactly. `sessionPlan` re-derives `setIndex` rather than trusting the client's,
 * so a reordered or partially-deleted list cannot leave a gap in the numbering.
 */
export interface PlanDraftActivity {
  exercise: string;
  reps: RepSpec;
  load: LoadSpec;
  role?: string | undefined;
  note?: string | undefined;
}

export const buildSessionPlan = (
  planId: string,
  name: string,
  activities: readonly PlanDraftActivity[],
  options: { notes?: readonly string[]; description?: string; intensityLabel?: string } = {},
): StoredSessionPlan => {
  const plan = sessionPlan(planId, name, activities, {
    ...(options.notes === undefined ? {} : { notes: options.notes }),
    ...(options.intensityLabel === undefined ? {} : { intensityLabel: options.intensityLabel }),
  });
  return {
    ...plan,
    ...(options.description === undefined ? {} : { description: options.description }),
  };
};

/**
 * Every parameter key a set of plans actually references.
 *
 * Used to warn an author that a plan references `benchMax` while the program
 * declares `bench` — a mismatch that otherwise shows up as a session with no
 * weights on it and no explanation.
 */
export const referencedParameters = (plans: readonly SessionPlan[]): string[] => {
  const refs = new Set<string>();
  for (const plan of plans) {
    for (const activity of plan.activities) {
      if (activity.load.kind === "reference") refs.add(activity.load.ref);
    }
  }
  return [...refs].sort();
};

/** References no declared parameter satisfies. Empty is the healthy answer. */
export const danglingReferences = (
  definition: CustomProgramDefinition,
  plans: readonly SessionPlan[],
): string[] => {
  const declared = new Set(definition.parameters.map((p) => p.key));
  const scheduled = new Set(definition.schedule.map((e) => e.planId));
  return referencedParameters(plans.filter((p) => scheduled.has(p.planId))).filter(
    (ref) => !declared.has(ref),
  );
};

/**
 * Turn a rolled-out session back into a reusable plan.
 *
 * "Save this as a template" — the fastest way for an athlete to start authoring
 * is to take a session a built-in produced and edit it. Resolved weights are
 * DISCARDED in favour of the original load specs, so a plan captured from a
 * Candito week stays a percentage of a max rather than freezing one block's
 * numbers into a template.
 */
export const planFromActivities = (
  planId: string,
  name: string,
  activities: readonly PrescribedExerciseActivity[],
  notes: readonly string[] = [],
): StoredSessionPlan =>
  buildSessionPlan(
    planId,
    name,
    activities.map((a) => ({
      exercise: a.exercise,
      reps: a.reps,
      load: a.load,
      ...(a.role === undefined ? {} : { role: a.role }),
      ...(a.note === undefined ? {} : { note: a.note }),
    })),
    { notes },
  );
