import {
  blockLabel,
  generateBlock,
  type Session,
  sessionCompletion,
  sessionRef,
  sessionState,
} from "@fit/program";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type BlockProgress, type BlockSummary } from "../api.js";
import { Banner, formatDate, formatShortDate, Loading } from "../components.jsx";
import { useQueryParam } from "../router.jsx";

/**
 * Every block, past and planned, on one timeline.
 *
 * The previous version could show exactly one block — the live one — which made
 * three ordinary questions unanswerable: what did I do last quarter, do these
 * two blocks overlap, and what have I planned. A single-block page also had no
 * way to express a FUTURE block at all, so planning happened outside the app.
 *
 * Blocks are identified by their start date (ADR-0033), so `B-20270810` sorts
 * chronologically without a comparator and a session is `B-20270810-W5D1`.
 * Overlap is therefore a visual fact rather than something to work out from two
 * start dates: bars that intersect are blocks that intersect.
 */

type SessionState = "done" | "partial" | "todo" | "future";

const STATE_LABEL: Record<SessionState, string> = {
  done: "Complete",
  partial: "In progress",
  todo: "Not started",
  future: "Upcoming",
};

const DAY_MS = 86_400_000;

/** The log for one session, keyed by exercise. */
const logFor = (session: Session, progress: BlockProgress) =>
  progress[`${session.week}-${session.day}`] ?? {};

const SPANS = [
  { value: "quarter", label: "3 months" },
  { value: "year", label: "12 months" },
  { value: "all", label: "All" },
];

