import type { BlockConfig, Session, SetRecord } from "@fit/program";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Banner, formatDate, Loading, repLabel } from "../components.jsx";

/**
 * Log what actually happened.
 *
 * The form is pre-filled from the PRESCRIPTION, because the overwhelmingly
 * common case is "I did what it said". Pre-filling turns a five-field entry
 * into a one-tap confirmation, and the exceptions are still a single edit away.
 */
export const LogPage = () => {
  const [block, setBlock] = useState<BlockConfig | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [recent, setRecent] = useState<SetRecord[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [draft, setDraft] = useState<Array<{ exercise: string; weight: string; reps: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const refresh = () => api.sets().then((r) => setRecent(r.sets.slice(0, 40)));

  useEffect(() => {
    Promise.all([api.currentBlock(), api.sets()])
      .then(([b, s]) => {
        setBlock(b.block);
        setSessions(b.sessions);
        setRecent(s.sets.slice(0, 40));

        // Default to the session nearest today, which is almost always the one
        // being logged. Picking the first session of the block instead would be
        // wrong from week two onward.
        const today = new Date().toISOString().slice(0, 10);
        const nearest = [...b.sessions].sort(
          (x, y) =>
            Math.abs(Date.parse(x.date) - Date.parse(today)) -
            Math.abs(Date.parse(y.date) - Date.parse(today)),
        )[0];
        if (nearest) selectSession(nearest, b.sessions);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    // Mount only — `selectSession` closes over nothing that changes.
  }, []);

  const selectSession = (session: Session, all: Session[] = sessions) => {
    setSelected(`${session.week}-${session.day}`);
    setDraft(
      session.exercises.flatMap((exercise) =>
        (exercise.sets.length > 0 ? exercise.sets : [{ weight: undefined, reps: null }]).map(
          (set) => ({
            exercise: exercise.exercise,
            weight: set.weight !== undefined ? String(set.weight) : "",
            // A rep RANGE cannot be pre-filled with a single number, and a
            // max-reps set has no target at all — both are left blank so the
            // athlete types what they actually did rather than confirming a
            // number the program never asked for.
            reps:
              set.reps && "kind" in set.reps && set.reps.kind === "fixed"
                ? String(set.reps.reps)
                : "",
          }),
        ),
      ),
    );
    void all;
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const session = sessions.find((s) => `${s.week}-${s.day}` === selected);
      const payload = draft
        // A blank rep count means "I did not do this set". Sending it as zero
        // would poison every average and every personal best.
        .filter((row) => row.reps.trim() !== "")
        .map((row) => ({
          exercise: row.exercise,
          ...(row.weight.trim() !== "" ? { weight: Number(row.weight) } : {}),
          reps: Number(row.reps),
          units: block?.units ?? "kg",
          ...(block ? { blockId: block.blockId } : {}),
          ...(session ? { week: session.week, day: session.day } : {}),
        }));

      if (payload.length === 0) {
        setError("Nothing to log — enter at least one rep count.");
        return;
      }

      const result = await api.logSets(payload);
      setSaved(result.written);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading what="your sessions" />;
  if (!block)
    return <Banner>Start a block first — the log pre-fills from the prescription.</Banner>;

  const session = sessions.find((s) => `${s.week}-${s.day}` === selected);

  return (
    <>
      <h1>Log</h1>
      {error && <Banner variant="error">{error}</Banner>}
      {saved !== null && <Banner>Logged {saved} sets.</Banner>}

      <section className="card">
        <label htmlFor="session">Session</label>
        <select
          id="session"
          value={selected}
          onChange={(e) => {
            const next = sessions.find((s) => `${s.week}-${s.day}` === e.target.value);
            if (next) selectSession(next);
          }}
        >
          {sessions.map((s) => (
            <option key={`${s.week}-${s.day}`} value={`${s.week}-${s.day}`}>
              {formatDate(s.date)} — week {s.week}, day {s.day}
            </option>
          ))}
        </select>
      </section>

      {session && (
        <section className="card">
          <h2>
            Week {session.week}, day {session.day}
          </h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Exercise</th>
                  <th>Prescribed</th>
                  <th className="num">Weight</th>
                  <th className="num">Reps</th>
                </tr>
              </thead>
              <tbody>
                {draft.map((row, i) => {
                  const prescribed = session.exercises
                    .find((e) => e.exercise === row.exercise)
                    ?.sets.map((s) => repLabel(s.reps));
                  return (
                    <tr key={`${row.exercise}-${i}`}>
                      <td>{row.exercise}</td>
                      <td className="muted">{prescribed?.join(" · ") || "—"}</td>
                      <td className="num">
                        <input
                          type="number"
                          step={block.units === "kg" ? 2.5 : 5}
                          min={0}
                          aria-label={`${row.exercise} set ${i + 1} weight`}
                          value={row.weight}
                          onChange={(e) => {
                            const next = [...draft];
                            next[i] = { ...row, weight: e.target.value };
                            setDraft(next);
                          }}
                        />
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          min={0}
                          aria-label={`${row.exercise} set ${i + 1} reps`}
                          value={row.reps}
                          onChange={(e) => {
                            const next = [...draft];
                            next[i] = { ...row, reps: e.target.value };
                            setDraft(next);
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: "var(--s4)" }}>
            <button className="primary" type="button" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Log this session"}
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Recent</h2>
        {recent.length === 0 ? (
          <p className="muted">Nothing logged yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Exercise</th>
                  <th className="num">Weight</th>
                  <th className="num">Reps</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((s, i) => (
                  // Index, not a composite of the data: several sets of the same
                  // exercise can share a timestamp AND a set index, and React
                  // silently drops the duplicates rather than rendering them.
                  <tr key={`${s.timestamp}-${s.exercise}-${i}`}>
                    <td>{s.timestamp.slice(0, 10)}</td>
                    <td>{s.exercise}</td>
                    <td className="num">{s.weight ?? "—"}</td>
                    <td className="num">{s.reps}</td>
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
