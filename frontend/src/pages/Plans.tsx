import {
  BUILTIN_PROGRAMS,
  type CustomProgramDefinition,
  danglingReferences,
  type LoadSpec,
  type ProgramParameterSpec,
  type RepSpec,
  type StoredSessionPlan,
} from "@fit/program";
import { useCallback, useEffect, useState } from "react";
import { api, type CuratedExercise } from "../api.js";
import { Combobox } from "../combobox.jsx";
import { Banner, Loading } from "../components.jsx";

/**
 * Build your own SessionPlans, and compose them into a Program.
 *
 * The point of this page is that it is not a lesser version of the built-ins. A
 * plan authored here is exactly the structure `Candito 6-Week` emits, and the
 * program built from those plans goes through the same rollout, the same
 * percentage resolution and the same rounding (ADR-0037). The built-ins are
 * literals in TypeScript; these are rows. Nothing else separates them.
 *
 * Two consequences worth stating plainly on the page, because they are the
 * things that make custom programs actually useful rather than a toy:
 *
 *   · a set's load can be a PERCENTAGE OF A PARAMETER, so one plan re-projects
 *     from a new max exactly as a built-in does, and
 *   · a plan is scheduled at an explicit day offset, so an irregular training
 *     week is expressible — Candito's own week 1 lands on days 0, 1, 3, 4, 5.
 */

interface DraftActivity {
  exercise: string;
  repKind: RepSpec["kind"];
  reps: string;
  repMin: string;
  repMax: string;
  loadKind: LoadSpec["kind"];
  weight: string;
  ref: string;
  percentage: string;
}

const BLANK: DraftActivity = {
  exercise: "",
  repKind: "fixed",
  reps: "5",
  repMin: "4",
  repMax: "6",
  loadKind: "reference",
  weight: "",
  ref: "squat",
  percentage: "80",
};

const toRepSpec = (d: DraftActivity): RepSpec => {
  switch (d.repKind) {
    case "fixed":
      return { kind: "fixed", reps: Number(d.reps) || 0 };
    case "range":
      return { kind: "range", min: Number(d.repMin) || 0, max: Number(d.repMax) || 0 };
    case "maxRepsCapped":
      return { kind: "maxRepsCapped", cap: Number(d.reps) || 10 };
    case "maxReps":
      return { kind: "maxReps" };
    default:
      return { kind: "unprescribed" };
  }
};

const toLoadSpec = (d: DraftActivity): LoadSpec => {
  if (d.loadKind === "absolute") return { kind: "absolute", weight: Number(d.weight) || 0 };
  if (d.loadKind === "reference") {
    return {
      kind: "reference",
      ref: d.ref.trim(),
      // Entered as a percentage because that is how every published program
      // writes it. Stored as a fraction because that is what the resolver
      // multiplies by — converting in one place beats two conventions.
      percentage: (Number(d.percentage) || 0) / 100,
    };
  }
  return { kind: "unprescribed" };
};

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

