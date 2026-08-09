import type { BlockConfig, Session } from "@fit/program";
import { useEffect, useState } from "react";
import { api, type BlockProgress } from "../api.js";
import { Banner, formatDate, formatShortDate, Loading, repLabel } from "../components.jsx";

/**
 * The block at a glance: six weeks, colour-coded, with what is done.
 *
 * This replaced a page that showed only today's prescription, which answered
 * the least useful question. "Have I got a block? which week am I in? what have
 * I actually completed?" are the things you need before deciding whether to
 * train, and none of them were visible anywhere.
 *
 * Completion is DERIVED from logged sets (ADR-0001) — a set carries its own
 * block, week and day, so a session is done when its prescribed exercises have
 * sets against them. Nothing stores a "completed" flag that could disagree with
 * the log.
 */

type SessionState = "done" | "partial" | "todo" | "future";

const STATE_LABEL: Record<SessionState, string> = {
  done: "Complete",
  partial: "In progress",
  todo: "Not started",
  future: "Upcoming",
};

/**
 * Which exercises count toward "done".
 *
 * Only those with prescribed SETS. A session's notes and its conditional rules
 * are instructions, not work, and counting them would make every session
 * permanently incomplete.
 */
const countable = (session: Session): string[] =>
  session.exercises.filter((e) => e.sets.length > 0).map((e) => e.exercise);

const stateOf = (session: Session, progress: BlockProgress, today: string): SessionState => {
  const logged = progress[`${session.week}-${session.day}`] ?? {};
  const expected = countable(session);
  // Complete means every prescribed SET is logged, not merely that the exercise
  // was touched. Counting exercises marked a session done after one set of four.
  const done = session.exercises.filter(
    (e) => e.sets.length > 0 && (logged[e.exercise]?.length ?? 0) >= e.sets.length,
  ).length;
  const touched = expected.filter((name) => (logged[name]?.length ?? 0) > 0).length;

  if (expected.length > 0 && done >= expected.length) return "done";
  if (touched > 0) return "partial";
  return session.date > today ? "future" : "todo";
};

