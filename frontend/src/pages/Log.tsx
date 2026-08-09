import type { BlockConfig, PrescribedExercise, PrescribedSet, Session } from "@fit/program";
import { useCallback, useEffect, useState } from "react";
import { api, type BlockProgress, type LoggedSet } from "../api.js";
import { Banner, formatDate, formatShortDate, Loading, repLabel } from "../components.jsx";
import { useQueryParam } from "../router.jsx";

/**
 * Log a session, ONE SET AT A TIME.
 *
 * This is the page that gets used with a bar in your hands, so the design
 * constraint is clicks, not completeness. Every prescribed set is its own row,
 * always editable, with a single tick that saves it. A prescription of
 * `x12, x12, x10, x8` is four rows — because that is four decisions, made
 * minutes apart, and the row you have not ticked yet IS the answer to "where
 * was I".
 *
 * Two earlier versions got this wrong in the same way. Collapsing an exercise
 * to one "as prescribed" button assumed the whole exercise completes at once;
 * hiding the fields behind an Edit button added a click to the case that is not
 * an exception at all — the reps you actually got are rarely the reps written
 * down. Nothing is hidden and nothing is locked: type over any number and tick.
 *
 * Rep counts are never forced. A range or a max-reps set starts blank, because
 * the program did not prescribe a number and pre-filling one would invite
 * confirming a lift nobody performed.
 */

interface RowDraft {
  weight: string;
  reps: string;
}

/** What the program asks for on this set, as editable strings. */
const prescribedRow = (set: PrescribedSet | undefined): RowDraft => ({
  weight: set?.weight !== undefined ? String(set.weight) : "",
  // Only a FIXED rep count pre-fills. A range has no single answer and a
  // max-reps set is a measurement — both are typed after the fact.
  reps: set?.reps && "kind" in set.reps && set.reps.kind === "fixed" ? String(set.reps.reps) : "",
});

