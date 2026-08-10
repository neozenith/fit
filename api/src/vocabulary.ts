import { SEED_EQUIPMENT, SEED_MOVEMENTS, SLOT_REQUIRED_MOVEMENTS } from "@fit/program";

import { type Identity, userKey } from "./identity.js";
import { type Item, putItem, queryByType } from "./repo.js";

/**
 * The two vocabularies the catalogue classifies on, as stored data.
 *
 * They were closed unions in the program package, so adding a kind of equipment
 * meant a code change and a deploy. The cost was not hypothetical: there was no
 * "Band", so every banded movement was filed as `Machine` — the enum did not
 * merely omit a value, it forced a wrong one.
 *
 * Same shape as the catalogue itself (ADR-0034): a SEED that ships, plus a
 * stored layer that overrides it by key. An entry that exists only in storage
 * is simply a new word.
 *
 * NOTHING IS EVER DELETED. Storage is append-only (ADR-0013) and a vocabulary
 * word is referenced by every catalogue entry that used it, so removal is a
 * `retired` flag — the word stops being offered and the history that used it
 * still reads correctly.
 */

export interface VocabularyEntry {
  key: string;
  label: string;
  retired?: boolean | undefined;
  /** True when a stored record exists, so the UI can mark it as edited. */
  curated: boolean;
  /**
   * A prescribed accessory slot asks for this movement, so retiring it would
   * leave that slot's picker empty with nothing on screen to say why.
   * Always false for equipment — no slot is defined in terms of equipment.
   */
  inUseBySlot: boolean;
}

type StoredWord = { key: string; label: string; retired?: boolean } & Item;

const AXES = {
  equipment: {
    prefix: "EQUIPMENT",
    // Equipment has no separate key: the word IS the identifier, which is what
    // every existing catalogue entry stores.
    seed: SEED_EQUIPMENT.map((label) => ({ key: label, label })),
    protected: [] as readonly string[],
  },
  movement: {
    prefix: "MOVEMENT",
    // Movements are slugs with a separate label precisely so a slot can
    // reference one and a relabel cannot break it.
    seed: SEED_MOVEMENTS.map((m) => ({ key: m.key, label: m.label })),
    protected: SLOT_REQUIRED_MOVEMENTS,
  },
} as const;

export type Axis = keyof typeof AXES;

export const isAxis = (value: string): value is Axis => value in AXES;

export const listVocabulary = async (
  identity: Identity,
  axis: Axis,
): Promise<VocabularyEntry[]> => {
  const { prefix, seed, protected: locked } = AXES[axis];
  const stored = await queryByType<StoredWord>("catalogue", userKey(identity), prefix, {
    ascending: true,
    limit: 500,
  });

  const merged = new Map<string, Omit<VocabularyEntry, "inUseBySlot">>();
  for (const word of seed) merged.set(word.key, { ...word, curated: false });
  for (const word of stored) {
    const { pk: _pk, sk: _sk, ...rest } = word;
    merged.set(rest.key, { ...(merged.get(rest.key) ?? rest), ...rest, curated: true });
  }

  return [...merged.values()]
    .map((word) => ({ ...word, inUseBySlot: locked.includes(word.key) }))
    .sort((a, b) => a.label.localeCompare(b.label));
};

/** Both vocabularies in one response — the catalogue UI always needs both. */
export const listVocabularies = async (
  identity: Identity,
): Promise<Record<Axis, VocabularyEntry[]>> => ({
  equipment: await listVocabulary(identity, "equipment"),
  movement: await listVocabulary(identity, "movement"),
});

export class ProtectedWordError extends Error {}

/**
 * Add a word, relabel one, or retire one.
 *
 * The key is immutable by construction — it is what catalogue entries and
 * `SLOT_MOVEMENT` reference. Relabelling is therefore always safe, and retiring
 * a movement a slot depends on is always refused: an accessory picker with an
 * empty list looks like a filter, not like a misconfiguration, so this is the
 * one place it can be caught while the cause is still obvious.
 */
export const putVocabulary = async (
  identity: Identity,
  axis: Axis,
  word: { key: string; label: string; retired?: boolean | undefined },
): Promise<VocabularyEntry> => {
  const { prefix, protected: locked } = AXES[axis];
  const key = word.key.trim();
  if (!key) throw new ProtectedWordError("A vocabulary word needs a key.");

  if (word.retired && locked.includes(key)) {
    throw new ProtectedWordError(
      `"${key}" is required by a prescribed accessory slot, so it cannot be retired. ` +
        `Retiring it would leave that slot with nothing to offer.`,
    );
  }

  const record = { key, label: word.label.trim() || key, retired: word.retired };
  await putItem("catalogue", {
    pk: userKey(identity),
    sk: `${prefix}#${key.toLowerCase()}`,
    ...record,
  });

  return { ...record, curated: true, inUseBySlot: locked.includes(key) };
};
