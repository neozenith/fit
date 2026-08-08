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

export const Loading = ({ what }: { what: string }) => (
  <p className="muted" role="status">
    Loading {what}…
  </p>
);

/**
 * A small multi-series line chart, drawn as inline SVG.
 *
 * Hand-drawn rather than charted with a library: the whole requirement is three
 * monotone-ish series over a date axis, and a charting dependency would be
 * larger than the entire rest of this bundle. Colours come from the theme's
 * categorical tokens so it inverts with everything else.
 */
export const LineChart = ({
  series,
  height = 220,
  yLabel = "",
}: {
  series: Array<{ name: string; colour: string; points: Array<{ date: string; value: number }> }>;
  height?: number;
  yLabel?: string;
}) => {
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return <p className="muted">Nothing logged yet.</p>;

  const width = 720;
  const pad = { top: 12, right: 12, bottom: 28, left: 44 };

  const times = all.map((p) => Date.parse(p.date));
  const values = all.map((p) => p.value);
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);

  // A flat series would otherwise divide by zero and render off-canvas. Padding
  // the range by 1 puts a single-value series in the middle of the plot, which
  // is the honest picture of "no change yet".
  const spanT = maxT - minT || 1;
  const spanV = maxV - minV || 1;

  const x = (date: string) =>
    pad.left + ((Date.parse(date) - minT) / spanT) * (width - pad.left - pad.right);
  const y = (value: number) =>
    height - pad.bottom - ((value - minV) / spanV) * (height - pad.top - pad.bottom);

  const ticks = [minV, minV + spanV / 2, maxV];

  return (
    <>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${series.map((s) => s.name).join(", ")} over time`}
        preserveAspectRatio="xMidYMid meet"
      >
        <title>{yLabel || "Progress"}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
            <text className="axis-label" x={4} y={y(t) + 3}>
              {Math.round(t * 10) / 10}
            </text>
          </g>
        ))}
        {series.map((s) => (
          <g key={s.name}>
            <polyline
              fill="none"
              stroke={s.colour}
              strokeWidth={2}
              strokeLinejoin="round"
              points={s.points.map((p) => `${x(p.date)},${y(p.value)}`).join(" ")}
            />
            {s.points.map((p, i) => (
              // Index, not `date-value`: two weeks with the same median produce
              // an identical composite key, and React silently drops the
              // duplicate point rather than plotting it.
              <circle
                key={`${s.name}-${i}`}
                cx={x(p.date)}
                cy={y(p.value)}
                r={2.5}
                fill={s.colour}
              />
            ))}
          </g>
        ))}
        <text className="axis-label" x={pad.left} y={height - 8}>
          {new Date(minT).toISOString().slice(0, 10)}
        </text>
        <text className="axis-label" x={width - pad.right} y={height - 8} textAnchor="end">
          {new Date(maxT).toISOString().slice(0, 10)}
        </text>
      </svg>
      {/* Colour is never the only channel carrying meaning — every series is
          named in the legend. */}
      <div className="legend">
        {series.map((s) => (
          <span key={s.name}>
            <i className="swatch" style={{ background: s.colour }} />
            {s.name}
          </span>
        ))}
      </div>
    </>
  );
};
