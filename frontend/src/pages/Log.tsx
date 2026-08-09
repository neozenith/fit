import type { BlockConfig, PrescribedExercise, Session } from "@fit/program";
import { useCallback, useEffect, useState } from "react";
import { api, type BlockProgress } from "../api.js";
import { Banner, formatDate, Loading, repLabel } from "../components.jsx";
import { useQueryParam } from "../router.jsx";

/**
 * Log what actually happened, one exercise at a time.
 *
 * The shape comes from the Google Form this app replaces, which submitted ONE
 * EXERCISE PER RESPONSE — not a whole session. That turned out to be the right
 * grain and not an accident of forms: you finish an exercise, you record it,
 * and the record is what tells you where you are when you come back from a
 * superset three movements later. A single end-of-session save loses exactly
 * that, and loses everything if you close the tab.
 *
 * So each exercise here is independently submittable, shows how many sets it
 * already has against it, and — in the overwhelmingly common case where you did
 * what the program said — takes one tap.
 *
 * The form's other good idea is kept too: a COMMA-SEPARATED weight list.
 * `60,70,80` is three sets at those loads with the same reps, which is how a
 * ramping set actually gets written down.
 */

/** `60,70,80` → three sets. A single value is one set unless `sets` says more. */
const parseWeights = (raw: string): number[] =>
  raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);

interface Draft {
  weights: string;
  reps: string;
  sets: string;
}

const prescribedDraft = (exercise: PrescribedExercise): Draft => {
  const sets = exercise.sets;
  const weights = sets.map((s) => (s.weight !== undefined ? String(s.weight) : "")).filter(Boolean);
  const first = sets[0];
  const reps =
    first?.reps && "kind" in first.reps && first.reps.kind === "fixed"
      ? String(first.reps.reps)
      : "";

  return {
    // Distinct loads only when they differ: a straight-sets prescription writes
    // `80` and a count, not `80,80,80`, which is what anyone would type.
    weights: [...new Set(weights)].length === 1 ? (weights[0] ?? "") : weights.join(","),
    reps,
    sets: String(sets.length || 1),
  };
};

/** Whether one tap can log this exercise: every set has a load and a rep count. */
const isFullyPrescribed = (exercise: PrescribedExercise): boolean =>
  exercise.sets.length > 0 &&
  exercise.sets.every(
    (s) => s.weight !== undefined && s.reps && "kind" in s.reps && s.reps.kind === "fixed",
  );