export const PlansPage = () => {
  const [plans, setPlans] = useState<StoredSessionPlan[]>([]);
  const [definitions, setDefinitions] = useState<CustomProgramDefinition[]>([]);
  const [catalogue, setCatalogue] = useState<CuratedExercise[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [planName, setPlanName] = useState("");
  const [rows, setRows] = useState<DraftActivity[]>([{ ...BLANK }]);

  const load = useCallback(
    () =>
      Promise.all([api.plans(), api.programs(), api.catalogue()]).then(([p, pr, c]) => {
        setPlans(p.plans);
        setDefinitions(pr.definitions);
        setCatalogue(c.exercises.filter((e: CuratedExercise) => !e.retired));
      }),
    [],
  );

  useEffect(() => {
    load()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [load]);

  const setRow = (index: number, patch: Partial<DraftActivity>) =>
    setRows((was) => was.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  /** An empty row always waits at the end, so adding a set is never a click. */
  const rowsWithSpare = rows.at(-1)?.exercise ? [...rows, { ...BLANK }] : rows;

  const savePlan = async () => {
    const filled = rows.filter((r) => r.exercise.trim());
    if (!planName.trim()) {
      setError("Give the plan a name — it is what you pick when scheduling it.");
      return;
    }
    if (filled.length === 0) {
      setError("A plan needs at least one prescribed set.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const { plan } = await api.putPlan({
        planId: slug(planName),
        name: planName.trim(),
        notes: [],
        // ONE ENTRY PER SET, which is the stored model exactly. The server
        // re-derives `setIndex` from position, so a reordered list cannot leave
        // a gap in the numbering.
        activities: filled.map((r) => ({
          exercise: r.exercise.trim(),
          reps: toRepSpec(r),
          load: toLoadSpec(r),
        })),
      });
      setNotice(`Saved "${plan.name}" — ${plan.activities.length} sets.`);
      setPlanName("");
      setRows([{ ...BLANK }]);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading what="your session plans" />;

  const exerciseNames = catalogue.map((e) => e.exercise).sort((a, b) => a.localeCompare(b));

  return (
    <>
      <h1>Session plans</h1>
      <p className="muted">
        A <strong>session plan</strong> is a list of prescribed sets. A <strong>program</strong> is
        a schedule of plans. Instantiating a program produces a <strong>block</strong>.
      </p>
      {error && <Banner variant="error">{error}</Banner>}
      {notice && <Banner>{notice}</Banner>}

      <section className="card">
        <h2>Build a plan</h2>
        <p className="muted">
          Every row is one set. Prescribe a load as a percentage of a named input — the same
          mechanism the built-in programs use — so the plan re-projects when a max changes, rather
          than freezing today's numbers.
        </p>

        <div className="field">
          <label htmlFor="plan-name">Plan name</label>
          <input
            id="plan-name"
            value={planName}
            placeholder="Heavy Squat Day"
            onChange={(e) => setPlanName(e.target.value)}
          />
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Exercise</th>
                <th>Reps</th>
                <th>Load</th>
              </tr>
            </thead>
            <tbody>
              {rowsWithSpare.map((row, index) => (
                <tr key={`plan-row-${index}-${row.exercise}`}>
                  <td style={{ minWidth: "14rem" }}>
                    <Combobox
                      id={`plan-exercise-${index}`}
                      label=""
                      value={row.exercise}
                      options={exerciseNames}
                      onChange={(value) => setRow(index, { exercise: value })}
                      placeholder="Search or type"
                    />
                  </td>
                  <td>
                    <div className="row">
                      <select
                        aria-label={`Row ${index + 1} rep kind`}
                        value={row.repKind}
                        onChange={(e) =>
                          setRow(index, { repKind: e.target.value as RepSpec["kind"] })
                        }
                      >
                        <option value="fixed">exactly</option>
                        <option value="range">range</option>
                        <option value="maxReps">max reps</option>
                        <option value="maxRepsCapped">max reps, capped</option>
                        <option value="unprescribed">your choice</option>
                      </select>
                      {row.repKind === "range" ? (
                        <>
                          <input
                            aria-label={`Row ${index + 1} min reps`}
                            className="set-row__reps"
                            inputMode="numeric"
                            value={row.repMin}
                            onChange={(e) => setRow(index, { repMin: e.target.value })}
                          />
                          <span className="muted">to</span>
                          <input
                            aria-label={`Row ${index + 1} max reps`}
                            className="set-row__reps"
                            inputMode="numeric"
                            value={row.repMax}
                            onChange={(e) => setRow(index, { repMax: e.target.value })}
                          />
                        </>
                      ) : row.repKind === "fixed" || row.repKind === "maxRepsCapped" ? (
                        <input
                          aria-label={`Row ${index + 1} reps`}
                          className="set-row__reps"
                          inputMode="numeric"
                          value={row.reps}
                          onChange={(e) => setRow(index, { reps: e.target.value })}
                        />
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className="row">
                      <select
                        aria-label={`Row ${index + 1} load kind`}
                        value={row.loadKind}
                        onChange={(e) =>
                          setRow(index, { loadKind: e.target.value as LoadSpec["kind"] })
                        }
                      >
                        <option value="reference">% of an input</option>
                        <option value="absolute">fixed weight</option>
                        <option value="unprescribed">your choice</option>
                      </select>
                      {row.loadKind === "reference" && (
                        <>
                          <input
                            aria-label={`Row ${index + 1} percentage`}
                            className="set-row__reps"
                            inputMode="decimal"
                            value={row.percentage}
                            onChange={(e) => setRow(index, { percentage: e.target.value })}
                          />
                          <span className="muted">% of</span>
                          <input
                            aria-label={`Row ${index + 1} input name`}
                            className="set-row__weight"
                            value={row.ref}
                            onChange={(e) => setRow(index, { ref: e.target.value })}
                          />
                        </>
                      )}
                      {row.loadKind === "absolute" && (
                        <input
                          aria-label={`Row ${index + 1} weight`}
                          className="set-row__weight"
                          inputMode="decimal"
                          value={row.weight}
                          onChange={(e) => setRow(index, { weight: e.target.value })}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button className="primary" type="button" onClick={savePlan} disabled={saving}>
          {saving ? "Saving…" : "Save plan"}
        </button>
      </section>

      <section className="card">
        <h2>Your plans</h2>
        {plans.length === 0 ? (
          <p className="muted">None yet. A plan you save here can be scheduled into a program.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Sets</th>
                  <th>Exercises</th>
                  <th>Inputs it references</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.planId}>
                    <td>
                      <strong>{plan.name}</strong>
                      <div className="muted mono" style={{ fontSize: "0.78rem" }}>
                        {plan.planId}
                      </div>
                    </td>
                    <td className="mono">{plan.activities.length}</td>
                    <td>{[...new Set(plan.activities.map((a) => a.exercise))].join(", ")}</td>
                    <td className="mono">
                      {[
                        ...new Set(
                          plan.activities
                            .filter((a) => a.load.kind === "reference")
                            .map((a) => (a.load as { ref: string }).ref),
                        ),
                      ].join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Your programs</h2>
        {definitions.length === 0 ? (
          <p className="muted">
            None yet. A program is a schedule of plans, and each slot names a plan and a day offset
            from the block's start — which is what lets an irregular training week be expressed.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Program</th>
                  <th>Sessions</th>
                  <th>Declared inputs</th>
                  <th>Unresolved references</th>
                </tr>
              </thead>
              <tbody>
                {definitions.map((definition) => {
                  const dangling = danglingReferences(definition, plans);
                  return (
                    <tr key={definition.programId}>
                      <td>
                        <strong>{definition.name}</strong>
                        <div className="muted">{definition.description}</div>
                      </td>
                      <td className="mono">{definition.schedule.length}</td>
                      <td className="mono">
                        {definition.parameters.map((p: ProgramParameterSpec) => p.key).join(", ") ||
                          "—"}
                      </td>
                      <td className="mono">
                        {/* Named rather than left to render as a session with no
                            weights on it and no explanation. */}
                        {dangling.length > 0 ? (
                          <span className="pill pill--warn">{dangling.join(", ")}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>How the built-ins are built</h2>
        <p className="muted">
          Exactly this way. Each one declares its inputs and emits a schedule of session plans whose
          loads are percentages of those inputs, then goes through the same rollout yours does.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Program</th>
                <th>Declared inputs</th>
              </tr>
            </thead>
            <tbody>
              {BUILTIN_PROGRAMS.map((program) => (
                <tr key={program.programId}>
                  <td>
                    <strong>{program.name}</strong>
                    <div className="muted">{program.description}</div>
                  </td>
                  <td className="mono">{program.parameters.map((p) => p.key).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
};
