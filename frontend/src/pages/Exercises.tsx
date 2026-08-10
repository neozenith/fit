import { SLOT_MOVEMENT } from "@fit/program";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  type CuratedExercise,
  type Vocabularies,
  type VocabularyAxis,
  type VocabularyWord,
} from "../api.js";
import { Banner, Loading } from "../components.jsx";
import { Segmented, SelectFilter } from "../filters.jsx";
import { useQueryParam } from "../router.jsx";

/**
 * The exercise catalogue — the app's single source of truth, and where it is
 * curated.
 *
 * It used to be three sources that disagreed: a hardcoded menu per accessory
 * slot, a canonical list transcribed from the Google Form, and whatever the
 * imported archive happened to contain. The disagreement was visible — Romanian
 * Deadlift appears in the archive five times and still could not be picked as a
 * deadlift variation, because that slot's menu was a literal of four strings.
 *
 * Two axes, because two different questions get asked. EQUIPMENT answers "what
 * do I need" and is how history is filtered. MOVEMENT answers "what does this
 * train" and is how a prescribed accessory slot is filled: the program asks for
 * a horizontal pull, and which one is the athlete's choice.
 *
 * BOTH AXES ARE NOW DATA, fetched here rather than imported from the program
 * package. They were closed enums, and the cost of that showed: there was no
 * "Band", so every banded movement was filed as `Machine`. A vocabulary that
 * cannot grow does not omit the missing word, it forces a wrong one.
 *
 * Editing here changes what the pickers offer, immediately. That is the point.
 */

const SORTS = [
  { value: "name", label: "Name" },
  { value: "equipment", label: "Equipment" },
  { value: "movement", label: "Movement" },
];

const TRAITS = [
  ["unilateral", "per side"],
  ["isometric", "hold"],
  ["bodyweightLoaded", "bodyweight"],
] as const;

const BLANK = { exercise: "", equipment: "", movement: "" };

/** Live words only. A retired word stays readable in history but unofferable. */
const live = (words: VocabularyWord[]) => words.filter((w) => !w.retired);

