import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Banner, Loading } from "../components.jsx";
import { Segmented, SelectFilter } from "../filters.jsx";
import { useQueryParam } from "../router.jsx";

/**
 * The exercise catalogue — a root page, not a section of history.
 *
 * A TABLE and nothing else. The charts that were here answered a question this
 * page is not for: "where does my volume go" belongs on the volume page, which
 * has the filters and the time axis to answer it properly. A reference list
 * wants to be scannable and sortable, and two charts above it just pushed the
 * reference below the fold.
 *
 * It is a reference for the whole app rather than a chart about the past: what
 * movements exist, what equipment they need, which are unilateral or isometric.
 * Filing it under `/history` implied it only described the archive.
 *
 * Derived from the log itself rather than transcribed from the workbook's own
 * `Type` column, which evaluates to `#VALUE!` on a third of its rows. A
 * catalogue built from the log cannot list a movement never performed, nor omit
 * one that was.
 */

const SORTS = [
  { value: "volume", label: "Volume" },
  { value: "heaviest", label: "Heaviest" },
  { value: "entries", label: "Frequency" },
  { value: "name", label: "Name" },
];

const KG = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}t` : `${Math.round(v)}kg`);

export const ExercisesPage = () => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.historyExercises>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort] = useQueryParam("sort", "volume");
  const [equipment] = useQueryParam("equipment", "");

  useEffect(() => {
    api
      .historyExercises()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <Banner variant="error">{error}</Banner>;
  if (!data) return <Loading what="the exercise catalogue" />;
  if (!data.available) {
    return (
      <>
        <h1>Exercises</h1>
        <Banner>{data.reason}</Banner>
        <p className="muted">
          The catalogue is derived from imported history. Curate it with{" "}
          <code className="mono">make history</code>, then publish with{" "}
          <code className="mono">make publish-history ENV=&lt;env&gt;</code>.
        </p>
      </>
    );
  }

  const all = data.exercises;
  const equipmentTypes = [...new Set(all.map((e) => e.equipment))].sort();
  const filtered = equipment ? all.filter((e) => e.equipment === equipment) : all;

  const ordered = [...filtered].sort((a, b) => {
    if (sort === "name") return a.exercise.localeCompare(b.exercise);
    if (sort === "heaviest") return b.heaviestKg - a.heaviestKg;
    if (sort === "entries") return b.entries - a.entries;
    return b.totalVolumeKg - a.totalVolumeKg;
  });

  return (
    <>
      <h1>Exercises</h1>
      <p className="muted">
        Every movement ever logged, derived from the log itself — so it cannot list one that was
        never performed, nor omit one that was.
      </p>

      <div className="filters">
        <Segmented label="Sort by" param="sort" fallback="volume" options={SORTS} />
        <SelectFilter
          label="Equipment"
          param="equipment"
          fallback=""
          anyLabel="All equipment"
          options={equipmentTypes.map((t) => ({ value: t, label: t }))}
        />
      </div>

      <section className="card">
        <h2>
          {filtered.length} movements
          <span className="muted"> across {equipmentTypes.length} kinds of equipment</span>
        </h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Exercise</th>
                <th>Equipment</th>
                <th>Entries</th>
                <th>Sets</th>
                <th>Volume</th>
                <th>Heaviest</th>
                <th>Span</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((e) => (
                <tr key={e.exercise}>
                  <td>
                    {e.exercise}
                    {e.isUnilateral && (
                      <span className="pill" title="Recorded per side">
                        per side
                      </span>
                    )}
                    {e.isIsometric && (
                      <span className="pill" title="Reps are seconds held">
                        hold
                      </span>
                    )}
                    {e.isBodyweightLoaded && (
                      <span className="pill" title="Loaded by body weight">
                        bodyweight
                      </span>
                    )}
                  </td>
                  <td>{e.equipment}</td>
                  <td className="mono">{e.entries}</td>
                  <td className="mono">{e.totalSets}</td>
                  <td className="mono">{e.isIsometric ? "—" : KG(e.totalVolumeKg)}</td>
                  <td className="mono">{e.heaviestKg}kg</td>
                  <td className="mono">
                    {e.firstSeen} → {e.lastSeen}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
};
