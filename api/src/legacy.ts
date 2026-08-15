import { type BlockConfig, DEFAULT_PROGRAM_ID, type ProgramParameters } from "@fit/program";

import type { Item } from "./repo.js";

/**
 * Reading blocks written before the domain rebuild (ADR-0038).
 *
 * Storage is append-only and nothing is ever rewritten (ADR-0013), which is a
 * property this rebuild has to honour rather than an obstacle to route around.
 * Every block written before the rebuild carries:
 *
 *   { blockId, startDate, units, oneRepMax: {...}, accessories: {...} }
 *
 * and every block written after it carries:
 *
 *   { blockId, programId, startDate, units, parameters: {...} }
 *
 * There is no migration job, no backfill, and no dual-write. The old shape is
 * adapted ON READ into the new one, here, in one function. That is the only way
 * an append-only store can change shape without either rewriting history — which
 * the API role has no permission to do — or stranding it.
 *
 * The adaptation is total and lossless: `oneRepMax` and `accessories` are
 * exactly the parameter set the Candito program declares, because the program's
 * parameters were derived FROM them. A pre-rebuild block therefore rolls out to
 * byte-identical sessions, which the golden tests assert.
 */

interface LegacyBlockShape {
  blockId: string;
  startDate: string;
  units: "kg" | "lb";
  oneRepMax?: Record<string, number>;
  accessories?: Record<string, string>;
  parameters?: ProgramParameters | undefined;
  programId?: string | undefined;
  // `| undefined` rather than a bare `?`: under `exactOptionalPropertyTypes` an
  // absent key and a present-undefined one are different types, and a
  // `BlockConfig` fed back through here carries the latter.
  derivedFrom?: string | undefined;
}

/** True when this item predates the rebuild and needs adapting. */
export const isLegacyBlock = (item: object): boolean =>
  !("programId" in item) || !("parameters" in item);

/**
 * Adapt any stored block item to a current `BlockConfig`.
 *
 * Idempotent: a current block passes through untouched, so the caller never has
 * to ask which shape it is holding.
 */
export const adaptBlock = (item: LegacyBlockShape): BlockConfig => {
  // The DynamoDB key attributes are stripped here rather than by the caller,
  // because every caller would otherwise have to remember to — and one that
  // forgets writes `pk` back into a config that gets re-serialised to the client.
  const { pk: _pk, sk: _sk, ...rest } = item as LegacyBlockShape & Partial<Item>;

  if (rest.programId && rest.parameters) {
    return {
      blockId: rest.blockId,
      programId: rest.programId,
      startDate: rest.startDate,
      units: rest.units,
      parameters: rest.parameters,
      ...(rest.derivedFrom ? { derivedFrom: rest.derivedFrom } : {}),
    };
  }

  // The flattening is the whole adaptation: the old shape nested maxes under
  // `oneRepMax` and slot choices under `accessories`, and the program declares
  // both as flat keys. Nothing is dropped and nothing is invented.
  const parameters: ProgramParameters = {
    ...(rest.parameters ?? {}),
    ...(rest.oneRepMax ?? {}),
    ...(rest.accessories ?? {}),
    units: rest.units,
  };

  return {
    blockId: rest.blockId,
    // Every pre-rebuild block IS a Candito block — it is the only program that
    // existed. Defaulting here rather than at the write path means new blocks
    // must still name their program explicitly.
    programId: rest.programId ?? DEFAULT_PROGRAM_ID,
    startDate: rest.startDate,
    units: rest.units,
    parameters,
    ...(rest.derivedFrom ? { derivedFrom: rest.derivedFrom } : {}),
  };
};

/**
 * Normalise a logged-activity request body across the rebuild.
 *
 * A deployed SPA is not upgraded atomically with the API: a browser tab open
 * across the release still posts `{sets: [...]}` where the current client posts
 * `{activities: [...]}`. Accepting both costs one line and saves a session's
 * work; rejecting the old shape would lose it for the sake of a field name.
 */
export const activitiesFromBody = (body: unknown): unknown => {
  if (typeof body !== "object" || body === null) return body;
  const record = body as Record<string, unknown>;
  if (Array.isArray(record["activities"])) return body;
  if (Array.isArray(record["sets"])) return { activities: record["sets"] };
  return body;
};
