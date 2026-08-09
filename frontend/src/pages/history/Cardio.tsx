import { api, type HistoryCardioWeek } from "../../api.js";
import { HistoryWindow, Segmented, useHistoryWindow } from "../../filters.jsx";
import { Plot, seriesColour } from "../../plot.jsx";
import { useQueryParam } from "../../router.jsx";
import { PageGate, Pending, useExtent, useHistoryData } from "./shared.jsx";

/**
 * Weekly cardio, with power normalised by the body weight of the time.
 *
 * Raw watts are not comparable across five years in which body weight moved by
 * more than ten kilos; watts per kilogram are. The weigh-in is matched ASOF —
 * nearest on or before the ride — because weigh-ins and rides are independent
 * events that rarely share a date, and requiring an exact match would drop most
 * of the series.
 */

const METRICS = [
  { value: "distance", label: "Distance" },
  { value: "time", label: "Time" },
  { value: "elevation", label: "Elevation" },
];

const METRIC_CONFIG: Record<
  string,
  { field: keyof HistoryCardioWeek; unit: string; label: string; colour: number }
> = {
  distance: { field: "distanceKm", unit: "km", label: "Distance", colour: 2 },
  time: { field: "movingHours", unit: "h", label: "Moving time", colour: 5 },
  elevation: { field: "elevationM", unit: "m", label: "Elevation gain", colour: 3 },
};

export const HistoryCardioPage = () => {
  const { extent, unavailable, loading } = useExtent();
  const [metric] = useQueryParam("metric", "distance");
  const [, windowParams] = useHistoryWindow(extent);
  const { data, error, pending } = useHistoryData(
    windowParams,
    (params) => api.historyCardio(params),
    !loading,
  );

  const gate = PageGate({
    title: "Cardio",
    loading: loading || (!data && !error),
    unavailable,
    error,
    what: "your rides and runs",
  });
  if (gate) return gate;

  const weeks: HistoryCardioWeek[] = data?.available ? data.weeks : [];
  const config = METRIC_CONFIG[metric] ?? METRIC_CONFIG["distance"];
  if (!config) return null;

  const totalKm = Math.round(weeks.reduce((sum, w) => sum + w.distanceKm, 0));
  const totalHours = Math.round(weeks.reduce((sum, w) => sum + w.movingHours, 0));

  return (
    <>
      <h1>Cardio</h1>
      <p className="muted">
        Weekly totals from the Strava export, and power normalised by the body weight of the time.
      </p>

      <div className="filters">
        <Segmented label="Metric" param="metric" fallback="distance" options={METRICS} />
        <HistoryWindow />
      </div>

      <section className="card">
        <h2>
          {totalKm.toLocaleString()}km
          <span className="muted"> over {totalHours}h in this window</span>
          <Pending pending={pending} />
        </h2>
        <Plot
          title={`Weekly ${config.label.toLowerCase()}`}
          height={340}
          data={[
            {
              type: "bar",
              name: config.label,
              x: weeks.map((w) => w.week),
              y: weeks.map((w) => w[config.field]),
              marker: { color: seriesColour(config.colour) },
              hovertemplate: `Week of %{x}<br>%{y:,.1f}${config.unit}<extra></extra>`,
            },
          ]}
          layout={{ yaxis: { title: { text: config.unit } } }}
        />
      </section>

      <section className="card">
        <h2>Power to weight</h2>
        <p className="muted">
          Weighted average watts divided by body weight. Weeks with no power meter reading are drawn
          as gaps rather than as zero.
        </p>
        <Plot
          title="Weighted average watts per kilogram, weekly"
          height={280}
          data={[
            {
              type: "scatter",
              mode: "lines+markers",
              name: "W/kg",
              x: weeks.map((w) => w.week),
              y: weeks.map((w) => w.avgWattsPerKg),
              line: { color: seriesColour(4), width: 2 },
              marker: { size: 4 },
              connectgaps: false,
              hovertemplate: "Week of %{x}<br>%{y:.2f} W/kg<extra></extra>",
            },
          ]}
          layout={{ yaxis: { title: { text: "W/kg" } } }}
        />
      </section>

      <section className="card">
        <h2>The numbers</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Week of</th>
                <th>Activities</th>
                <th>Distance</th>
                <th>Moving</th>
                <th>Elevation</th>
                <th>W/kg</th>
              </tr>
            </thead>
            <tbody>
              {[...weeks].reverse().map((w) => (
                <tr key={w.week}>
                  <td className="mono">{w.week}</td>
                  <td className="mono">{w.activities}</td>
                  <td className="mono">{w.distanceKm}km</td>
                  <td className="mono">{w.movingHours}h</td>
                  <td className="mono">{w.elevationM}m</td>
                  <td className="mono">{w.avgWattsPerKg ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
};
