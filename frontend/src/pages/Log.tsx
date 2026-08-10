import {
  type BlockConfig,
  GLOSSARY,
  type PrescribedExercise,
  type PrescribedSet,
  ROLE_INTENT,
  requiredSets,
  type Session,
  sessionState,
} from "@fit/program";
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

/**
 * What the program asks for on this set, as editable strings.
 *
 * A FIXED count pre-fills with itself and a RANGE pre-fills with its top — you
 * aim for the top of a range, so that is the number you are most likely to
 * confirm, and it is one keystroke to change. A MAX-REPS set stays blank: there
 * is no target at all, and pre-filling one would invite confirming a lift
 * nobody performed (ADR-0031).
 */
const prescribedRow = (set: PrescribedSet | undefined): RowDraft => {
  const reps = set?.reps;
  const target =
    reps && "kind" in reps
      ? reps.kind === "fixed"
        ? String(reps.reps)
        : reps.kind === "range"
          ? String(reps.max)
          : ""
      : "";
  return { weight: set?.weight !== undefined ? String(set.weight) : "", reps: target };
};

export const LogPage = () => {
  const [block, setBlock] = useState<BlockConfig | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [progress, setProgress] = useState<BlockProgress>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  // Rows the athlete has typed into. A carried-forward value must never
  // overwrite a deliberate one.
  const [touched, setTouched] = useState<Set<string>>(new Set());

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

  const logFor = (session: Session) => progress[`${session.week}-${session.day}`] ?? {};

  const isDone = (session: Session): boolean =>
    sessionState(session, logFor(session), today) === "done";

  // Default to the first INCOMPLETE session, not the nearest by date. A session
  // skipped last week is the one you are most likely to be looking for, and
  // "nearest to today" silently skipped past it.
  const fallback = sessions.find((s) => !isDone(s)) ?? sessions.at(-1);
  const selected =
    sessions.find((s) => String(s.week) === week && String(s.day) === day) ?? fallback;

  const key = (exercise: string, index: number) => `${exercise}#${index}`;

  const draftFor = (exercise: PrescribedExercise, index: number): RowDraft =>
    drafts[key(exercise.exercise, index)] ?? prescribedRow(exercise.sets[index]);

  /**
   * Edit one row, and CARRY THE VALUE FORWARD to later untouched rows.
   *
   * Straight sets are the overwhelmingly common case: four sets at the same
   * load, which the program does not prescribe for accessories. Typing 40 four
   * times is three keystrokes too many, so the first row seeds the rest.
   *
   * Only rows that are neither logged nor manually edited are carried into —
   * `touched` is what stops a deliberate 40/40/35/30 from being flattened back
   * to 40 the moment you correct set one.
   */
  const update = (exercise: PrescribedExercise, index: number, patch: Partial<RowDraft>) =>
    setDrafts((d) => {
      const next = {
        ...d,
        [key(exercise.exercise, index)]: { ...draftFor(exercise, index), ...patch },
      };
      if (!selected) return next;

      const logged = loggedFor(selected, exercise.exercise).length;
      const rows = Math.max(exercise.sets.length, logged + 1);
      for (let i = index + 1; i < rows; i += 1) {
        const later = key(exercise.exercise, i);
        if (i < logged || touched.has(later)) continue;
        const base = next[later] ?? prescribedRow(exercise.sets[i]);
        // Weight carries unconditionally; REPS carry only into a row the
        // program left blank, so a prescribed 12/12/10/8 keeps its taper.
        next[later] = {
          weight: patch.weight ?? base.weight,
          reps: patch.reps !== undefined && base.reps === "" ? patch.reps : base.reps,
        };
      }
      return next;
    });

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
            const state = sessionState(session, logFor(session), today);
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
                onChange={(i, patch) => {
                  setTouched((was) => new Set(was).add(key(exercise.exercise, i)));
                  update(exercise, i, patch);
                }}
                onSave={(i) => saveSet(exercise, i)}
                rowKey={(i) => key(exercise.exercise, i)}
              />
            ))}
          </div>

          {/* The sheet's own `Additional Information` block. It is collapsed
              because it is reference rather than instruction — but it has to be
              reachable, because every conditional rule in the program keys off
              a set written `MR` or `MR10`, and those mean nothing to a reader
              who has only ever seen the app. */}
          <details className="glossary">
            <summary className="muted">What the rep notations mean</summary>
            <dl>
              {GLOSSARY.map(({ term, meaning }) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd className="muted">{meaning}</dd>
                </div>
              ))}
            </dl>
          </details>
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
  // An UNPRESCRIBED exercise needs a single set: "do some rows" has no set
  // count to satisfy, and treating it as never-completable made every session
  // containing one permanently unfinished.
  const complete = logged.length >= requiredSets(prescribed);

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
      {/* What the SLOT is for, which the exercise name alone does not say.
          The spreadsheet labelled its accessory fields "Upper Back Exercise #1
          (horizontal pull)"; the port kept the athlete's chosen lift and
          dropped the requirement it was chosen to satisfy, leaving a bare name
          with nothing on screen to judge a substitute against.

          `exercise.note` wins where the program gave specific guidance for this
          exercise; ROLE_INTENT is the standing description of the slot. */}
      <p className="exercise-row__intent muted">{exercise.note ?? ROLE_INTENT[exercise.role]}</p>

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
