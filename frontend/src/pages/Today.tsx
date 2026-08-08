import type { BlockConfig, Session } from "@fit/program";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Banner, formatDate, Loading, SessionCard } from "../components.jsx";

/**
 * The landing page: the next session, and enough context to know where in the
 * block it sits.
 *
 * "Next" rather than "today" because training days are irregular — the program
 * runs five days one week and three the next, so most days have no session and
 * a page that said "nothing today" would be right and useless.
 */
export const TodayPage = () => {
  const [block, setBlock] = useState<BlockConfig | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .currentBlock()
      .then((r) => {
        setBlock(r.block);
        setSessions(r.sessions);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading what="your block" />;
  if (error) return <Banner variant="error">{error}</Banner>;

  if (!block) {
    return (
      <Banner>
        No block yet. Head to <strong>Block</strong> to enter your one-rep maxes and start one — the
        whole six weeks is projected from three numbers.
      </Banner>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = sessions.filter((s) => s.date >= today);
  const next = upcoming[0];
  const past = sessions.filter((s) => s.date < today);
  const completed = past.length;

  return (
    <>
      <h1>{next ? "Next session" : "Block complete"}</h1>

      <section className="card">
        <div className="session-header">
          <h2 style={{ margin: 0 }}>Block starting {formatDate(block.startDate)}</h2>
          <span className="pill">{block.units}</span>
          {block.derivedFrom && <span className="pill">projected from the previous block</span>}
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Lift</th>
                <th className="num">One-rep max</th>
              </tr>
            </thead>
            <tbody>
              {(["squat", "bench", "deadlift"] as const).map((lift) => (
                <tr key={lift}>
                  <td style={{ textTransform: "capitalize" }}>{lift}</td>
                  <td className="num">
                    {block.oneRepMax[lift]} {block.units}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginBottom: 0, marginTop: "var(--s3)" }}>
          {completed} of {sessions.length} sessions are in the past.
        </p>
      </section>

      {next ? (
        <SessionCard session={next} />
      ) : (
        <Banner>
          Every session in this block has passed. Log your week 5 results on the{" "}
          <strong>Block</strong> page to see what the next block would be seeded with.
        </Banner>
      )}

      {upcoming.length > 1 && (
        <>
          <h2>Coming up</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Week</th>
                  <th>Phase</th>
                  <th>Opens with</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.slice(1, 8).map((s) => (
                  <tr key={`${s.week}-${s.day}`}>
                    <td>{formatDate(s.date)}</td>
                    <td className="num">{s.week}</td>
                    <td className="muted">{s.weekTitle}</td>
                    <td>{s.exercises[0]?.exercise ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
};
