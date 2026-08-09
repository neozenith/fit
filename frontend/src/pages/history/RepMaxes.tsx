import { useEffect, useState } from "react";
import { api, type HistoryRepMax } from "../../api.js";
import { useCatalogue } from "../../catalogue.js";
import { Banner, Loading } from "../../components.jsx";
import { Segmented, SelectFilter } from "../../filters.jsx";
import { useQueryParam } from "../../router.jsx";

/**
 * Heaviest load moved for at least N reps, per exercise.
 *
 * "At least" is the point, and it is where a naive `WHERE reps = N` gets it
 * wrong: a set of ten at 100kg proves a five-rep max of at least 100kg, so
 * excluding it would report a 5RM below a set that was actually performed. The
 * source workbook does the same thing, which is why its 3RM and 5RM columns hold
 * identical values for several lifts.
 *
 * A TABLE and no chart. This is a lookup — "what is my 5RM on front squat" — and
 * a grouped bar chart over forty exercises answered it worse than the pivot did
 * while taking three times the space. The measure switch changes what the cells
 * CONTAIN rather than adding a second number to each, so a column of kilograms
 * stays scannable.
 *
 * No date window either. A personal best is a lifetime fact; "the last 90 days
 * of all-time bests" is a question with no meaning, and a filter that quietly
 * reframes a PB as a recent maximum is worse than no filter at all.
 */

const REPS = [1, 3, 5, 10, 12];

const MEASURES = [
  { value: "kg", label: "kg" },
  { value: "relative", label: "× bodyweight" },
  { value: "date", label: "When" },
];

const DAY_MS = 86_400_000;

/**
 * "34 days ago", "3 years ago".
 *
 * Relative because the useful question about a PB is how long it has stood, not
 * which Tuesday it happened on. The absolute date stays in the cell's `title`
 * so nothing is actually lost.
 */
const relativeAge = (iso: string): string => {
  const days = Math.round((Date.now() - Date.parse(iso)) / DAY_MS);
  if (!Number.isFinite(days)) return "—";
  if (days < 1) return "today";
  if (days < 30) return `${days} days ago`;
  if (days < 365) {
    const months = Math.round(days / 30);
    return `${months} month${months === 1 ? "" : "s"} ago`;
  }
  const years = Math.round((days / 365) * 10) / 10;
  return `${years} year${years === 1 ? "" : "s"} ago`;
};

export const HistoryRepMaxesPage = () => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.historyRepMaxes>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [measure] = useQueryParam("measure", "kg");
  const [equipment] = useQueryParam("equipment", "");
  const { exercises: catalogue } = useCatalogue();

  useEffect(() => {
    api
      .historyRepMaxes()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <Banner variant="error">{error}</Banner>;
  if (!data) return <Loading what="your rep maxes" />;
  if (!data.available) {
    return (
      <>
        <h1>Rep maxes</h1>
        <Banner>{data.reason}</Banner>
      </>
    );
  }

  const equipmentOf = new Map(catalogue.map((e) => [e.exercise, e.equipment]));
  const equipmentOptions = [...new Set(catalogue.map((e) => e.equipment))]
    .sort()
    .map((value) => ({ value, label: value }));

  const rows = equipment
    ? data.repMaxes.filter((r) => equipmentOf.get(r.exercise) === equipment)
    : data.repMaxes;

  const byExercise = new Map<string, Map<number, HistoryRepMax>>();
  for (const r of rows) {
    let entry = byExercise.get(r.exercise);
    if (!entry) {
      entry = new Map();
      byExercise.set(r.exercise, entry);
    }
    entry.set(r.reps, r);
  }

  // Ordered by the heaviest single, so the table reads top-down by strength
  // rather than alphabetically. The relative measure reorders on ratio instead,
  // which is the entire reason for offering it: a 60kg pull-up and a 140kg
  // deadlift are not comparable until divided by the body doing them.
  const sortValue = (entry: Map<number, HistoryRepMax> | undefined): number => {
    const one = entry?.get(1);
    if (!one) return 0;
    return measure === "relative" ? (one.bodyweightRatio ?? 0) : one.weightKg;
  };

  const ordered = [...byExercise.entries()].sort((a, b) => sortValue(b[1]) - sortValue(a[1]));

  const render = (cell: HistoryRepMax | undefined): React.ReactNode => {
    if (!cell) return "—";
    if (measure === "date") {
      return <span title={cell.achievedOn}>{relativeAge(cell.achievedOn)}</span>;
    }
    if (measure === "relative") {
      return cell.bodyweightRatio === null ? (
        // No weigh-in on or before the lift, so there is no body weight to
        // divide by. A blank is honest; a ratio against today's weight would be
        // a number that was never true.
        <span title="No weigh-in recorded on or before this lift">—</span>
      ) : (
        <span title={`${cell.weightKg}kg on ${cell.achievedOn}`}>
          {cell.bodyweightRatio.toFixed(2)}×
        </span>
      );
    }
    return <span title={`Achieved ${cell.achievedOn}`}>{cell.weightKg}kg</span>;
  };

  return (
    <>
      <h1>Rep maxes</h1>
      <p className="muted">
        Heaviest load moved for <em>at least</em> that many reps, so a set of ten at 100kg counts as
        a five-rep max too. Ratios use the body weight recorded nearest the lift.
      </p>

      <div className="filters">
        <Segmented label="Show" param="measure" fallback="kg" options={MEASURES} />
        <SelectFilter
          label="Equipment"
          param="equipment"
          fallback=""
          anyLabel="All equipment"
          options={equipmentOptions}
        />
      </div>

      <section className="card">
        <h2>
          {ordered.length} movements
          {equipment && <span className="muted"> with a {equipment.toLowerCase()}</span>}
        </h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Exercise</th>
                {REPS.map((n) => (
                  <th key={n}>{n}RM</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ordered.map(([name, byReps]) => (
                <tr key={name}>
                  <td>{name}</td>
                  {REPS.map((n) => (
                    <td key={n} className="mono">
                      {render(byReps.get(n))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ordered.length === 0 && (
          <p className="muted">Nothing recorded in this equipment category.</p>
        )}
      </section>
    </>
  );
};
