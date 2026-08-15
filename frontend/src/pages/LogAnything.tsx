import { useCallback, useEffect, useState } from "react";
import { api, type CuratedExercise, type LoggedSet } from "../api.js";
import { Combobox } from "../combobox.jsx";
import { Banner, formatDate, Loading } from "../components.jsx";

/**
 * Log training that belongs to no block.
 *
 * A block is six weeks of prescription; the rest of the year is not. Before
 * this page, a session that was not a prescribed one had nowhere to go, so
 * anything done between blocks — or alongside one — simply went unrecorded, and
 * the history it should have fed silently under-reported.
 *
 * A FREE-FORM SESSION IS NOT A NEW KIND OF THING. It is sets with no `blockId`,
 * which the API has always accepted: `logSetSchema` makes the field optional and
 * `sessionProgress` filters on it, so a set without one can neither be
 * mis-attributed to a block nor counted toward its completion. Modelling it as
 * a first-class entity would have added a second grouping concept beside the
 * block's derived sessions, plus an item type and a migration, to express
 * something the existing grain already says.
 *
 * Grouping is therefore DERIVED, by date, exactly as the block view derives its
 * sessions from the calendar rather than storing them (ADR-0001).
 */

interface Row {
  exercise: string;
  weight: string;
  reps: string;
}

const BLANK: Row = { exercise: "", weight: "", reps: "" };

const today = () => new Date().toISOString().slice(0, 10);

/** Sets with no block, newest day first, grouped by the day they happened. */
const byDay = (sets: (LoggedSet & { exercise: string; blockId?: string })[]) => {
  const days = new Map<string, typeof sets>();
  for (const set of sets) {
    if (set.blockId) continue;
    const day = String(set.timestamp).slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), set]);
  }
  return [...days.entries()].sort(([a], [b]) => b.localeCompare(a));
};

export const LogAnythingPage = () => {
  const [catalogue, setCatalogue] = useState<CuratedExercise[]>([]);
  const [recent, setRecent] = useState<Parameters<typeof byDay>[0]>([]);
  const [rows, setRows] = useState<Row[]>([{ ...BLANK }]);
  const [units, setUnits] = useState<"kg" | "lb">("kg");
  const [date, setDate] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([api.catalogue(), api.activities()]).then(([c, a]) => {
        setCatalogue(c.exercises.filter((e: CuratedExercise) => !e.retired));
        setRecent(a.activities as Parameters<typeof byDay>[0]);
      }),
    [],
  );

  useEffect(() => {
    load()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [load]);

  const setRow = (index: number, patch: Partial<Row>) =>
    setRows((was) => was.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  /** An empty row always waits at the end, so adding a set is never a click. */
  const rowsWithSpare = rows.at(-1)?.exercise ? [...rows, { ...BLANK }] : rows;

  const save = async () => {
    const filled = rows.filter((r) => r.exercise.trim() && r.reps.trim() !== "");
    if (filled.length === 0) {
      setError("Add at least one set with an exercise and a rep count.");
      return;
    }
    const bad = filled.find((r) => !Number.isFinite(Number(r.reps)) || Number(r.reps) < 0);
    if (bad) {
      setError(`"${bad.reps}" is not a rep count.`);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await api.logActivities(
        filled.map((r, index) => {
          const weight = Number(r.weight);
          return {
            exercise: r.exercise.trim(),
            reps: Number(r.reps),
            units,
            setIndex: index + 1,
            // Midday, not midnight: a date-only entry stored as 00:00 local
            // lands on the PREVIOUS day once it is serialised to UTC from
            // Australia, which silently files a Monday session under Sunday.
            timestamp: new Date(`${date}T12:00:00`).toISOString(),
            ...(r.weight.trim() === "" || !Number.isFinite(weight) ? {} : { weight }),
            // No blockId. That absence IS the record: it is what keeps this
            // session out of every block's progress and completion count.
          };
        }),
      );
      setRows([{ ...BLANK }]);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading what="your logged sets" />;

  const options = catalogue.map((e) => e.exercise).sort((a, b) => a.localeCompare(b));
  const days = byDay(recent);

  return (
    <>
      <h1>Log anything</h1>
      <p className="muted">
        Training that belongs to no block — between cycles, or alongside one. These sets are
        recorded and counted in your history, but never against a block's progress.
      </p>
      {error && <Banner variant="error">{error}</Banner>}

      <section className="card">
        <h2>New session</h2>
        <div className="filters">
          <label className="field">
            <span className="field__label">Date</span>
            <input
              type="date"
              value={date}
              max={today()}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">Units</span>
            <select value={units} onChange={(e) => setUnits(e.target.value === "lb" ? "lb" : "kg")}>
              <option value="kg">kg</option>
              <option value="lb">lb</option>
            </select>
          </label>
        </div>

        <div className="freeform-rows">
          {rowsWithSpare.map((row, index) => (
            // The index IS the identity here: rows are positional, an exercise
            // can legitimately repeat, and a name-based key would collapse two
            // sets of the same lift into one row mid-edit.
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional by design
            <div className="freeform-row" key={index}>
              <span className="set-row__n">{index + 1}</span>
              <Combobox
                id={`freeform-${index}`}
                label={`Set ${index + 1} exercise`}
                value={row.exercise}
                options={options}
                onChange={(value) => setRow(index, { exercise: value })}
                placeholder="Search or type"
              />
              <input
                aria-label={`Set ${index + 1} weight`}
                inputMode="decimal"
                placeholder={units}
                value={row.weight}
                onChange={(e) => setRow(index, { weight: e.target.value })}
              />
              <span aria-hidden="true">×</span>
              <input
                aria-label={`Set ${index + 1} reps`}
                inputMode="numeric"
                placeholder="reps"
                value={row.reps}
                onChange={(e) => setRow(index, { reps: e.target.value })}
              />
            </div>
          ))}
        </div>

        <button type="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save session"}
        </button>
      </section>

      <section className="card">
        <h2>Earlier free-form sessions</h2>
        {days.length === 0 && <p className="muted">Nothing logged outside a block yet.</p>}
        {days.map(([day, sets]) => (
          <div key={day} className="freeform-day">
            <h3>{formatDate(day)}</h3>
            <ul>
              {sets.map((set) => (
                <li key={`${set.timestamp}-${set.exercise}-${set.reps}`} className="mono">
                  {set.exercise} — {set.weight !== undefined ? `${set.weight} × ` : ""}
                  {set.reps} reps
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </>
  );
};
