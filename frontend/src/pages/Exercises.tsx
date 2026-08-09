import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Banner, Loading } from "../components.jsx";
import { Segmented, SelectFilter } from "../filters.jsx";
import { Plot, seriesColour } from "../plot.jsx";
import { useQueryParam } from "../router.jsx";

/**
 * The exercise catalogue — a root page, not a section of history.
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

  // Isometric holds carry no volume by design — `sets × seconds × kg` is not a
  // load — so they are excluded from the volume chart rather than drawn at zero,
  // which would read as "never trained".
  const charted = ordered.filter((e) => !e.isIsometric).slice(0, 25);

  const byEquipment = new Map<string, number>();
  for (const e of filtered) {
    byEquipment.set(e.equipment, (byEquipment.get(e.equipment) ?? 0) + e.totalVolumeKg);
  }

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
        <Plot
          title="Lifetime volume by exercise"
          height={Math.max(320, charted.length * 24)}
          data={[
            {
              type: "bar",
              orientation: "h",
              // Reversed: Plotly draws the first category at the bottom of a
              // horizontal axis, so an unreversed list reads upside down.
              y: [...charted].reverse().map((e) => e.exercise),
              x: [...charted].reverse().map((e) => e.totalVolumeKg),
              marker: { color: charted.map((_, i) => seriesColour(i)).reverse() },
              hovertemplate: "%{y}<br>%{x:,.0f}kg lifetime<extra></extra>",
            },
          ]}
          layout={{
            xaxis: { title: { text: "kg" } },
            yaxis: { type: "category", automargin: true },
            showlegend: false,
          }}
        />
      </section>

      <section className="card">
        <h2>Where the work goes</h2>
        <Plot
          title="Share of lifetime volume by equipment"
          height={300}
          data={[
            {
              type: "bar",
              x: [...byEquipment.keys()],
              y: [...byEquipment.values()],
              marker: { color: [...byEquipment.keys()].map((_, i) => seriesColour(i)) },
              hovertemplate: "%{x}<br>%{y:,.0f}kg<extra></extra>",
            },
          ]}
          layout={{ yaxis: { title: { text: "kg" } }, showlegend: false }}
        />
      </section>

      <section className="card">
        <h2>The catalogue</h2>
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