export const LogPage = () => {
  const [block, setBlock] = useState<BlockConfig | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [progress, setProgress] = useState<BlockProgress>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

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
  if (error) return <Banner variant="error">{error}</Banner>;

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

  const setsLogged = (session: Session, exercise: string): number =>
    progress[`${session.week}-${session.day}`]?.[exercise] ?? 0;

  const isDone = (session: Session): boolean => {
    const expected = session.exercises.filter((e) => e.sets.length > 0);
    return expected.length > 0 && expected.every((e) => setsLogged(session, e.exercise) > 0);
  };

  // Default to the first INCOMPLETE session, not the nearest by date. A session
  // skipped last week is the one you are most likely to be looking for, and
  // "nearest to today" silently skipped past it.
  const fallback = sessions.find((s) => !isDone(s)) ?? sessions.at(-1);
  const selected =
    sessions.find((s) => String(s.week) === week && String(s.day) === day) ?? fallback;

  const choose = (session: Session) => {
    setWeek(String(session.week));
    setDay(String(session.day));
    setExpanded(null);
  };

  const draftFor = (exercise: PrescribedExercise): Draft =>
    drafts[exercise.exercise] ?? prescribedDraft(exercise);

  const update = (exercise: PrescribedExercise, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [exercise.exercise]: { ...draftFor(exercise), ...patch } }));

  const submit = async (exercise: PrescribedExercise, draft: Draft) => {
    if (!selected) return;
    setBusy(exercise.exercise);
    setError(null);
    try {
      const weights = parseWeights(draft.weights);
      const reps = Number(draft.reps);
      const count = Math.max(1, Number(draft.sets) || 1);
      if (!Number.isFinite(reps) || reps < 0) throw new Error("Enter a rep count.");

      // A weight list defines its own set count; a single weight repeats for
      // `sets`. This is exactly the form's rule, and it is what makes a ramping
      // set one field rather than three rows.
      const loads = weights.length > 1 ? weights : Array(count).fill(weights[0] ?? undefined);

      await api.logSets(
        loads.map((weight, i) => ({
          exercise: exercise.exercise,
          ...(weight === undefined ? {} : { weight }),
          reps,
          units: block.units,
          setIndex: setsLogged(selected, exercise.exercise) + i + 1,
          blockId: block.blockId,
          week: selected.week,
          day: selected.day,
        })),
      );

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
        One exercise at a time — tick it off as you finish it, so a superset or a phone call never
        loses your place.
      </p>
      {error && <Banner variant="error">{error}</Banner>}

      {/* A grid of every session in the block, not a dropdown. A dropdown hides
          which sessions are already done, which is the single most useful thing
          to see when picking one. */}
      <section className="card">
        <h2>Which session</h2>
        <div className="session-picker">
          {sessions.map((session) => {
            const done = isDone(session);
            const started = session.exercises.some((e) => setsLogged(session, e.exercise) > 0);
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
                onClick={() => choose(session)}
              >
                <span className="day__date">
                  W{session.week}D{session.day}
                </span>
                <span className="day__name">{session.date.slice(5)}</span>
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
            {selected.exercises.map((exercise) => {
              const logged = setsLogged(selected, exercise.exercise);
              const target = exercise.sets.length;
              const draft = draftFor(exercise);
              const open = expanded === exercise.exercise;
              const oneTap = isFullyPrescribed(exercise);

              return (
                <div
                  key={exercise.exercise}
                  className={`exercise-row${logged > 0 ? " exercise-row--logged" : ""}`}
                >
                  <div className="exercise-row__head">
                    <div>
                      <strong>{exercise.exercise}</strong>
                      <div className="muted mono">
                        {target === 0
                          ? "no prescribed sets"
                          : exercise.sets
                              .map(
                                (set) =>
                                  `${set.weight !== undefined ? `${set.weight}${block.units} ` : ""}${repLabel(set.reps)}`,
                              )
                              .join(", ")}
                      </div>
                    </div>
                    <div className="spacer" />
                    {/* The count is the answer to "how many have I done?" —
                        the question you actually have mid-superset. */}
                    <span
                      className={`pill${logged >= target && target > 0 ? " pill--accent" : ""}`}
                    >
                      {logged}
                      {target > 0 ? ` / ${target}` : ""} sets
                    </span>
                    {oneTap && (
                      <button
                        type="button"
                        className="primary"
                        disabled={busy === exercise.exercise}
                        onClick={() => submit(exercise, prescribedDraft(exercise))}
                      >
                        {busy === exercise.exercise ? "Saving…" : "✓ As prescribed"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : exercise.exercise)}
                      aria-expanded={open}
                    >
                      {open ? "Close" : "Edit"}
                    </button>
                  </div>

                  {open && (
                    <div className="row exercise-row__form">
                      <div className="field">
                        <label htmlFor={`w-${exercise.exercise}`}>
                          Weight <span className="muted">— or a list like 60,70,80</span>
                        </label>
                        <input
                          id={`w-${exercise.exercise}`}
                          value={draft.weights}
                          onChange={(e) => update(exercise, { weights: e.target.value })}
                          placeholder="bodyweight if blank"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`r-${exercise.exercise}`}>Reps</label>
                        <input
                          id={`r-${exercise.exercise}`}
                          type="number"
                          min="0"
                          value={draft.reps}
                          onChange={(e) => update(exercise, { reps: e.target.value })}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`s-${exercise.exercise}`}>
                          Sets <span className="muted">— ignored with a weight list</span>
                        </label>
                        <input
                          id={`s-${exercise.exercise}`}
                          type="number"
                          min="1"
                          value={draft.sets}
                          onChange={(e) => update(exercise, { sets: e.target.value })}
                        />
                      </div>
                      <button
                        type="button"
                        className="primary"
                        disabled={busy === exercise.exercise}
                        onClick={() => submit(exercise, draft)}
                      >
                        {busy === exercise.exercise ? "Saving…" : "Add sets"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
};
