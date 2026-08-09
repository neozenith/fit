import type { MeasurementRecord } from "@fit/program";
import { useCallback, useEffect, useState } from "react";
import { api, type WeeklyMedian } from "../api.js";
import { Banner, formatDate, Loading } from "../components.jsx";
import { LineSeriesPlot } from "../plot.jsx";

/**
 * Body metrics.
 *
 * The chart plots the WEEKLY MEDIAN, not the raw readings, and that is the
 * whole point of the page. A single post-meal weigh-in moves a mean by a
 * kilogram and makes a real downward trend invisible; the median simply ignores
 * it. The raw readings are still listed underneath, so nothing is hidden — only
 * de-emphasised.
 */
export const MeasurementsPage = () => {
  const [records, setRecords] = useState<MeasurementRecord[]>([]);
  const [weekly, setWeekly] = useState<WeeklyMedian[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ kind: "bodyWeight", value: "" });

  // `useCallback` so the identity is stable across renders. Without it the
  // effect below would either re-run on every render or need a dependency list
  // that lies about what it depends on — and a lying dependency list is how a
  // stale closure gets into a component.
  const load = useCallback(
    () =>
      api.measurements().then((r) => {
        setRecords(r.measurements);
        setWeekly(r.weekly);
      }),
    [],
  );

  useEffect(() => {
    load()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [load]);

  const save = async () => {
    if (draft.value.trim() === "") {
      setError("Enter a value.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.logMeasurement({ kind: draft.kind, value: Number(draft.value) });
      setDraft({ ...draft, value: "" });
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading what="your measurements" />;

  const series = [
    {
      name: "Body weight (kg)",
      colour: "var(--series-1)",
      points: weekly
        .filter((w) => w.bodyWeight !== undefined)
        .map((w) => ({ date: w.weekStart, value: w.bodyWeight as number })),
    },
    {
      name: "Waist (cm)",
      colour: "var(--series-3)",
      points: weekly
        .filter((w) => w.waistCircumference !== undefined)
        .map((w) => ({ date: w.weekStart, value: w.waistCircumference as number })),
    },
  ].filter((s) => s.points.length > 0);

  return (
    <>
      <h1>Body</h1>
      {error && <Banner variant="error">{error}</Banner>}

      <section className="card">
        <h2>Record a measurement</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="kind">Measurement</label>
            <select
              id="kind"
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
            >
              <option value="bodyWeight">Body weight (kg)</option>
              <option value="waistCircumference">Waist circumference (cm)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="value">Value</label>
            <input
              id="value"
              type="number"
              step="0.1"
              min="0"
              value={draft.value}
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            />
          </div>
          <button className="primary" type="button" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Record"}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Weekly medians</h2>
        <p className="muted">
          Median, not mean — one heavy weigh-in should not move the line, and the point of a weekly
          figure is to see through daily noise.
        </p>
        {series.length > 0 ? (
          <LineSeriesPlot series={series} yLabel="Weekly medians" />
        ) : (
          <p className="muted">Record a few measurements and a trend will appear here.</p>
        )}
      </section>

      <section className="card">
        <h2>Every reading</h2>
        {records.length === 0 ? (
          <p className="muted">Nothing recorded yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Measurement</th>
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {records.slice(0, 60).map((r) => (
                  <tr key={`${r.timestamp}-${r.kind}`}>
                    <td>{formatDate(r.timestamp.slice(0, 10))}</td>
                    <td>{r.kind === "bodyWeight" ? "Body weight" : "Waist"}</td>
                    <td className="num">{r.value}</td>
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
