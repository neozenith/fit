import type { MeasurementRecord } from "@fit/program";
import { useCallback, useEffect, useState } from "react";
import { api, type HistoryBodyPoint, type WeeklyMedian } from "../api.js";
import { Banner, formatDate, Loading } from "../components.jsx";
import { HistoryWindow, useHistoryWindow } from "../filters.jsx";
import { LineSeriesPlot, Plot, seriesColour } from "../plot.jsx";

/**
 * Body metrics — recording them, and their whole history.
 *
 * `/history/bodyweight` used to be a separate page, which meant answering "am I
 * heavier than last year" required leaving the page where weight is recorded.
 * The two are one activity, so they are one page: the form, the live log's
 * weekly medians, and the five-year imported archive underneath.
 *
 * The live chart plots the WEEKLY MEDIAN rather than raw readings. A single
 * post-meal weigh-in moves a mean by a kilogram and makes a real downward trend
 * invisible; the median ignores it. The raw readings are still listed below, so
 * nothing is hidden — only de-emphasised.
 */

const DAY_MS = 86_400_000;
export const MeasurementsPage = () => {
  const [records, setRecords] = useState<MeasurementRecord[]>([]);
  const [weekly, setWeekly] = useState<WeeklyMedian[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ kind: "bodyWeight", value: "" });

  // The imported archive, loaded alongside. Independent of the live log: an
  // environment can have one, both or neither, and each section says so for
  // itself rather than the page refusing to render.
  const [archive, setArchive] = useState<HistoryBodyPoint[] | null>(null);
  const [extent, setExtent] = useState<{ from: string; to: string } | null>(null);
  const [, windowParams] = useHistoryWindow(extent);
  const archiveKey = new URLSearchParams(windowParams).toString();

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

  useEffect(() => {
    api
      .historySummary()
      .then((s) => setExtent(s.available ? { from: s.from, to: s.to } : null))
      .catch(() => setExtent(null));
  }, []);

  // Keyed on the serialised window, not the object — `resolveHistoryWindow`
  // returns a fresh object every render, and depending on it directly is an
  // infinite request loop that presents as a permanently slow page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on parameters
  useEffect(() => {
    api
      .historyBodyweight(Object.fromEntries(new URLSearchParams(archiveKey)))
      .then((r) => setArchive(r.available ? r.points : []))
      .catch(() => setArchive([]));
  }, [archiveKey]);

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

  // An explicit null wherever more than three weeks passed with no reading.
  // Plotly breaks a line on null; without it the gap is silently bridged.
  const gapped = {
    dates: [] as string[],
    weights: [] as (number | null)[],
    trend: [] as (number | null)[],
  };
  let previous = 0;
  for (const point of archive ?? []) {
    const at = Date.parse(point.date);
    if (previous && at - previous > 21 * DAY_MS) {
      gapped.dates.push(point.date);
      gapped.weights.push(null);
      gapped.trend.push(null);
    }
    gapped.dates.push(point.date);
    gapped.weights.push(point.weightKg);
    gapped.trend.push(point.trendKg);
    previous = at;
  }

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
        <h2>Imported history</h2>
        <p className="muted">
          Five years of weigh-ins from the tracker this app replaced. Read-only, and drawn with gaps
          where nothing was recorded — a line across a three-year silence would show a climb nobody
          measured.
        </p>
        <div className="filters">
          <HistoryWindow />
        </div>
        {archive === null ? (
          <p className="muted">Loading…</p>
        ) : archive.length === 0 ? (
          <p className="muted">No imported history in this environment.</p>
        ) : (
          <Plot
            title="Imported body weight over time, with a 7-day mean"
            height={360}
            data={[
              {
                type: "scatter",
                mode: "markers",
                name: "Weigh-in",
                x: gapped.dates,
                y: gapped.weights,
                marker: { color: seriesColour(5), size: 4, opacity: 0.55 },
                hovertemplate: "%{x}<br>%{y:.1f}kg<extra></extra>",
              },
              {
                type: "scatter",
                mode: "lines",
                name: "7-day mean",
                x: gapped.dates,
                y: gapped.trend,
                line: { color: seriesColour(1), width: 2.5 },
                connectgaps: false,
                hovertemplate: "%{x}<br>%{y:.2f}kg<extra></extra>",
              },
            ]}
            layout={{ yaxis: { title: { text: "kg" } } }}
          />
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
