import { type ExerciseGroup, groupByExercise, type RepSpec, type Session } from "@fit/program";
import type { ReactNode } from "react";

/** Render a rep target the way the source programs write it: `x6`, `x4-6`, `xMR`. */
export const repLabel = (spec: RepSpec): string => {
  switch (spec.kind) {
    case "fixed":
      return `x${spec.reps}`;
    case "range":
      return `x${spec.min}-${spec.max}`;
    case "maxReps":
      return "xMR";
    case "maxRepsCapped":
      return `xMR${spec.cap}`;
    case "unprescribed":
      return "";
  }
};

/**
 * A max-reps set is a MEASUREMENT, not an instruction — it must look different.
 *
 * Every feedback rule in every program keys off one of these, so a set the
 * program is listening to has to be visually distinct from one it is dictating.
 */
const isMeasurement = (spec: RepSpec): boolean =>
  spec.kind === "maxReps" || spec.kind === "maxRepsCapped";

/**
 * One exercise's prescribed sets.
 *
 * Takes a GROUP rather than a session slice: a session is a flat list of one
 * activity per set, and grouping it is a view (`groupByExercise`) rather than a
 * stored shape.
 */
export const ExerciseRow = ({ group }: { group: ExerciseGroup }) => {
  const unprescribed = group.activities.every((a) => a.reps.kind === "unprescribed");
  const conditional = group.activities.find((a) => a.conditional)?.conditional;

  return (
    <div className="exercise">
      <div>
        <strong>{group.exercise}</strong>
        {group.role && group.role !== "primary" && (
          <div className="muted" style={{ fontSize: "0.78rem" }}>
            {roleLabel(group.role)}
          </div>
        )}
      </div>
      <div>
        {unprescribed ? (
          <span className="muted">work up to a comfortable weight</span>
        ) : (
          <div className="sets">
            {group.activities.map((activity) => (
              <span
                key={`${group.exercise}-${activity.setIndex}`}
                className={`set${isMeasurement(activity.reps) ? " set--measure" : ""}`}
              >
                {activity.weight !== undefined ? `${activity.weight} ` : ""}
                {repLabel(activity.reps)}
              </span>
            ))}
          </div>
        )}
        {group.note && (
          <div className="muted" style={{ fontSize: "0.78rem", marginTop: "0.25rem" }}>
            {group.note}
          </div>
        )}
        {conditional && (
          <details style={{ marginTop: "0.35rem" }}>
            <summary className="muted" style={{ fontSize: "0.82rem", cursor: "pointer" }}>
              Depends on the max-reps result
            </summary>
            <ul className="muted" style={{ fontSize: "0.85rem", margin: "0.35rem 0 0 1rem" }}>
              {conditional.outcomes.map((o) => (
                <li key={o.description}>{o.description}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
};

/**
 * What a slot is FOR.
 *
 * A lookup with a fallback rather than an exhaustive record, because roles are
 * open now: a custom plan may carry any role string its author typed, and an
 * exhaustive map would either reject it at the type level or render `undefined`.
 */
const ROLE_LABELS: Record<string, string> = {
  primary: "primary",
  deadliftVariation: "deadlift variation",
  upperBackHorizontal: "upper back — horizontal pull",
  shoulder: "shoulders",
  upperBackVertical: "upper back — vertical pull",
  optional: "optional",
  optionalLower: "optional lower body",
  assistance: "assistance",
};

const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role;

export const SessionCard = ({ session }: { session: Session }) => (
  <section className="card" data-testid="session-card">
    <div className="session-header">
      <h3 style={{ margin: 0 }}>{session.name}</h3>
      <span className="pill">{formatDate(session.date)}</span>
      <span className="pill">
        W{session.week}D{session.day}
      </span>
      {session.intensityLabel && (
        <span className="pill pill--accent">{session.intensityLabel}</span>
      )}
    </div>
    {groupByExercise(session.activities).map((group) => (
      <ExerciseRow key={group.exercise} group={group} />
    ))}
    {session.notes.length > 0 && (
      <ul className="muted" style={{ fontSize: "0.85rem", marginBottom: 0 }}>
        {session.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    )}
  </section>
);

export const formatDate = (iso: string): string => {
  // Parsed as UTC and formatted in UTC. A date-only string parsed as local time
  // shifts a day backwards for anyone west of Greenwich, and this application's
  // user is as far east as it gets.
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
};

export const Banner = ({
  children,
  variant = "info",
}: {
  children: ReactNode;
  variant?: "info" | "error";
}) => <div className={`banner${variant === "error" ? " banner--error" : ""}`}>{children}</div>;

/**
 * `<output>` rather than `<p role="status">`.
 *
 * It carries the same implicit live-region semantics natively, so a screen
 * reader announces the change without an ARIA attribute that could drift out of
 * sync with the element it sits on.
 */
export const Loading = ({ what }: { what: string }) => (
  <output className="muted">Loading {what}…</output>
);

/**
 * `08-Aug` — day then abbreviated month.
 *
 * `MM-DD` was ambiguous to anyone who reads dates day-first, which is most of
 * the world and specifically this application's user: `08-09` could be the
 * eighth of September or the ninth of August. An abbreviated month name cannot
 * be misread in either direction, and it costs one character.
 */
export const formatShortDate = (iso: string): string => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
};
