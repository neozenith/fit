import { useEffect, useState } from "react";
import { api, type HistoryStreak } from "../../api.js";
import { Banner, Loading } from "../../components.jsx";
import { Plot, seriesColour } from "../../plot.jsx";

/**
 * Runs of consecutive active days, counting a lift and a ride alike.
 *
 * The gap tolerance is TWO days, matching the source workbook's "allowable
 * streak gap": training six days a week with a rest day should read as one
 * streak, not six one-day streaks. A strict definition would make the metric
 * describe the rest schedule rather than the training.
 *
 * No window filter. A streak is defined by its own span — filtering the input
 * by date would truncate streaks at the window edge and report shorter ones
 * than actually happened, which is a wrong answer rather than a narrower one.
 */
export const HistoryStreaksPage = () => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.historyStreaks>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .historyStreaks()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <Banner variant="error">{error}</Banner>;
  if (!data) return <Loading what="your streaks" />;
  if (!data.available) {
    return (
      <>
        <h1>Streaks</h1>
        <Banner>{data.reason}</Banner>
      </>
    );
  }

  const streaks: HistoryStreak[] = data.streaks;
  const ranked = [...streaks].sort((a, b) => b.days - a.days);
  const longest = ranked[0];

  return (
    <>
      <h1>Streaks</h1>
      <p className="muted">
        Consecutive active days, counting a lift and a ride alike, tolerating a two-day gap so a
        rest day does not end a streak.
      </p>

      <section className="card">
        <h2>
          {longest ? `${longest.days} days` : "—"}
          {longest && (
            <span className="muted">
              {" "}
              from {longest.start}, {longest.activeDays} of them active
            </span>
          )}
        </h2>
        <Plot
          title="Streak length, longest first"
          height={Math.max(300, ranked.length * 26)}
          data={[
            {
              type: "bar",
              orientation: "h",
              name: "Span",
              // Reversed because Plotly draws the first category at the BOTTOM
              // of a horizontal axis — without this the longest streak lands
              // last and the chart reads upside down.
              y: [...ranked].reverse().map((s) => s.start),
              x: [...ranked].reverse().map((s) => s.days),
              marker: { color: seriesColour(0) },
              hovertemplate: "From %{y}<br>%{x} days<extra></extra>",
            },
            {
              type: "bar",
              orientation: "h",
              name: "Active days",
              y: [...ranked].reverse().map((s) => s.start),
              x: [...ranked].reverse().map((s) => s.activeDays),
              marker: { color: seriesColour(2) },
              hovertemplate: "From %{y}<br>%{x} active<extra></extra>",
            },
          ]}
          layout={{
            barmode: "group",
            xaxis: { title: { text: "days" } },
            yaxis: { type: "category", automargin: true },
          }}
        />
      </section>

      <section className="card">
        <h2>The numbers</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Span</th>
                <th>Active days</th>
                <th>Density</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((s) => (
                <tr key={`${s.start}-${s.end}`}>
                  <td className="mono">{s.start}</td>
                  <td className="mono">{s.end}</td>
                  <td className="mono">{s.days}d</td>
                  <td className="mono">{s.activeDays}</td>
                  <td className="mono">{Math.round((s.activeDays / s.days) * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
};
