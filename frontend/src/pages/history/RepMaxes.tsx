import { useEffect, useState } from "react";
import { api, type HistoryRepMax } from "../../api.js";
import { Banner, Loading } from "../../components.jsx";
import { Segmented } from "../../filters.jsx";
import { Plot, seriesColour } from "../../plot.jsx";
import { useQueryParam } from "../../router.jsx";

/**
 * Heaviest load moved for at least N reps, per exercise.
 *
 * "At least" is the point, and it is where a naive `WHERE reps = N` gets it
 * wrong: a set of ten at 100kg proves a five-rep max of at least 100kg, so
 * excluding it would report a 5RM below a set that was actually performed. The
 * source workbook does the same thing, which is why its 3RM and 5RM columns hold
 * identical values for several lifts.
 *
 * No date window here, deliberately. A personal best is a lifetime fact; asking
 * for "the last 90 days of all-time bests" is a question with no meaning, and a
 * filter that quietly reframes a PB as a recent maximum is worse than no filter.
 */

const REPS = [1, 3, 5, 10, 12];

const MEASURES = [
  { value: "absolute", label: "kg" },
  { value: "relative", label: "× bodyweight" },
];

export const HistoryRepMaxesPage = () => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.historyRepMaxes>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [measure] = useQueryParam("measure", "absolute");

  useEffect(() => {
    api
      .historyRepMaxes()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <Banner variant="error">{error}</Banner>;
  if (!data) return <Loading what="your rep maxes" />;
  if (!data.available) {
    return (
      <>
        <h1>Rep maxes</h1>
        <Banner>{data.reason}</Banner>
      </>
    );
  }

  const relative = measure === "relative";
  const rows = data.repMaxes;

  const byExercise = new Map<string, Map<number, HistoryRepMax>>();
  for (const r of rows) {
    let entry = byExercise.get(r.exercise);
    if (!entry) {
      entry = new Map();
      byExercise.set(r.exercise, entry);
    }
    entry.set(r.reps, r);
  }

  // Ordered by the heaviest single, so the chart reads top-down by strength
  // rather than alphabetically. A relative view reorders on ratio instead —
  // which is the entire reason for offering it, since a 60kg pull-up and a
  // 140kg deadlift are not comparable until divided by the body doing them.
  const value = (r: HistoryRepMax | undefined): number | null =>
    r ? (relative ? r.bodyweightRatio : r.weightKg) : null;

  const exercises = [...byExercise.entries()]
    .sort((a, b) => (value(b[1].get(1)) ?? 0) - (value(a[1].get(1)) ?? 0))
    .map(([name]) => name);

  const traces = REPS.map((reps, i) => ({
    type: "bar",
    name: `${reps}RM`,
    x: exercises,
    y: exercises.map((name) => value(byExercise.get(name)?.get(reps))),
    marker: { color: seriesColour(i) },
    hovertemplate: `%{x}<br>${reps}RM: %{y:.2f}${relative ? "×bw" : "kg"}<extra></extra>`,
  }));

  return (
    <>
      <h1>Rep maxes</h1>
      <p className="muted">
        Heaviest load moved for <em>at least</em> that many reps, so a set of ten at 100kg counts as
        a five-rep max too. Ratios use the body weight recorded nearest the lift.
      </p>

      <div className="filters">
        <Segmented label="Measure" param="measure" fallback="absolute" options={MEASURES} />
      </div>

      <section className="card">
        <h2>By exercise</h2>
        <Plot
          title="Rep maxes by exercise"
          height={Math.max(360, exercises.length * 22)}
          data={traces}
          layout={{
            barmode: "group",
            yaxis: { title: { text: relative ? "× bodyweight" : "kg" } },
            xaxis: { automargin: true, tickangle: -45 },
          }}
        />
      </section>

      <section className="card">
        <h2>The numbers</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Exercise</th>
                {REPS.map((n) => (
                  <th key={n}>{n}RM</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {exercises.map((name) => (
                <tr key={name}>
                  <td>{name}</td>
                  {REPS.map((n) => {
                    const cell = byExercise.get(name)?.get(n);
                    return (
                      <td key={n} className="mono">
                        {cell ? (
                          <>
                            {cell.weightKg}kg
                            {cell.bodyweightRatio !== null && (
                              <span className="muted"> ×{cell.bodyweightRatio.toFixed(2)}bw</span>
                            )}
                            <span className="muted"> {cell.achievedOn}</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
};