export const ExercisesPage = () => {
  const [rows, setRows] = useState<CuratedExercise[] | null>(null);
  const [vocab, setVocab] = useState<Vocabularies | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [draft, setDraft] = useState(BLANK);
  const [sort] = useQueryParam("sort", "name");
  const [equipment] = useQueryParam("equipment", "");
  const [movement] = useQueryParam("movement", "");

  const load = useCallback(
    () =>
      Promise.all([api.catalogue(), api.vocabulary()]).then(([c, v]) => {
        setRows(c.exercises);
        setVocab(v);
      }),
    [],
  );

  useEffect(() => {
    load().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  const save = async (entry: CuratedExercise, patch: Partial<CuratedExercise>) => {
    setSaving(entry.exercise);
    setError(null);
    // Optimistic, because the edit is a `<select>` change and waiting for a
    // round trip before the control reflects it feels broken. A failure below
    // reloads from the server, so nothing stays wrong.
    setRows((was) =>
      (was ?? []).map((r) =>
        r.exercise === entry.exercise ? { ...r, ...patch, curated: true } : r,
      ),
    );
    try {
      await api.curateExercise({ ...entry, ...patch });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      await load().catch(() => undefined);
    } finally {
      setSaving(null);
    }
  };

  const addExercise = async () => {
    const name = draft.exercise.trim();
    if (!name || !draft.equipment || !draft.movement) {
      setError("A new exercise needs a name, an equipment and a movement.");
      return;
    }
    if (rows?.some((r) => r.exercise.toLowerCase() === name.toLowerCase())) {
      // Names are matched case-insensitively server-side, so adding "Barbell
      // row" next to "Barbell Row" would silently overwrite rather than add —
      // and split that movement's history in two if it did not.
      setError(`"${name}" is already in the catalogue.`);
      return;
    }
    setSaving(name);
    setError(null);
    try {
      await api.curateExercise({ ...draft, exercise: name });
      setDraft(BLANK);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  if (error && !rows) return <Banner variant="error">{error}</Banner>;
  if (!rows || !vocab) return <Loading what="the exercise catalogue" />;

  const equipmentWords = live(vocab.equipment);
  const movementWords = live(vocab.movement);
  const labelFor = (key: string) => vocab.movement.find((m) => m.key === key)?.label ?? key;

  const filtered = rows.filter(
    (r) => (!equipment || r.equipment === equipment) && (!movement || r.movement === movement),
  );

  const ordered = [...filtered].sort((a, b) => {
    if (sort === "equipment") {
      return a.equipment.localeCompare(b.equipment) || a.exercise.localeCompare(b.exercise);
    }
    if (sort === "movement") {
      return a.movement.localeCompare(b.movement) || a.exercise.localeCompare(b.exercise);
    }
    return a.exercise.localeCompare(b.exercise);
  });

  const curatedCount = rows.filter((r) => r.curated).length;

  /**
   * A slot that nothing can fill.
   *
   * Checked and shown, because the failure is otherwise invisible: the picker
   * for that slot renders an empty list, which looks exactly like a filter that
   * matched nothing rather than like a movement with no exercises classified
   * under it.
   */
  const starvedSlots = Object.entries(SLOT_MOVEMENT)
    .filter(([, m]) => m !== null && !rows.some((r) => r.movement === m && !r.retired))
    .map(([slot, m]) => `${slot} (needs ${labelFor(m as string)})`);

  return (
    <>
      <h1>Exercises</h1>
      <p className="muted">
        The single source of truth for what a movement is. Accessory pickers read this, so a change
        here immediately changes what can be prescribed.
      </p>
      {error && <Banner variant="error">{error}</Banner>}
      {starvedSlots.length > 0 && (
        <Banner variant="error">
          No exercise is classified for {starvedSlots.join(", ")}. That slot's picker will be empty
          until something is.
        </Banner>
      )}

      <section className="card">
        <h2>Add an exercise</h2>
        <p className="muted">
          Anything you add is immediately pickable wherever its movement is asked for.
        </p>
        <div className="add-exercise">
          <label>
            <span className="field__label">Name</span>
            <input
              value={draft.exercise}
              onChange={(e) => setDraft({ ...draft, exercise: e.target.value })}
              placeholder="Banded Face Pull"
            />
          </label>
          <label>
            <span className="field__label">Equipment</span>
            <select
              value={draft.equipment}
              onChange={(e) => setDraft({ ...draft, equipment: e.target.value })}
            >
              <option value="">Choose…</option>
              {equipmentWords.map((w) => (
                <option key={w.key} value={w.key}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field__label">Movement</span>
            <select
              value={draft.movement}
              onChange={(e) => setDraft({ ...draft, movement: e.target.value })}
            >
              <option value="">Choose…</option>
              {movementWords.map((w) => (
                <option key={w.key} value={w.key}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={addExercise} disabled={saving !== null}>
            Add
          </button>
        </div>
      </section>

      <VocabularyEditor vocab={vocab} onChanged={load} onError={setError} />

      <div className="filters">
        <Segmented label="Sort by" param="sort" fallback="name" options={SORTS} />
        <SelectFilter
          label="Equipment"
          param="equipment"
          fallback=""
          anyLabel="All equipment"
          options={equipmentWords.map((w) => ({ value: w.key, label: w.label }))}
        />
        <SelectFilter
          label="Movement"
          param="movement"
          fallback=""
          anyLabel="All movements"
          options={movementWords.map((w) => ({ value: w.key, label: w.label }))}
        />
      </div>

      <section className="card">
        <h2>
          {ordered.length} movements
          <span className="muted"> · {curatedCount} curated, the rest as shipped</span>
        </h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Exercise</th>
                <th>Equipment</th>
                <th>Movement</th>
                <th>Traits</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((row) => (
                <tr key={row.exercise} className={saving === row.exercise ? "row--saving" : ""}>
                  <td>
                    {row.exercise}
                    {row.curated && (
                      <span className="pill" title="Edited here rather than shipped">
                        curated
                      </span>
                    )}
                  </td>
                  <td>
                    <select
                      aria-label={`${row.exercise} equipment`}
                      value={row.equipment}
                      onChange={(e) => save(row, { equipment: e.target.value })}
                    >
                      {/* The row's own value, even if the word has since been
                          retired — otherwise the select silently reads as the
                          first option and one save rewrites it. */}
                      {live(vocab.equipment.filter((w) => !w.retired || w.key === row.equipment))
                        .concat(vocab.equipment.filter((w) => w.retired && w.key === row.equipment))
                        .map((w) => (
                          <option key={w.key} value={w.key}>
                            {w.label}
                            {w.retired ? " (retired)" : ""}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`${row.exercise} movement`}
                      value={row.movement}
                      onChange={(e) => save(row, { movement: e.target.value })}
                    >
                      {vocab.movement
                        .filter((w) => !w.retired || w.key === row.movement)
                        .map((w) => (
                          <option key={w.key} value={w.key}>
                            {w.label}
                            {w.retired ? " (retired)" : ""}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td className="traits">
                    {TRAITS.map(([field, label]) => (
                      <label key={field}>
                        <input
                          type="checkbox"
                          checked={Boolean(row[field])}
                          onChange={(e) => save(row, { [field]: e.target.checked })}
                        />
                        {label}
                      </label>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ordered.length === 0 && <p className="muted">Nothing matches these filters.</p>}
      </section>
    </>
  );
};

/**
 * Curate the two vocabularies themselves.
 *
 * Collapsed, because this is the rarer job: you add an exercise often and a
 * kind of equipment almost never. It has to exist, though — the alternative is
 * the state this replaced, where "Band" could only be added by a deploy.
 */
const VocabularyEditor = ({
  vocab,
  onChanged,
  onError,
}: {
  vocab: Vocabularies;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) => {
  const [adding, setAdding] = useState<Record<VocabularyAxis, string>>({
    equipment: "",
    movement: "",
  });

  const put = async (axis: VocabularyAxis, word: VocabularyWord) => {
    try {
      await api.putVocabulary(axis, word);
      await onChanged();
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const add = async (axis: VocabularyAxis) => {
    const label = adding[axis].trim();
    if (!label) return;
    // Equipment's key IS its word, because that is what every existing
    // catalogue entry stores. A movement gets a slug, so its label can be
    // rewritten later without orphaning the slot that references it.
    const key = axis === "equipment" ? label : label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (vocab[axis].some((w) => w.key === key)) {
      onError(`"${label}" is already there.`);
      return;
    }
    setAdding({ ...adding, [axis]: "" });
    await put(axis, { key, label });
  };

  return (
    <details className="card vocabulary">
      <summary>
        <h2>Equipment and movement lists</h2>
      </summary>
      <p className="muted">
        Retiring a word hides it from the pickers without touching the history that used it —
        storage is append-only, so nothing is ever deleted.
      </p>
      <div className="grid">
        {(["equipment", "movement"] as const).map((axis) => (
          <div key={axis}>
            <h3>{axis === "equipment" ? "Equipment" : "Movement"}</h3>
            <ul className="vocabulary__list">
              {vocab[axis].map((word) => (
                <li key={word.key} className={word.retired ? "is-retired" : ""}>
                  <span>{word.label}</span>
                  {word.inUseBySlot && (
                    <span className="pill" title="A prescribed accessory slot asks for this">
                      in use
                    </span>
                  )}
                  <div className="spacer" />
                  <button
                    type="button"
                    // A movement a slot depends on has no retire control at
                    // all, rather than one that fails: the API refuses it, and
                    // offering a button whose only outcome is an error is worse
                    // than not offering it.
                    disabled={word.inUseBySlot && !word.retired}
                    onClick={() => put(axis, { ...word, retired: !word.retired })}
                  >
                    {word.retired ? "Restore" : "Retire"}
                  </button>
                </li>
              ))}
            </ul>
            <div className="add-word">
              <input
                aria-label={`New ${axis}`}
                value={adding[axis]}
                onChange={(e) => setAdding({ ...adding, [axis]: e.target.value })}
                placeholder={axis === "equipment" ? "Sled" : "Rotation"}
              />
              <button type="button" onClick={() => add(axis)}>
                Add
              </button>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
};
