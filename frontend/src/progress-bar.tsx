import type { Session } from "@fit/program";
import { useEffect, useState } from "react";
import { api, type BlockProgress } from "./api.js";

/**
 * Three progress bars in the header: block, week, session.
 *
 * They answer the three questions that are always live while training and were
 * previously only obtainable by navigating somewhere — how far through the
 * BLOCK am I, how far through this WEEK, and how far through the session in
 * front of me. Putting them in the global header means the answer follows you
 * onto the cost page and the history charts, which is the point: it is context,
 * not content.
 *
 * Equal thirds, deliberately. They are different denominators — 21 sessions, 5
 * sessions, 6 exercises — so any shared scale would be a lie. Equal widths say
 * "three separate fractions" rather than implying one is bigger than another.
 */

interface Progress {
  label: string;
  done: number;
  total: number;
  detail: string;
}

/** A session counts as complete when every prescribed SET is logged. */
const isComplete = (session: Session, progress: BlockProgress): boolean => {
  const expected = session.exercises.filter((e) => e.sets.length > 0);
  return (
    expected.length > 0 &&
    expected.every(
      (e) =>
        (progress[`${session.week}-${session.day}`]?.[e.exercise]?.length ?? 0) >= e.sets.length,
    )
  );
};

export const HeaderProgress = () => {
  const [bars, setBars] = useState<Progress[] | null>(null);

  useEffect(() => {
    api
      .currentBlock()
      .then((r) => {
        if (!r.block || r.sessions.length === 0) return;
        const progress = r.progress ?? {};
        const today = new Date().toISOString().slice(0, 10);

        // The session in front of you is the first INCOMPLETE one, not the one
        // dated today: a session skipped on Monday is still the next thing to
        // do on Wednesday, and "today's session" would show an empty bar for a
        // rest day while hiding the work still outstanding.
        const current = r.sessions.find((s) => !isComplete(s, progress)) ?? r.sessions.at(-1);
        if (!current) return;

        const inWeek = r.sessions.filter((s) => s.week === current.week);
        const exercises = current.exercises.filter((e) => e.sets.length > 0);
        const setsDone = exercises.reduce(
          (n, e) =>
            n +
            Math.min(
              e.sets.length,
              progress[`${current.week}-${current.day}`]?.[e.exercise]?.length ?? 0,
            ),
          0,
        );
        const setsTotal = exercises.reduce((n, e) => n + e.sets.length, 0);

        setBars([
          {
            label: "Block",
            done: r.sessions.filter((s) => isComplete(s, progress)).length,
            total: r.sessions.length,
            detail: `sessions · week ${current.week} of ${Math.max(
              ...r.sessions.map((s) => s.week),
            )}`,
          },
          {
            label: `Week ${current.week}`,
            done: inWeek.filter((s) => isComplete(s, progress)).length,
            total: inWeek.length,
            detail: current.date <= today ? "sessions" : "sessions · not started",
          },
          {
            label: `W${current.week}D${current.day}`,
            done: setsDone,
            total: setsTotal,
            // SETS, not exercises. The session bar has to move as you tick, or
            // it says nothing during the one activity it exists for.
            detail: "sets",
          },
        ]);
      })
      // A header ornament must never take the page down with it. Its absence is
      // self-explanatory; an error banner across the top of every page is not.
      .catch(() => setBars(null));
  }, []);

  if (!bars) return null;

  return (
    // A `section`, not a bare `div`: `aria-label` needs a role to attach to,
    // and a labelled region is what this actually is.
    <section className="header-progress" aria-label="Progress">
      {bars.map((bar) => {
        const pct = bar.total > 0 ? Math.round((bar.done / bar.total) * 100) : 0;
        return (
          <div
            key={bar.label}
            className="header-progress__item"
            title={`${bar.label}: ${bar.done} of ${bar.total} ${bar.detail}`}
          >
            <div className="header-progress__label">
              <span>{bar.label}</span>
              <span className="mono">
                {bar.done}/{bar.total}
              </span>
            </div>
            {/* A native `progress` element: it carries the semantics, the value
                and the maximum without any ARIA, and a screen reader announces
                a percentage from it for free. */}
            <progress className="header-progress__bar" value={bar.done} max={bar.total || 1}>
              {pct}%
            </progress>
          </div>
        );
      })}
    </section>
  );
};
