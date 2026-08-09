import { EQUIPMENT, MOVEMENT_LABEL, MOVEMENTS, type Movement } from "@fit/program";
import { useCallback, useEffect, useState } from "react";
import { api, type CuratedExercise } from "../api.js";
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
 * Editing here changes what the pickers offer, immediately. That is the point.
 */

const SORTS = [
  { value: "name", label: "Name" },
  { value: "equipment", label: "Equipment" },
  { value: "movement", label: "Movement" },
];

export const ExercisesPage = () => {
  const [rows, setRows] = useState<CuratedExercise[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [sort] = useQueryParam("sort", "name");
  const [equipment] = useQueryParam("equipment", "");
  const [movement] = useQueryParam("movement", "");

  const load = useCallback(() => api.catalogue().then((r) => setRows(r.exercises)), []);

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

  if (error && !rows) return <Banner variant="error">{error}</Banner>;
  if (!rows) return <Loading what="the exercise catalogue" />;

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

  return (
    <>
      <h1>Exercises</h1>
      <p className="muted">
        The single source of truth for what a movement is. Accessory pickers read this, so a change
        here immediately changes what can be prescribed.
      </p>
      {error && <Banner variant="error">{error}</Banner>}

      <div className="filters">
        <Segmented label="Sort by" param="sort" fallback="name" options={SORTS} />
        <SelectFilter
          label="Equipment"
          param="equipment"
          fallback=""
          anyLabel="All equipment"
          options={EQUIPMENT.map((value) => ({ value, label: value }))}
        />
        <SelectFilter
          label="Movement"
          param="movement"
          fallback=""
          anyLabel="All movements"
          options={MOVEMENTS.map((value) => ({ value, label: MOVEMENT_LABEL[value] }))}
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
                      {EQUIPMENT.map((value) => (
                        <option key={value} value={value}>
                          {value}
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
                      {MOVEMENTS.map((value) => (
                        <option key={value} value={value}>
                          {MOVEMENT_LABEL[value as Movement]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="traits">
                    {(
                      [
                        ["unilateral", "per side"],
                        ["isometric", "hold"],
                        ["bodyweightLoaded", "bodyweight"],
                      ] as const
                    ).map(([field, label]) => (
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