export const OverviewPage = () => {
  const [block, setBlock] = useState<BlockConfig | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [progress, setProgress] = useState<BlockProgress>({});
  const [blockCount, setBlockCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .currentBlock()
      .then((r) => {
        setBlock(r.block);
        setSessions(r.sessions);
        setProgress(r.progress ?? {});
        setBlockCount(r.blockCount ?? 0);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (error) return <Banner variant="error">{error}</Banner>;
  if (loading) return <Loading what="your block" />;

  // The FIRST screen anyone sees, because it is the default route and a fresh
  // account has no block. It has to teach the program in a paragraph and give
  // exactly one thing to do — "you have no training block yet" states a fact
  // and leaves the reader stuck.
  if (!block) return <NewStarter hasHistory={blockCount > 0} />;

  const today = new Date().toISOString().slice(0, 10);
  const weeks = [...new Set(sessions.map((s) => s.week))].sort((a, b) => a - b);

  const currentWeek = sessions.find((s) => s.date >= today)?.week ?? weeks.at(-1) ?? 1;

  const done = sessions.filter((s) => stateOf(s, progress, today) === "done").length;
  const next = sessions.find((s) => stateOf(s, progress, today) !== "done");

  return (
    <>
      <h1>Overview</h1>
      <p className="muted">
        Block starting {formatDate(block.startDate)} · {block.units} · {done}/{sessions.length}{" "}
        sessions complete
        {blockCount > 1 && <> · {blockCount} blocks recorded</>}
      </p>

      <section className="card">
        <div className="row">
          <div>
            {/* One line, because the flex row squeezes this column and a
                wrapped label reads as a rendering fault rather than as prose. */}
            <div className="muted nowrap">Seed maxes · squat / bench / deadlift</div>
            <div className="stat-value mono">
              {block.oneRepMax.squat} / {block.oneRepMax.bench} / {block.oneRepMax.deadlift}
              {block.units}
            </div>
          </div>
          <div className="spacer" />
          <a className="button" href="/block-inputs">
            Edit or replace this block
          </a>
        </div>
        {next && (
          <p>
            Next up:{" "}
            <strong>
              Week {next.week}, day {next.day}
            </strong>{" "}
            on {formatDate(next.date)}.{" "}
            <a href={`/log?week=${next.week}&day=${next.day}`}>Log it</a>.
          </p>
        )}
      </section>

      {/* A calendar rather than a list. Six weeks × up to five days is a shape,
          and seeing the shape is what tells you a whole week went missing —
          which a chronological list of sessions never does. */}
      <section className="card">
        <h2>Six weeks</h2>
        <div className="calendar">
          {weeks.map((week) => {
            const weekSessions = sessions.filter((s) => s.week === week);
            const title = weekSessions[0]?.weekTitle ?? "";
            return (
              <div
                key={week}
                className={`calendar__week${week === currentWeek ? " calendar__week--current" : ""}`}
              >
                <div className="calendar__label">
                  <strong>Week {week}</strong>
                  <span className="muted">{title}</span>
                </div>
                <div className="calendar__days">
                  {weekSessions.map((session) => {
                    const state = stateOf(session, progress, today);
                    const logged = progress[`${session.week}-${session.day}`] ?? {};
                    const expected = countable(session);
                    const hit = session.exercises.filter(
                      (e) =>
                        e.sets.length > 0 && (logged[e.exercise]?.length ?? 0) >= e.sets.length,
                    ).length;
                    return (
                      <a
                        key={`${session.week}-${session.day}`}
                        className={`day day--${state}`}
                        href={`/log?week=${session.week}&day=${session.day}`}
                        title={`${STATE_LABEL[state]} — ${hit}/${expected.length} exercises`}
                      >
                        <span className="day__date">{formatShortDate(session.date)}</span>
                        <span className="day__name">Day {session.day}</span>
                        <span className="day__meta">
                          {hit}/{expected.length}
                        </span>
                      </a>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <ul className="legend-list">
          {(Object.keys(STATE_LABEL) as SessionState[]).map((state) => (
            <li key={state}>
              <span className={`swatch swatch--${state}`} aria-hidden="true" />
              {STATE_LABEL[state]}
            </li>
          ))}
        </ul>
      </section>

      {next && (
        <section className="card">
          <h2>
            Next session — week {next.week}, day {next.day}
          </h2>
          <p className="muted">
            {next.intensityLabel ? `${next.intensityLabel} · ` : ""}
            {formatDate(next.date)}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Exercise</th>
                  <th>Prescribed</th>
                </tr>
              </thead>
              <tbody>
                {next.exercises.map((exercise) => (
                  <tr key={exercise.exercise}>
                    <td>{exercise.exercise}</td>
                    <td className="mono">
                      {exercise.sets.length === 0
                        ? "—"
                        : exercise.sets
                            .map(
                              (set) =>
                                `${set.weight !== undefined ? `${set.weight}${block.units} ` : ""}${repLabel(set.reps)}`,
                            )
                            .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            <a className="button button--primary" href={`/log?week=${next.week}&day=${next.day}`}>
              Log this session
            </a>
          </p>
        </section>
      )}
    </>
  );
};

/**
 * What a new account sees.
 *
 * Three things, in order: what the program IS, what one number means, and the
 * single next action. This is the default route, so it is the first screen
 * anyone meets — "you have no training block yet" states a fact and leaves the
 * reader stuck, which is what it replaced.
 */
const NewStarter = ({ hasHistory }: { hasHistory: boolean }) => (
  <>
    <h1>Start here</h1>
    <p className="muted">
      This runs the Candito 6-Week Strength Program. Six weeks of squat, bench and deadlift work,
      projected from three numbers — nothing is prescribed until you supply them.
    </p>

    <section className="card">
      <h2>How it works</h2>
      <ol className="steps">
        <li>
          <div>
            <strong>Give it three one-rep maxes.</strong>
            <p className="muted">
              What you could lift once today for squat, bench and deadlift. An estimate is fine —
              week 5 measures you properly and the next block corrects itself from that.
            </p>
          </div>
        </li>
        <li>
          <div>
            <strong>Train the sessions it prescribes.</strong>
            <p className="muted">
              Every weight is computed from those three numbers, never stored. Change a max and the
              whole block moves with it.
            </p>
          </div>
        </li>
        <li>
          <div>
            <strong>Tick each set off as you do it.</strong>
            <p className="muted">
              One tap per set. The rows you have not ticked are how you find your place after a
              superset.
            </p>
          </div>
        </li>
        <li>
          <div>
            <strong>Week 5 seeds the next block.</strong>
            <p className="muted">
              A single heavy set of one to four reps becomes the input to the following six weeks.
              The program is a loop, not a one-off.
            </p>
          </div>
        </li>
      </ol>
      <p>
        <a className="button button--primary" href="/block-inputs">
          Set your inputs
        </a>
      </p>
    </section>

    <section className="card">
      <h2>While you are here</h2>
      <p className="muted">
        {hasHistory
          ? "You have blocks on record but none running — the inputs page starts a new one from your most recent estimates."
          : "Nothing is logged yet, so most pages will be empty until you train. These work from day one."}
      </p>
      <ul className="linklist">
        <li>
          <a href="/exercises">Exercises</a>{" "}
          <span className="muted">— every movement the app knows about.</span>
        </li>
        <li>
          <a href="/measurements">Body</a>{" "}
          <span className="muted">— record a weigh-in without a block.</span>
        </li>
        <li>
          <a href="/history">History</a>{" "}
          <span className="muted">— five years imported from the tracker this replaces.</span>
        </li>
      </ul>
    </section>
  </>
);