export const OverviewPage = () => {
  const [summaries, setSummaries] = useState<BlockSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [selectedId, setSelected] = useQueryParam("block", "");
  const [span, setSpan] = useQueryParam("span", "year");
  const [showDeleted, setShowDeleted] = useQueryParam("deleted", "");

  const load = useCallback(
    (includeDeleted: boolean) => api.blocks(includeDeleted).then((all) => setSummaries(all.blocks)),
    [],
  );

  useEffect(() => {
    load(showDeleted === "true").catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [load, showDeleted]);

  const act = async (blockId: string, action: "delete" | "restore" | "reset") => {
    setBusy(blockId);
    setError(null);
    setConfirming(null);
    try {
      await api.setBlockState(blockId, action);
      await load(showDeleted === "true");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (error) return <Banner variant="error">{error}</Banner>;
  if (!summaries) return <Loading what="your blocks" />;
  if (summaries.length === 0) return <NewStarter />;

  const today = new Date().toISOString().slice(0, 10);

  // A year by default, because that is the unit a training plan is thought in
  // and because the hot window is thirteen months (ADR-0012) — asking for more
  // would silently return less.
  const months = span === "all" ? 0 : span === "quarter" ? 3 : 12;
  const cutoff =
    months === 0 ? "" : new Date(Date.now() - months * 30 * DAY_MS).toISOString().slice(0, 10);
  const visible = summaries.filter((s) => months === 0 || s.lastDate >= cutoff);

  const live = visible.filter((s) => s.block.startDate <= today).at(-1) ?? visible.at(0);
  const selected = visible.find((s) => s.block.blockId === selectedId) ?? live;

  // The timeline's axis: earliest start to latest finish across what is shown.
  const from = visible.reduce((min, s) => (s.firstDate < min ? s.firstDate : min), "9999-12-31");
  const to = visible.reduce((max, s) => (s.lastDate > max ? s.lastDate : max), "0000-01-01");
  const axisFrom = Date.parse(from);
  const axisSpan = Math.max(1, Date.parse(to) - axisFrom);
  const position = (date: string) => ((Date.parse(date) - axisFrom) / axisSpan) * 100;

  const totalSessions = visible.reduce((n, s) => n + s.sessionCount, 0);
  const totalDone = visible.reduce((n, s) => n + s.completeCount, 0);

  return (
    <>
      <h1>Overview</h1>
      <p className="muted">
        {visible.length} block{visible.length === 1 ? "" : "s"} · {totalDone}/{totalSessions}{" "}
        sessions complete · {formatDate(from)} to {formatDate(to)}
      </p>

      <section className="card">
        <div className="row">
          {/* A real fieldset/legend, like every other filter group in the app.
              A div with role="group" carries the same meaning through an ARIA
              attribute that can drift from the element it describes. */}
          <fieldset className="field">
            <legend className="field__label">Timeline span</legend>
            <div className="segmented">
              {SPANS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={span === option.value}
                  onClick={() => setSpan(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="field">
            <legend className="field__label">Deleted</legend>
            <div className="segmented">
              {[
                { value: "", label: "Hidden" },
                { value: "true", label: "Shown" },
              ].map((option) => (
                <button
                  key={option.value || "hidden"}
                  type="button"
                  aria-pressed={showDeleted === option.value}
                  onClick={() => setShowDeleted(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="spacer" />
          <a className="button" href="/block-inputs">
            Plan a block
          </a>
        </div>

        <div className="timeline">
          {visible.map((summary) => {
            const left = position(summary.firstDate);
            const width = Math.max(1.5, position(summary.lastDate) - left);
            const pct = summary.sessionCount
              ? Math.round((summary.completeCount / summary.sessionCount) * 100)
              : 0;
            const future = summary.firstDate > today;
            const active = summary.block.blockId === selected?.block.blockId;

            return (
              <button
                key={summary.block.blockId}
                type="button"
                className={`timeline__row${active ? " timeline__row--active" : ""}${summary.deleted ? " timeline__row--deleted" : ""}`}
                aria-pressed={active}
                title={`${blockLabel(summary.block.blockId)} — ${formatDate(summary.firstDate)} to ${formatDate(summary.lastDate)}, ${summary.completeCount}/${summary.sessionCount} sessions${summary.supersededCount > 0 ? `, ${summary.supersededCount} earlier version${summary.supersededCount === 1 ? "" : "s"}` : ""}`}
                onClick={() => setSelected(summary.block.blockId)}
              >
                <span className="timeline__label mono">{blockLabel(summary.block.blockId)}</span>
                <span className="timeline__track">
                  <span
                    className={`timeline__bar${future ? " timeline__bar--future" : ""}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  >
                    <span className="timeline__fill" style={{ width: `${pct}%` }} />
                  </span>
                </span>
                <span className="timeline__meta mono">
                  {summary.completeCount}/{summary.sessionCount}
                </span>
              </button>
            );
          })}
        </div>
        <div className="timeline__axis muted mono">
          <span>{formatShortDate(from)}</span>
          <span>{formatShortDate(to)}</span>
        </div>

        {visible.some((s) => s.supersededCount > 0) && (
          <p className="muted">
            Some blocks have earlier versions on record. Nothing is edited in place, so every
            version a block has ever had stays queryable (ADR-0029).
          </p>
        )}
      </section>

      {selected && (
        <BlockDetail
          summary={selected}
          today={today}
          busy={busy === selected.block.blockId}
          confirming={confirming === selected.block.blockId}
          onConfirm={() => setConfirming(selected.block.blockId)}
          onCancel={() => setConfirming(null)}
          onAct={(action) => act(selected.block.blockId, action)}
        />
      )}
    </>
  );
};

/**
 * One block's six weeks — generated in the browser, for ANY block.
 *
 * `generateBlock` is a pure function of the block's seed values (ADR-0001) and
 * the same module the server runs (ADR-0019), so a historical or planned block
 * costs one function call rather than a request. An earlier version only had
 * the LIVE block's sessions in hand and showed a paragraph of summary for every
 * other one, which made the timeline's rows selectable but not inspectable.
 */
const BlockDetail = ({
  summary,
  today,
  busy,
  confirming,
  onConfirm,
  onCancel,
  onAct,
}: {
  summary: BlockSummary;
  today: string;
  busy: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onAct: (action: "delete" | "restore" | "reset") => void;
}) => {
  const { block, progress } = summary;
  const sessions = useMemo(() => {
    try {
      return generateBlock(block);
    } catch {
      // A block written before a schema change could fail to generate. A
      // paragraph beats an error boundary taking the whole page down.
      return [] as Session[];
    }
  }, [block]);

  const weeks = [...new Set(sessions.map((s) => s.week))].sort((a, b) => a - b);
  const currentWeek = sessions.find((s) => s.date >= today)?.week ?? weeks.at(-1) ?? 1;

  return (
    <section className="card">
      <h2>
        {/* The full identifier stays in the title, so an abbreviated legacy
            UUID is still copyable and still unambiguous on inspection. */}
        <span className="mono" title={block.blockId}>
          {blockLabel(block.blockId)}
        </span>
        <span className="muted">
          {" "}
          · from {formatDate(block.startDate)} · seeds {block.oneRepMax.squat}/
          {block.oneRepMax.bench}/{block.oneRepMax.deadlift}
          {block.units}
        </span>
      </h2>

      {/* Manage the block from the block itself, rather than from a menu
          somewhere else: the thing you are about to delete is on screen, with
          its dates and its completion, which is most of what a confirmation
          dialog would otherwise have to restate. */}
      <div className="row block-actions">
        {summary.deleted ? (
          <>
            <span className="pill">deleted</span>
            <button type="button" disabled={busy} onClick={() => onAct("restore")}>
              {busy ? "Working…" : "Restore"}
            </button>
          </>
        ) : confirming ? (
          <>
            <span className="muted">
              Delete {blockLabel(block.blockId)}? Its logged sets are kept and it can be restored.
            </span>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => onAct("delete")}
            >
              {busy ? "Working…" : "Yes, delete"}
            </button>
            <button type="button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => onAct("reset")}>
              Reset progress
            </button>
            <button type="button" disabled={busy} onClick={onConfirm}>
              Delete
            </button>
            {summary.resetAt && (
              <span className="muted">
                Reset {formatDate(summary.resetAt.slice(0, 10))} — earlier sets are kept but no
                longer counted.
              </span>
            )}
          </>
        )}
      </div>

      {sessions.length === 0 ? (
        <p className="muted">
          {summary.completeCount}/{summary.sessionCount} sessions complete,{" "}
          {formatDate(summary.firstDate)} to {formatDate(summary.lastDate)}. This block's
          prescription could not be regenerated from its stored inputs.
        </p>
      ) : (
        <>
          <div className="calendar">
            {weeks.map((week) => {
              const weekSessions = sessions.filter((s) => s.week === week);
              return (
                <div
                  key={week}
                  className={`calendar__week${week === currentWeek ? " calendar__week--current" : ""}`}
                >
                  <div className="calendar__label">
                    <strong>Week {week}</strong>
                    <span className="muted">{weekSessions[0]?.weekTitle ?? ""}</span>
                  </div>
                  <div className="calendar__days">
                    {weekSessions.map((session) => {
                      const log = logFor(session, progress);
                      const state = sessionState(session, log, today);
                      const { done, total } = sessionCompletion(session, log);
                      const ref = sessionRef(block.blockId, session.week, session.day);
                      return (
                        <a
                          key={ref}
                          className={`day day--${state}`}
                          href={`/log?week=${session.week}&day=${session.day}`}
                          // The session reference is both the tooltip and the
                          // thing to quote when talking about one session.
                          title={`${ref} — ${STATE_LABEL[state]}, ${done}/${total} exercises`}
                        >
                          <span className="day__date">{formatShortDate(session.date)}</span>
                          <span className="day__name">Day {session.day}</span>
                          <span className="day__meta">
                            {done}/{total}
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
        </>
      )}
    </section>
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
const NewStarter = () => (
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
        Nothing is logged yet, so most pages will be empty until you train. These work from day one.
      </p>
      <ul className="linklist">
        <li>
          <a href="/exercises">Exercises</a>{" "}
          <span className="muted">
            — every movement the app knows about, and where you curate it.
          </span>
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
