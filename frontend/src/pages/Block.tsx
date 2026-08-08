import {
  type BlockConfig,
  DEFAULT_ACCESSORIES,
  generateBlock,
  type LiftKey,
  type Session,
} from "@fit/program";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { Banner, formatDate, Loading, SessionCard } from "../components.jsx";

/**
 * The block page: view the whole six weeks, start a new block, and see what
 * the next one would be seeded with.
 *
 * The one-rep max inputs re-project the whole block AS YOU TYPE, in the
 * browser, using the same engine the server uses (ADR-0019). That instant
 * feedback is the single thing a spreadsheet did better than most web apps,
 * and it only works because there is exactly one implementation of the maths.
 */
export const BlockPage = () => {
  const [block, setBlock] = useState<BlockConfig | null>(null);
  const [serverSessions, setServerSessions] = useState<Session[]>([]);
  const [week, setWeek] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const [draft, setDraft] = useState({
    startDate: new Date().toISOString().slice(0, 10),
    units: "kg" as "kg" | "lb",
    bench: 40,
    squat: 70,
    deadlift: 80,
  });

  useEffect(() => {
    api
      .currentBlock()
      .then((r) => {
        setBlock(r.block);
        setServerSessions(r.sessions);
        if (r.block) {
          setDraft({
            startDate: r.block.startDate,
            units: r.block.units,
            bench: r.block.oneRepMax.bench,
            squat: r.block.oneRepMax.squat,
            deadlift: r.block.oneRepMax.deadlift,
          });
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  /**
   * The live preview. Recomputed on every keystroke — the engine is pure and
   * a whole block is ~22 sessions, so this costs microseconds and needs no
   * debounce, no request, and no loading state.
   */
  const preview = useMemo<Session[]>(
    () =>
      generateBlock({
        blockId: "preview",
        startDate: draft.startDate,
        units: draft.units,
        oneRepMax: { bench: draft.bench, squat: draft.squat, deadlift: draft.deadlift },
        accessories: block?.accessories ?? DEFAULT_ACCESSORIES,
      }),
    [draft, block?.accessories],
  );

  const dirty =
    block !== null &&
    (block.oneRepMax.bench !== draft.bench ||
      block.oneRepMax.squat !== draft.squat ||
      block.oneRepMax.deadlift !== draft.deadlift ||
      block.units !== draft.units ||
      block.startDate !== draft.startDate);

  const shown = dirty || !block ? preview : serverSessions;
  const weekSessions = shown.filter((s) => s.week === week);

  const createBlock = async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await api.createBlock({
        startDate: draft.startDate,
        units: draft.units,
        oneRepMax: { bench: draft.bench, squat: draft.squat, deadlift: draft.deadlift },
        ...(block ? { derivedFrom: block.blockId } : {}),
      });
      setBlock(created.block);
      setServerSessions(generateBlock(created.block));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  if (loading) return <Loading what="your block" />;

  return (
    <>
      <h1>Block</h1>
      {error && <Banner variant="error">{error}</Banner>}

      <section className="card">
        <h2>Seed values</h2>
        <p className="muted">
          Every weight in the six weeks below is projected from these three numbers. Change one and
          watch the whole block move.
        </p>
        <div className="row">
          <div className="field">
            <label htmlFor="startDate">Start date</label>
            <input
              id="startDate"
              type="date"
              value={draft.startDate}
              onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="units">Units</label>
            <select
              id="units"
              value={draft.units}
              onChange={(e) => setDraft({ ...draft, units: e.target.value as "kg" | "lb" })}
            >
              <option value="kg">kilograms</option>
              <option value="lb">pounds</option>
            </select>
          </div>
          {(["squat", "bench", "deadlift"] as LiftKey[]).map((lift) => (
            <div className="field" key={lift}>
              <label htmlFor={lift} style={{ textTransform: "capitalize" }}>
                {lift} 1RM
              </label>
              <input
                id={lift}
                type="number"
                min={1}
                max={1000}
                step={draft.units === "kg" ? 2.5 : 5}
                value={draft[lift]}
                onChange={(e) => setDraft({ ...draft, [lift]: Number(e.target.value) })}
              />
            </div>
          ))}
          <button className="primary" type="button" onClick={createBlock} disabled={creating}>
            {creating ? "Saving…" : block ? "Start a new block" : "Start block"}
          </button>
        </div>
        {dirty && (
          <Banner>
            You are previewing unsaved values. Nothing has been written — starting a new block
            creates a fresh record rather than editing this one, so your history stays intact.
          </Banner>
        )}
      </section>

      <section className="card">
        <div className="session-header">
          <h2 style={{ margin: 0 }}>Week {week}</h2>
          <span className="pill">{shown.find((s) => s.week === week)?.weekTitle}</span>
        </div>
        <div className="nav" style={{ marginBottom: "var(--s3)" }}>
          {[1, 2, 3, 4, 5].map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWeek(w)}
              aria-current={w === week ? "page" : undefined}
            >
              Week {w}
            </button>
          ))}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {weekSessions.length} sessions, {weekSessions[0] ? formatDate(weekSessions[0].date) : ""}{" "}
          onward.
        </p>
      </section>

      {weekSessions.map((s) => (
        <SessionCard key={`${s.week}-${s.day}`} session={s} />
      ))}

      <section className="card">
        <h2>Week 6 — three ways forward</h2>
        <p className="muted">
          Week 5's single set of 1-4 reps at 97.5% is the measurement the next block is built from.
          Multiply what you lifted by 1.03 for two reps, 1.06 for three, 1.09 for four.
        </p>
        <ul>
          <li>
            <strong>Skip</strong> — take the projection and start the next block now.
          </li>
          <li>
            <strong>Deload</strong> — take the projection, but repeat week 1's loads first.
          </li>
          <li>
            <strong>Test</strong> — spend the week finding a true one-rep max.
          </li>
        </ul>
      </section>
    </>
  );
};
