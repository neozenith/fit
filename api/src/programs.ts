import {
  BUILTIN_PROGRAMS,
  type CustomProgramDefinition,
  compileCustomProgram,
  danglingReferences,
  findBuiltinProgram,
  type Program,
  type StoredSessionPlan,
} from "@fit/program";

import { type Identity, userKey } from "./identity.js";
import { type Item, putItem, queryByType } from "./repo.js";

/**
 * Program resolution: built-in first, then the athlete's own.
 *
 * The two are the SAME interface by the time anything downstream sees them
 * (ADR-0037). A built-in is a TypeScript literal and a custom one is a row that
 * was edited, and that difference stops here — the router, the rollout and the
 * SPA all receive a `Program` and cannot tell which kind they were handed except
 * by reading `origin`, which exists so the UI can label it, not so the engine
 * can branch on it.
 *
 * Storage layout, in the `programs` table:
 *
 *   PLAN#{planId}         one hand-authored SessionPlan
 *   PROGDEF#{programId}   one custom Program definition
 *
 * `PROGDEF#` rather than `PROGRAM#` for the same reason block state is `BSTATE#`
 * and not `BLOCKSTATE#`: plans are queried with `begins_with(sk, "PLAN#")`, and
 * a future `PLANSET#` prefix would be swept into that query. Prefixes that are
 * one another's prefixes are a trap this codebase has already fallen into once.
 */

const PLAN = "PLAN";
const PROGRAM_DEF = "PROGDEF";

const strip = <T>(item: T & Item): T => {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest as T;
};

// --- Session plans -----------------------------------------------------------

export const listPlans = async (identity: Identity): Promise<StoredSessionPlan[]> => {
  const stored = await queryByType<StoredSessionPlan>("programs", userKey(identity), PLAN, {
    ascending: true,
    limit: 500,
  });
  return stored.map(strip).sort((a, b) => a.name.localeCompare(b.name));
};

export const putPlan = async (
  identity: Identity,
  plan: StoredSessionPlan,
): Promise<StoredSessionPlan> => {
  const record: StoredSessionPlan = { ...plan, updatedAt: new Date().toISOString() };
  await putItem("programs", {
    pk: userKey(identity),
    sk: `${PLAN}#${plan.planId}`,
    ...record,
  });
  return record;
};

// --- Custom program definitions ---------------------------------------------

export const listProgramDefinitions = async (
  identity: Identity,
): Promise<CustomProgramDefinition[]> => {
  const stored = await queryByType<CustomProgramDefinition>(
    "programs",
    userKey(identity),
    PROGRAM_DEF,
    { ascending: true, limit: 200 },
  );
  return stored.map(strip);
};

export const putProgramDefinition = async (
  identity: Identity,
  definition: CustomProgramDefinition,
): Promise<CustomProgramDefinition> => {
  const record: CustomProgramDefinition = {
    ...definition,
    updatedAt: new Date().toISOString(),
  };
  await putItem("programs", {
    pk: userKey(identity),
    sk: `${PROGRAM_DEF}#${definition.programId}`,
    ...record,
  });
  return record;
};

// --- Resolution --------------------------------------------------------------

/**
 * Every program available to this athlete, built-ins first.
 *
 * A custom definition whose plans do not compile is DROPPED from the list and
 * reported, rather than throwing the whole listing. One broken definition must
 * not make the picker unusable — but it must also not appear as though it were
 * fine, which is why the caller gets the errors alongside the programs.
 */
export interface ProgramCatalogue {
  programs: Program[];
  /** Custom definitions that failed to compile, with the reason. */
  broken: Array<{ programId: string; name: string; reason: string }>;
}

export const listPrograms = async (identity: Identity): Promise<ProgramCatalogue> => {
  const [definitions, plans] = await Promise.all([
    listProgramDefinitions(identity),
    listPlans(identity),
  ]);

  const programs: Program[] = [...BUILTIN_PROGRAMS];
  const broken: ProgramCatalogue["broken"] = [];

  for (const definition of definitions) {
    if (definition.retired) continue;
    try {
      programs.push(compileCustomProgram(definition, plans));
    } catch (error) {
      broken.push({
        programId: definition.programId,
        name: definition.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { programs, broken };
};

/**
 * Resolve one program by id.
 *
 * Built-ins are checked FIRST and without touching storage, so the common case —
 * rendering a Candito block — costs no query. A custom program is only looked up
 * when the id is not a built-in one.
 */
export const resolveProgram = async (
  identity: Identity,
  programId: string,
): Promise<Program | null> => {
  const builtin = findBuiltinProgram(programId);
  if (builtin) return builtin;

  const [definitions, plans] = await Promise.all([
    listProgramDefinitions(identity),
    listPlans(identity),
  ]);
  const definition = definitions.find((d) => d.programId === programId);
  if (!definition) return null;

  return compileCustomProgram(definition, plans);
};

/**
 * Warn about references a definition's plans make to parameters it never declared.
 *
 * Returned with the definition rather than rejected: an author mid-edit will
 * routinely have a dangling reference, and a 400 there would make the editor
 * impossible to use. It shows up as a warning next to the control instead, which
 * is the difference between a session that renders blank for no visible reason
 * and one that says why.
 */
export const definitionWarnings = async (
  identity: Identity,
  definition: CustomProgramDefinition,
): Promise<string[]> => {
  const plans = await listPlans(identity);
  return danglingReferences(definition, plans);
};
