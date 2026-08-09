import { api, type HistoryBodyPoint } from "../../api.js";
import { HistoryWindow } from "../../filters.jsx";
import { Plot, seriesColour } from "../../plot.jsx";
import { PageGate, useExtent, useHistoryData } from "./shared.jsx";

/**
 * Body weight, with a 7-day trailing mean.
 *
 * The raw series swings a kilo or more between consecutive mornings — hydration
 * and gut content, not tissue. Charting it alone invites reading noise as
 * progress, which is why the smoothed line is computed server-side and drawn on
 * top rather than left to the eye.
 *
 * `connectgaps: false` matters here more than anywhere else in the app: the
 * archive has a three-year stretch with no weigh-ins, and a line drawn across it
 * shows a climb nobody measured.
 */
export const HistoryBodyweightPage = () => {
  const { extent, unavailable, loading } = useExtent();
  const { data, error } = useHistoryData(extent, (window) => api.historyBodyweight(window));

  const gate = PageGate({
    title: "Body weight",
    loading: loading || (!data && !error),
    unavailable,
    error,
    what: "your weigh-ins",
  });
  if (gate) return gate;

  const points: HistoryBodyPoint[] = data?.available ? data.points : [];

  // Insert an explicit null wherever more than three weeks passed with no
  // reading. Plotly breaks a line on null; without it the gap is bridged.
  const dates: (string | null)[] = [];
  const weights: (number | null)[] = [];
  const trend: (number | null)[] = [];
  const bmi: (number | null)[] = [];
  let previous = 0;
  for (const p of points) {
    const at = Date.parse(p.date);
    if (previous && at - previous > 21 * 86_400_000) {
      dates.push(p.date);
      weights.push(null);
      trend.push(null);
      bmi.push(null);
    }
    dates.push(p.date);
    weights.push(p.weightKg);
    trend.push(p.trendKg);
    bmi.push(p.bmi);
    previous = at;
  }

  const latest = points.at(-1);
  const first = points[0];
  const delta = latest && first ? Math.round((latest.weightKg - first.weightKg) * 10) / 10 : null;

  return (
    <>
      <h1>Body weight</h1>
      <p className="muted">
        Each morning's reading, and a 7-day mean over it. Day-to-day swings are hydration, not
        tissue. Gaps in recording are drawn as gaps.
      </p>

      <div className="filters">
        <HistoryWindow />
      </div>

      <section className="card">
        <h2>
          {latest ? `${latest.weightKg}kg` : "—"}
          {delta !== null && (
            <span className="muted">
              {" "}
              ({delta > 0 ? "+" : ""}
              {delta}kg over this window)
            </span>
          )}
        </h2>
        <Plot
          title="Body weight over time, with a 7-day mean"
          height={380}
          data={[
            {
              type: "scatter",
              mode: "markers",
              name: "Weigh-in",
              x: dates,
              y: weights,
              marker: { color: seriesColour(5), size: 4, opacity: 0.55 },
              hovertemplate: "%{x}<br>%{y:.1f}kg<extra></extra>",
            },
            {
              type: "scatter",
              mode: "lines",
              name: "7-day mean",
              x: dates,
              y: trend,
              line: { color: seriesColour(1), width: 2.5 },
              connectgaps: false,
              hovertemplate: "%{x}<br>%{y:.2f}kg<extra></extra>",
            },
          ]}
          layout={{ yaxis: { title: { text: "kg" } } }}
        />
      </section>

      <section className="card">
        <h2>BMI</h2>
        <p className="muted">
          Derived from the same weigh-ins and a height of 1.75m, which the workbook never recorded —
          it was recovered by inverting its own BMI column and checking the answer was constant.
        </p>
        <Plot
          title="Body mass index over time"
          height={260}
          data={[
            {
              type: "scatter",
              mode: "lines",
              name: "BMI",
              x: dates,
              y: bmi,
              line: { color: seriesColour(3), width: 2 },
              // Same gap treatment as the weight series above. Without it this
              // chart drew a clean three-year climb from a stretch in which
              // nothing was recorded at all.
              connectgaps: false,
              hovertemplate: "%{x}<br>BMI %{y:.2f}<extra></extra>",
            },
          ]}
        />
      </section>
    </>
  );
};
