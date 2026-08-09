import { useEffect, useState } from "react";
import { api, type PersonalBest } from "../api.js";
import { Banner, formatDate, Loading } from "../components.jsx";
import { LineSeriesPlot } from "../plot.jsx";

/**
 * Strength over time.
 *
 * The line is an ESTIMATED one-rep max (Epley: `weight × (1 + reps/30)`), not a
 * tested one, because a tested max happens at most once every six weeks and a
 * chart with four points a year tells you nothing. Every logged set contributes
 * a point.
 *
 * This estimator is deliberately NOT the one the program uses to seed the next
 * block. Keeping them apart means improving this chart can never quietly change
 * a training plan.
 */
export const ProgressPage = () => {
  const [series, setSeries] = useState<Record<string, Array<{ date: string; estimated: number }>>>(
    {},
  );
  const [bests, setBests] = useState<Record<string, PersonalBest>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .progress()
      .then((r) => {
        setSeries(r.series);
        setBests(r.personalBests);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading what="your progress" />;
  if (error) return <Banner variant="error">{error}</Banner>;

  const COLOURS: Record<string, string> = {
    squat: "var(--series-1)",
    bench: "var(--series-2)",
    deadlift: "var(--series-3)",
  };

  const chart = Object.entries(series)
    .filter(([, points]) => points.length > 0)
    .map(([lift, points]) => ({
      name: lift.charAt(0).toUpperCase() + lift.slice(1),
      colour: COLOURS[lift] ?? "var(--series-4)",
      points: points.map((p) => ({ date: p.date, value: p.estimated })),
    }));

  return (
    <>
      <h1>Progress</h1>

      <section className="card">
        <h2>Estimated one-rep max</h2>
        <p className="muted">
          Estimated from every logged set, so the line moves weekly rather than once a block.
        </p>
        {chart.length > 0 ? (
          <LineSeriesPlot series={chart} yLabel="Estimated 1RM" height={260} />
        ) : (
          <p className="muted">Log some sets and this chart fills in.</p>
        )}
      </section>

      <section className="card">
        <h2>Best to date</h2>
        {Object.keys(bests).length === 0 ? (
          <p className="muted">No personal bests yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Lift</th>
                  <th className="num">Weight</th>
                  <th className="num">Reps</th>
                  <th className="num">Estimated 1RM</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(bests).map(([lift, best]) => (
                  <tr key={lift}>
                    <td style={{ textTransform: "capitalize" }}>{lift}</td>
                    <td className="num">{best.weight}</td>
                    <td className="num">{best.reps}</td>
                    <td className="num">{Math.round(best.estimated * 10) / 10}</td>
                    <td>{formatDate(best.timestamp.slice(0, 10))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
};
