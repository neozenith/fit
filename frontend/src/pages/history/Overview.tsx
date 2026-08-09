import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { Banner, Loading } from "../../components.jsx";

/**
 * What the archive contains, and where to go next.
 *
 * Deliberately the only history page with no filters. It answers "how much is
 * in here and over what span" — a question with one answer, which the window
 * controls on every other page would only make ambiguous.
 */

const KG = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}t` : `${Math.round(v)}kg`);

const SUBPAGES = [
  ["/history/volume", "Volume", "Sets × reps × load, by week or month."],
  ["/history/bodyweight", "Body weight", "Every weigh-in, with a 7-day trend."],
  ["/history/rep-maxes", "Rep maxes", "Heaviest load for at least N reps, per lift."],
  ["/history/cardio", "Cardio", "Weekly distance, and power per kilogram."],
  ["/history/streaks", "Streaks", "Runs of consecutive active days."],
] as const;

export const HistoryOverviewPage = () => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.historySummary>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .historySummary()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (error) return <Banner variant="error">{error}</Banner>;
  if (loading) return <Loading what="your training history" />;
  if (!data) return null;

  if (!data.available) {
    return (
      <>
        <h1>History</h1>
        <Banner>{data.reason}</Banner>
        <p className="muted">
          Curate the workbook with <code className="mono">make history</code>, then publish it with{" "}
          <code className="mono">make publish-history ENV=&lt;env&gt;</code>.
        </p>
      </>
    );
  }

  const delta =
    data.weightFirstKg !== null && data.weightLatestKg !== null
      ? Math.round((data.weightLatestKg - data.weightFirstKg) * 10) / 10
      : null;

  return (
    <>
      <h1>History</h1>
      <p className="muted">
        {data.from} to {data.to}, imported from the tracker this app replaced. Read-only — the
        import is history, and correcting it would mean correcting the past.
      </p>

      <section className="card">
        <h2>In total</h2>
        <div className="grid">
          <Stat label="Sessions" value={String(data.sessions)} />
          <Stat label="Set groups" value={String(data.sets)} />
          <Stat label="Volume moved" value={KG(data.totalVolumeKg)} />
          <Stat label="Exercises" value={String(data.exercises)} />
          <Stat label="Rides & runs" value={String(data.activities)} />
          <Stat label="Weigh-ins" value={String(data.weighIns)} />
          <Stat
            label="Body weight"
            value={
              delta === null
                ? "—"
                : `${data.weightFirstKg}→${data.weightLatestKg}kg (${delta > 0 ? "+" : ""}${delta})`
            }
          />
        </div>
      </section>

      <section className="card">
        <h2>Break it down</h2>
        <p className="muted">
          Each is its own address, so a single chart can be linked to and discussed on its own.
        </p>
        <ul className="linklist">
          {SUBPAGES.map(([href, label, blurb]) => (
            <li key={href}>
              <a href={href}>{label}</a> <span className="muted">— {blurb}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="muted">{label}</div>
    <div className="stat-value">{value}</div>
  </div>
);
