import { useEffect, useState } from "react";
import {
  api,
  type HistoryBodyPoint,
  type HistoryCardioWeek,
  type HistoryExercise,
  type HistoryRepMax,
  type HistoryStreak,
  type HistoryVolumePoint,
} from "../api.js";
import { Banner, BarChart, LineChart, Loading } from "../components.jsx";

/**
 * Five years of training that predate this app.
 *
 * The source was a spreadsheet with twenty-eight derived sheets. None of them
 * were imported — only the facts were, and every number on this page is
 * recomputed from those facts by the API. So a figure here that disagrees with
 * the old workbook is a question with an answer, not a mystery.
 *
 * The whole page is read-only. Nothing here can be edited, because the import
 * is history: correcting it would mean correcting the past, and the current
 * log is the place to record what is true now.
 */

/** The rep milestones the workbook tracked, in the order it showed them. */
const REP_COLUMNS = [1, 3, 5, 10, 12];

const KG = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}t` : `${Math.round(v)}kg`);

interface Loaded {
  summary: Awaited<ReturnType<typeof api.historySummary>>;
  exercises: HistoryExercise[];
  repMaxes: HistoryRepMax[];
  body: HistoryBodyPoint[];
  cardio: HistoryCardioWeek[];
  streaks: HistoryStreak[];
}

export const HistoryPage = () => {
  const [data, setData] = useState<Loaded | null>(null);
  const [volume, setVolume] = useState<HistoryVolumePoint[]>([]);
  const [grain, setGrain] = useState<"week" | "month">("month");
  const [exercise, setExercise] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // One request per dataset, in parallel. They are independent queries over
    // independent Parquet, so serialising them would only add latency — and a
    // single combined endpoint would make every panel wait for the slowest.
    Promise.all([
      api.historySummary(),
      api.historyExercises(),
      api.historyRepMaxes(),
      api.historyBodyweight(),
      api.historyCardio(),
      api.historyStreaks(),
    ])
      .then(([summary, exercises, repMaxes, body, cardio, streaks]) =>
        setData({
          summary,
          exercises: exercises.available ? exercises.exercises : [],
          repMaxes: repMaxes.available ? repMaxes.repMaxes : [],
          body: body.available ? body.points : [],
          cardio: cardio.available ? cardio.weeks : [],
          streaks: streaks.available ? streaks.streaks : [],
        }),
      )
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    api
      .historyVolume(grain, exercise || undefined)
      .then((r) => setVolume(r.available ? r.points : []))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [grain, exercise]);

  if (loading) return <Loading what="your training history" />;
  if (error) return <Banner variant="error">{error}</Banner>;
  if (!data) return null;

  if (!data.summary.available) {
    return (
      <>
        <h1>History</h1>
        <Banner>{data.summary.reason}</Banner>
        <p className="muted">
          Curate the workbook with <code className="mono">make history</code>, then publish it with{" "}
          <code className="mono">make publish-history ENV=&lt;env&gt;</code>.
        </p>
      </>
    );
  }

  const s = data.summary;

  // Volume arrives per exercise per period; the chart wants one bar per period.
  const byPeriod = new Map<string, number>();
  for (const p of volume) byPeriod.set(p.period, (byPeriod.get(p.period) ?? 0) + p.volumeKg);
  const volumeBars = [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, value]) => ({ label: period.slice(0, 7), value }));

  const repMaxByExercise = new Map<string, Map<number, HistoryRepMax>>();
  for (const r of data.repMaxes) {
    let row = repMaxByExercise.get(r.exercise);
    if (!row) {
      row = new Map();
      repMaxByExercise.set(r.exercise, row);
    }
    row.set(r.reps, r);
  }

  const weightDelta =
    s.weightFirstKg !== null && s.weightLatestKg !== null
      ? Math.round((s.weightLatestKg - s.weightFirstKg) * 10) / 10
      : null;

  return (
    <>
      <h1>History</h1>
      <p className="muted">
        {s.from} to {s.to}, imported from the tracker this app replaced. Read-only.
      </p>

      <section className="card">
        <h2>In total</h2>
        <div className="grid">
          <Stat label="Sessions" value={String(s.sessions)} />
          <Stat label="Set groups" value={String(s.sets)} />
          <Stat label="Volume moved" value={KG(s.totalVolumeKg)} />
          <Stat label="Exercises" value={String(s.exercises)} />
          <Stat label="Rides & runs" value={String(s.activities)} />
          <Stat label="Weigh-ins" value={String(s.weighIns)} />
          <Stat
            label="Body weight"
            value={
              weightDelta === null
                ? "—"
                : `${s.weightFirstKg}→${s.weightLatestKg}kg (${weightDelta > 0 ? "+" : ""}${weightDelta})`
            }
          />
        </div>
      </section>

      <section className="card">
        <h2>Training volume</h2>
        <p className="muted">
          Sets × reps × load. Isometric holds are excluded — seconds and repetitions are not the
          same unit, and summing them would produce a number in neither.
        </p>
        <div className="row">
          <div className="field">
            <label htmlFor="grain">Group by</label>
            <select
              id="grain"
              value={grain}
              onChange={(e) => setGrain(e.target.value as "week" | "month")}
            >
              <option value="month">Month</option>
              <option value="week">Week</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="exercise">Exercise</label>
            <select id="exercise" value={exercise} onChange={(e) => setExercise(e.target.value)}>
              <option value="">All exercises</option>
              {data.exercises.map((e) => (
                <option key={e.exercise} value={e.exercise}>
                  {e.exercise}
                </option>
              ))}
            </select>
          </div>
        </div>
        <BarChart bars={volumeBars} colour="var(--series-1)" format={KG} />
      </section>

      <section className="card">
        <h2>Body weight</h2>
        <p className="muted">
          The lighter line is each morning's reading; the darker one is a 7-day mean. Day-to-day
          swings are hydration, not tissue.
        </p>
        <LineChart
          height={240}
          yLabel="kg"
          // Weigh-ins stop for years at a time. Bridging those gaps with a
          // straight line would show a climb that was never measured.
          maxGapDays={21}
          series={[
            {
              name: "Weight",
              colour: "var(--series-6)",
              points: data.body.map((p) => ({ date: p.date, value: p.weightKg })),
            },
            {
              name: "7-day trend",
              colour: "var(--series-2)",
              points: data.body.map((p) => ({ date: p.date, value: p.trendKg })),
            },
          ]}
        />
      </section>

      <section className="card">
        <h2>Rep maxes</h2>
        <p className="muted">
          Heaviest load moved for <em>at least</em> that many reps, so a set of ten at 100kg counts
          as a five-rep max too. Ratios are to the body weight recorded nearest the lift.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Exercise</th>
                {REP_COLUMNS.map((n) => (
                  <th key={n}>{n}RM</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...repMaxByExercise.entries()].map(([name, byReps]) => (
                <tr key={name}>
                  <td>{name}</td>
                  {REP_COLUMNS.map((n) => {
                    const cell = byReps.get(n);
                    return (
                      <td key={n} className="mono">
                        {cell ? (
                          <>
                            {cell.weightKg}kg
                            {cell.bodyweightRatio !== null && (
                              <span className="muted"> ×{cell.bodyweightRatio.toFixed(2)}bw</span>
                            )}
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

      <section className="card">
        <h2>Cardio</h2>
        <p className="muted">
          Weekly distance, and power normalised by the body weight of the time — raw watts are not
          comparable across five years in which body weight moved by ten kilos.
        </p>
        <BarChart
          bars={data.cardio.map((w) => ({ label: w.week.slice(0, 7), value: w.distanceKm }))}
          colour="var(--series-3)"
          format={(v) => `${Math.round(v)}km`}
        />
        <LineChart
          height={200}
          yLabel="W/kg"
          maxGapDays={35}
          series={[
            {
              name: "Weighted avg W/kg",
              colour: "var(--series-5)",
              points: data.cardio
                .filter((w) => w.avgWattsPerKg !== null)
                .map((w) => ({ date: w.week, value: w.avgWattsPerKg as number })),
            },
          ]}
        />
      </section>

      <section className="card">
        <h2>Longest streaks</h2>
        <p className="muted">
          Consecutive active days, counting a lift and a ride alike, tolerating a two-day gap so a
          rest day does not end a streak.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Span</th>
                <th>Active days</th>
              </tr>
            </thead>
            <tbody>
              {data.streaks.slice(0, 10).map((st) => (
                <tr key={`${st.start}-${st.end}`}>
                  <td className="mono">{st.start}</td>
                  <td className="mono">{st.end}</td>
                  <td className="mono">{st.days}d</td>
                  <td className="mono">{st.activeDays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Exercise catalogue</h2>
        <p className="muted">
          Every movement ever logged, derived from the log itself — so it cannot list one that was
          never performed, nor omit one that was.
        </p>
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
              {data.exercises.map((e) => (
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

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="muted">{label}</div>
    <div className="stat-value">{value}</div>
  </div>
);
