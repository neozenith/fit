import { type CatalogueEntry, type Equipment, type Movement, SEED_CATALOGUE } from "@fit/program";

import { type Identity, userKey } from "./identity.js";
import { type Item, putItem, queryByType } from "./repo.js";

/**
 * The curated exercise catalogue — the app's single source of truth for what a
 * movement is.
 *
 * It used to be three sources: a hardcoded menu per accessory slot, a canonical
 * list transcribed from the Google Form, and whatever the imported archive
 * happened to contain. They disagreed, and the disagreement was visible —
 * Romanian Deadlift is in the archive five times and was still unpickable as a
 * deadlift variation, because that slot's menu was a literal of four strings.
 *
 * Now there is a SEED (in the program package, so a fresh environment is useful
 * before anyone curates anything) and a CURATION layer stored per user. A
 * curated entry overrides the seed by name; an entry that exists only in
 * curation is simply a new movement.
 */

export interface CuratedEntry extends CatalogueEntry {
  /** Absent for a seed entry nobody has touched. */
  curatedAt?: string;
  /** True when a stored override exists — the UI marks these as edited. */
  curated: boolean;
}

const sortKey = (exercise: string): string => `EXERCISE#${exercise.toLowerCase()}`;

export const listCatalogue = async (identity: Identity): Promise<CuratedEntry[]> => {
  const stored = await queryByType<CatalogueEntry & { curatedAt?: string }>(
    "catalogue",
    userKey(identity),
    "EXERCISE",
    { ascending: true, limit: 1000 },
  );

  const overrides = new Map(stored.map((e) => [e.exercise.toLowerCase(), e]));

  const merged = new Map<string, CuratedEntry>();
  for (const entry of SEED_CATALOGUE) {
    merged.set(entry.exercise.toLowerCase(), { ...entry, curated: false });
  }
  for (const [key, entry] of overrides) {
    const { pk: _pk, sk: _sk, ...rest } = entry as CatalogueEntry & Item;
    merged.set(key, { ...(merged.get(key) ?? {}), ...rest, curated: true } as CuratedEntry);
  }

  return [...merged.values()]
    .filter((e) => !e.retired)
    .sort((a, b) => a.exercise.localeCompare(b.exercise));
};

/**
 * Write one curated entry.
 *
 * A whole entry, not a patch. The catalogue is small and the UI edits one row
 * at a time with every field on screen, so a partial update would only add a
 * merge step that could disagree with what the editor was looking at.
 */
export const curateExercise = async (
  identity: Identity,
  // `| undefined` on every optional, not `?`. Under `exactOptionalPropertyTypes`
  // a zod-parsed object carries absent fields as PRESENT-and-undefined, and the
  // two are different types — so a bare `?` rejects exactly the value the parser
  // produces.
  entry: {
    exercise: string;
    equipment: Equipment;
    movement: Movement;
    unilateral?: boolean | undefined;
    isometric?: boolean | undefined;
    bodyweightLoaded?: boolean | undefined;
    retired?: boolean | undefined;
  },
): Promise<CuratedEntry> => {
  const record = {
    ...entry,
    exercise: entry.exercise.trim(),
    curatedAt: new Date().toISOString(),
  };

  await putItem("catalogue", {
    pk: userKey(identity),
    // Lower-cased so "Barbell row" and "Barbell Row" are one entry rather than
    // two that quietly split a movement's history between them.
    sk: sortKey(record.exercise),
    ...record,
  });

  return { ...record, curated: true };
};
