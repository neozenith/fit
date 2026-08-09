import { useEffect, useState } from "react";
import { api, type HistoryExercise, type HistoryVolumePoint } from "../../api.js";
import { HistoryWindow, Segmented, SelectFilter } from "../../filters.jsx";
import { Plot, seriesColour, themeColour } from "../../plot.jsx";
import { useQueryParam } from "../../router.jsx";
import { PageGate, useExtent, useHistoryData } from "./shared.jsx";

/**
 * Training volume over time.
 *
 * Stacked by exercise rather than summed into one bar, because the interesting
 * question is almost never "how much" — it is "how much of WHAT", and a single
 * total hides a block that quietly replaced squats with deadlifts at the same
 * tonnage.
 *
 * `date_trunc('week', …)` is ISO, so weeks start Monday. The source workbook
 * started them Sunday, which means a week's totals will not line up cell for
 * cell with it. Monthly totals are identical either way.
 */

const TABLE_LIMIT = 200;

const GRAINS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

export const HistoryVolumePage = () => {
  const { extent, unavailable, loading } = useExtent();
  const [grain] = useQueryParam("grain", "month");
  const [exercise] = useQueryParam("exercise", "");
  const [catalogue, setCatalogue] = useState<HistoryExercise[]>([]);

  const { data, error, params } = useHistoryData(extent, (window) =>
    api.historyVolume({ grain, ...(exercise ? { exercise } : {}), ...window }),
  );

  useEffect(() => {
    api
      .historyExercises()
      .then((r) => setCatalogue(r.available ? r.exercises : []))
      .catch(() => setCatalogue([]));
  }, []);

  const gate = PageGate({
    title: "Volume",
    loading: loading || (!data && !error),
    unavailable,
    error,
    what: "training volume",
  });
  if (gate) return gate;

  const points: HistoryVolumePoint[] = data?.available ? data.points : [];
  const periods = [...new Set(points.map((p) => p.period))].sort();
  const total = points.reduce((sum, p) => sum + p.volumeKg, 0);

  // Forty exercises is forty legend entries, and the legend then takes more
  // vertical space than the chart. The theme has eight categorical colours, so
  // the top eight get their own trace and the rest are summed into "Other" —
  // which is honest (nothing is dropped from the total) and keeps every colour
  // distinguishable instead of cycling the palette five times over.
  const lifetime = new Map<string, number>();
  for (const p of points) lifetime.set(p.exercise, (lifetime.get(p.exercise) ?? 0) + p.volumeKg);

  const named = [...lifetime.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name]) => name);
  const namedSet = new Set(named);
  const hasOther = lifetime.size > named.length;

  // Plotly needs every series padded to the same x-axis: a period where a lift
  // was not trained contributes an explicit 0, because a stacked bar with holes
  // silently mis-stacks the series above it.
  const totals = new Map<string, number>();
  for (const p of points) {
    const series = namedSet.has(p.exercise) ? p.exercise : "Other";
    totals.set(`${p.period}|${series}`, (totals.get(`${p.period}|${series}`) ?? 0) + p.volumeKg);
  }

  const traces = [...named, ...(hasOther ? ["Other"] : [])].map((name, i) => ({
    type: "bar",
    name,
    x: periods,
    y: periods.map((period) => totals.get(`${period}|${name}`) ?? 0),
    // Resolved to a literal, not handed over as `var(--muted)`: Plotly
    // would render that as black with no complaint.
    marker: { color: name === "Other" ? themeColour("--muted", "#57525e") : seriesColour(i) },
    hovertemplate: `%{x}<br>${name}: %{y:,.0f}kg<extra></extra>`,
  }));

  // Truncated, and SAID so in the heading. Five years at daily grain is several
  // thousand rows; rendering them all makes a page nobody scrolls and a browser
  // that stutters. Ordered by volume so the truncation drops the least, not the
  // most recent.
  const tableRows = [...points]
    .sort((a, b) => b.volumeKg - a.volumeKg)
    .slice(0, TABLE_LIMIT)
    // Re-sorted chronologically AFTER truncating. Selecting by volume decides
    // what survives; ordering by date decides how it reads, and a table with a
    // Period column shuffled by size looks broken.
    .sort((a, b) => a.period.localeCompare(b.period) || b.volumeKg - a.volumeKg);

  return (
    <>
      <h1>Volume</h1>
      <p className="muted">
        Sets × reps × load, stacked by exercise. Isometric holds are excluded — seconds and
        repetitions are not the same unit, and summing them would produce a number in neither.
      </p>

      <div className="filters">
        <Segmented label="Grain" param="grain" fallback="month" options={GRAINS} />
        <HistoryWindow />
        <SelectFilter
          label="Exercise"
          param="exercise"
          fallback=""
          anyLabel="All exercises"
          options={catalogue.map((e) => ({ value: e.exercise, label: e.exercise }))}
        />
      </div>

      <section className="card">
        <h2>
          {Math.round(total / 1000)}t moved
          <span className="muted">
            {" "}
            across {periods.length} {grain}s
          </span>
        </h2>
        <Plot
          title={`Training volume by ${grain}, stacked by exercise`}
          data={traces}
          layout={{ barmode: "stack", yaxis: { title: { text: "kg" } } }}
          height={380}
        />
      </section>

      <section className="card">
        <h2>
          The numbers
          {points.length > TABLE_LIMIT && (
            <span className="muted">
              {" "}
              — heaviest {TABLE_LIMIT} of {points.length} rows
            </span>
          )}
        </h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Exercise</th>
                <th>Volume</th>
                <th>Sets</th>
                <th>Top weight</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((p, i) => (
                <tr key={`${p.period}-${p.exercise}-${i}`}>
                  <td className="mono">{p.period}</td>
                  <td>{p.exercise}</td>
                  <td className="mono">{p.volumeKg.toLocaleString()}kg</td>
                  <td className="mono">{p.sets}</td>
                  <td className="mono">{p.topWeightKg}kg</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {params["from"] && (
          <p className="muted">
            Window: {params["from"]} to {params["to"]}.
          </p>
        )}
      </section>
    </>
  );
};