export const LogPage = () => {
  const [block, setBlock] = useState<BlockConfig | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [progress, setProgress] = useState<BlockProgress>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});

  // The selected session lives in the URL, so the overview's "log this one"
  // links open the right session and a half-finished session can be bookmarked.
  const [week, setWeek] = useQueryParam("week", "");
  const [day, setDay] = useQueryParam("day", "");

  const load = useCallback(
    () =>
      api.currentBlock().then((r) => {
        setBlock(r.block);
        setSessions(r.sessions);
        setProgress(r.progress ?? {});
        return r;
      }),
    [],
  );

  useEffect(() => {
    load()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [load]);

  if (loading) return <Loading what="your session" />;
  if (error && !block) return <Banner variant="error">{error}</Banner>;

  if (!block) {
    return (
      <>
        <h1>Log a session</h1>
        <Banner>You have no training block, so there is nothing prescribed to log.</Banner>
        <p>
          <a href="/block-inputs">Create a block</a> first.
        </p>
      </>
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  const loggedFor = (session: Session, exercise: string): LoggedSet[] =>
    progress[`${session.week}-${session.day}`]?.[exercise] ?? [];

  const isDone = (session: Session): boolean => {
    const expected = session.exercises.filter((e) => e.sets.length > 0);
    return (
      expected.length > 0 &&
      expected.every((e) => loggedFor(session, e.exercise).length >= e.sets.length)
    );
  };

  // Default to the first INCOMPLETE session, not the nearest by date. A session
  // skipped last week is the one you are most likely to be looking for, and
  // "nearest to today" silently skipped past it.
  const fallback = sessions.find((s) => !isDone(s)) ?? sessions.at(-1);
  const selected =
    sessions.find((s) => String(s.week) === week && String(s.day) === day) ?? fallback;

  const key = (exercise: string, index: number) => `${exercise}#${index}`;

  const draftFor = (exercise: PrescribedExercise, index: number): RowDraft =>
    drafts[key(exercise.exercise, index)] ?? prescribedRow(exercise.sets[index]);

  const update = (exercise: PrescribedExercise, index: number, patch: Partial<RowDraft>) =>
    setDrafts((d) => ({
      ...d,
      [key(exercise.exercise, index)]: { ...draftFor(exercise, index), ...patch },
    }));

  /** Save exactly one set. The whole page exists to make this one tap. */
  const saveSet = async (exercise: PrescribedExercise, index: number) => {
    if (!selected) return;
    const rowKey = key(exercise.exercise, index);
    const draft = draftFor(exercise, index);
    const reps = Number(draft.reps);
    if (draft.reps.trim() === "" || !Number.isFinite(reps) || reps < 0) {
      setError(`Enter the reps you did for ${exercise.exercise}, set ${index + 1}.`);
      return;
    }

    setBusy(rowKey);
    setError(null);
    try {
      const weight = draft.weight.trim() === "" ? undefined : Number(draft.weight);
      await api.logSets([
        {
          exercise: exercise.exercise,
          ...(weight === undefined || !Number.isFinite(weight) ? {} : { weight }),
          reps,
          units: block.units,
          // The ordinal within the session, so a set logged out of order still
          // reports where it belonged rather than when it was typed.
          setIndex: index + 1,
          blockId: block.blockId,
          week: selected.week,
          day: selected.day,
        },
      ]);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h1>Log a session</h1>
      <p className="muted">
        Tick each set as you finish it. Nothing is locked — type over any number first if the set
        did not go to plan.
      </p>
      {error && <Banner variant="error">{error}</Banner>}

      {/* A grid of every session, not a dropdown. Which sessions are already
          done is the most useful thing to see when picking one. */}
      <section className="card">
        <h2>Which session</h2>
        <div className="session-picker">
          {sessions.map((session) => {
            const done = isDone(session);
            const started = session.exercises.some(
              (e) => loggedFor(session, e.exercise).length > 0,
            );
            const state = done
              ? "done"
              : started
                ? "partial"
                : session.date > today
                  ? "future"
                  : "todo";
            const active = selected?.week === session.week && selected?.day === session.day;
            return (
              <button
                key={`${session.week}-${session.day}`}
                type="button"
                className={`day day--${state}${active ? " day--active" : ""}`}
                aria-pressed={active}
                onClick={() => {
                  setWeek(String(session.week));
                  setDay(String(session.day));
                }}
              >
                <span className="day__date">
                  W{session.week}D{session.day}
                </span>
                <span className="day__name">{formatShortDate(session.date)}</span>
              </button>
            );
          })}
        </div>
      </section>

      {selected && (
        <section className="card">
          <h2>
            Week {selected.week}, day {selected.day}
            <span className="muted"> · {formatDate(selected.date)}</span>
          </h2>
          {selected.intensityLabel && <p className="muted">{selected.intensityLabel}</p>}
          {selected.notes.map((note) => (
            <p key={note} className="muted">
              {note}
            </p>
          ))}

          <div className="exercise-list">
            {selected.exercises.map((exercise) => (
              <ExerciseSets
                key={exercise.exercise}
                exercise={exercise}
                units={block.units}
                logged={loggedFor(selected, exercise.exercise)}
                busy={busy}
                draftFor={(i) => draftFor(exercise, i)}
                onChange={(i, patch) => update(exercise, i, patch)}
                onSave={(i) => saveSet(exercise, i)}
                rowKey={(i) => key(exercise.exercise, i)}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
};

/**
 * One exercise: a row per prescribed set, plus any extra sets already logged.
 *
 * Extra rows appear beyond the prescription rather than being refused. Doing a
 * fifth set when four were written down is training, not a data-entry error,
 * and the log is a record of what happened (ADR-0013).
 */
const ExerciseSets = ({
  exercise,
  units,
  logged,
  busy,
  draftFor,
  onChange,
  onSave,
  rowKey,
}: {
  exercise: PrescribedExercise;
  units: string;
  logged: LoggedSet[];
  busy: string | null;
  draftFor: (index: number) => RowDraft;
  onChange: (index: number, patch: Partial<RowDraft>) => void;
  onSave: (index: number) => void;
  rowKey: (index: number) => string;
}) => {
  // One row per prescribed set, and one more than whatever has been logged, so
  // there is always an empty row to record an extra set into.
  const prescribed = exercise.sets.length;
  const rows = Math.max(prescribed, logged.length + 1);
  const complete = prescribed > 0 && logged.length >= prescribed;

  return (
    <div className={`exercise-row${complete ? " exercise-row--logged" : ""}`}>
      <div className="exercise-row__head">
        <strong>{exercise.exercise}</strong>
        <div className="spacer" />
        <span className={`pill${complete ? " pill--accent" : ""}`}>
          {logged.length}
          {prescribed > 0 ? ` / ${prescribed}` : ""} sets
        </span>
      </div>

      <div className="set-rows">
        {Array.from({ length: rows }, (_, index) => {
          const done = logged[index];
          const set = exercise.sets[index];
          const draft = draftFor(index);
          const saving = busy === rowKey(index);

          if (done) {
            return (
              <div className="set-row set-row--done" key={rowKey(index)}>
                <span className="set-row__n">{index + 1}</span>
                <span className="set-row__logged mono">
                  {done.weight !== undefined ? `${done.weight}${units} × ` : ""}
                  {done.reps} reps
                </span>
                <span className="muted set-row__when">
                  {new Date(done.timestamp).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                {/* A `title`, not an `aria-label`: a bare `span` has no role,
                    and ARIA labels on roleless elements are ignored by most
                    assistive technology. The tick is decorative anyway — the
                    logged values beside it carry the meaning. */}
                <span className="set-row__tick" title="Logged" aria-hidden="true">
                  ✓
                </span>
              </div>
            );
          }

          return (
            <div className="set-row" key={rowKey(index)}>
              <span className="set-row__n">{index + 1}</span>
              <input
                className="set-row__weight"
                aria-label={`${exercise.exercise} set ${index + 1} weight`}
                inputMode="decimal"
                value={draft.weight}
                placeholder={units}
                onChange={(e) => onChange(index, { weight: e.target.value })}
              />
              <span className="muted">×</span>
              <input
                className="set-row__reps"
                aria-label={`${exercise.exercise} set ${index + 1} reps`}
                inputMode="numeric"
                value={draft.reps}
                // A range or max-reps set shows what was ASKED for as a hint,
                // never as a value — confirming a number the program never
                // prescribed is how a max-reps set gets logged as a guess.
                placeholder={set ? repLabel(set.reps).replace(/^x/, "") : "reps"}
                onChange={(e) => onChange(index, { reps: e.target.value })}
              />
              <span className="muted set-row__target">{set ? repLabel(set.reps) : "extra"}</span>
              <button
                type="button"
                className="set-row__save"
                disabled={saving}
                aria-label={`Save ${exercise.exercise} set ${index + 1}`}
                onClick={() => onSave(index)}
              >
                {saving ? "…" : "✓"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
