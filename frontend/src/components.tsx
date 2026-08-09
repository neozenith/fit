import type { PrescribedExercise, RepSpec, Session } from "@fit/program";
import type { ReactNode } from "react";

/** Render a rep target the way the source program writes it: `x6`, `x4-6`, `xMR`. */
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
  }
};

/** A max-reps set is a measurement, not an instruction — it must look different. */
const isMeasurement = (spec: RepSpec): boolean =>
  spec.kind === "maxReps" || spec.kind === "maxRepsCapped";

export const ExerciseRow = ({ exercise }: { exercise: PrescribedExercise }) => (
  <div className="exercise">
    <div>
      <strong>{exercise.exercise}</strong>
      {exercise.role !== "primary" && (
        <div className="muted" style={{ fontSize: "0.78rem" }}>
          {roleLabel(exercise.role)}
        </div>
      )}
    </div>
    <div>
      {exercise.sets.length === 0 ? (
        <span className="muted">work up to a comfortable weight</span>
      ) : (
        <div className="sets">
          {exercise.sets.map((set, i) => (
            <span
              // Sets have no identity of their own — index IS the identity here,
              // and the list is never reordered or filtered.
              key={`${exercise.exercise}-${i}`}
              className={`set${isMeasurement(set.reps) ? " set--measure" : ""}`}
            >
              {set.weight !== undefined ? `${set.weight} ` : ""}
              {repLabel(set.reps)}
            </span>
          ))}
        </div>
      )}
      {exercise.conditional && (
        <details style={{ marginTop: "0.35rem" }}>
          <summary className="muted" style={{ fontSize: "0.82rem", cursor: "pointer" }}>
            Depends on the max-reps result
          </summary>
          <ul className="muted" style={{ fontSize: "0.85rem", margin: "0.35rem 0 0 1rem" }}>
            {exercise.conditional.outcomes.map((o) => (
              <li key={o.description}>{o.description}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  </div>
);

const roleLabel = (role: PrescribedExercise["role"]): string =>
  ({
    primary: "primary",
    deadliftVariation: "deadlift variation",
    upperBackHorizontal: "upper back — horizontal pull",
    shoulder: "shoulders",
    upperBackVertical: "upper back — vertical pull",
    optional: "optional",
    optionalLower: "optional lower body",
  })[role];

export const SessionCard = ({ session }: { session: Session }) => (
  <section className="card" data-testid="session-card">
    <div className="session-header">
      <h3 style={{ margin: 0 }}>
        Week {session.week}, day {session.day}
      </h3>
      <span className="pill">{formatDate(session.date)}</span>
      {session.intensityLabel && (
        <span className="pill pill--accent">{session.intensityLabel}</span>
      )}
    </div>
    {session.exercises.map((exercise, i) => (
      <ExerciseRow key={`${exercise.exercise}-${i}`} exercise={exercise} />
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
