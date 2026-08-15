import {
  type BlockConfig,
  BUILTIN_PROGRAMS,
  compileCustomProgram,
  groupByExercise,
  movementLabel,
  type Program,
  type ProgramParameterSpec,
  type ProgramParameters,
  rolloutBlock,
  type Session,
  SLOT_MOVEMENT,
  type StoredSessionPlan,
  withDefaults,
} from "@fit/program";
import { useEffect, useMemo, useState } from "react";
import { api, type CuratedExercise, type PersonalBest } from "../api.js";
import { Combobox } from "../combobox.jsx";
import { Banner, formatDate, formatShortDate, Loading, repLabel } from "../components.jsx";
import { navigate } from "../router.jsx";

/**
 * Instantiate a Program into a Block.
 *
 * The page collects the values the entire block is a pure function of (ADR-0001)
 * and previews the sessions those values produce, so the dates land somewhere
 * visible BEFORE the block is committed rather than after.
 *
 * The form is GENERIC. It renders from the program's own `parameters`
 * declaration, so adding a fourth program needs no work here at all — which is
 * the same declaration the server validates against, so the two cannot drift.
 *
 * ON EDITING AND DELETING. Storage is append-only and the API role has no
 * `DeleteItem` (ADR-0029), so neither exists. "Edit" and "reset" are the same
 * act: write a new block with the same start date, which supersedes the old one.
 * That is stated plainly rather than hidden behind a Save button that quietly
 * writes a second row.
 */

/** Slots whose picker is filtered by the movement the program asks for. */
const isSlotKey = (key: string): boolean => key in SLOT_MOVEMENT;

export const BlockInputsPage = () => {
  const [current, setCurrent] = useState<BlockConfig | null>(null);
  const [blockCount, setBlockCount] = useState(0);
  const [bests, setBests] = useState<Record<string, PersonalBest>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<CuratedExercise[]>([]);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [customPrograms, setCustomPrograms] = useState<Program[]>([]);

  const [programId, setProgramId] = useState<string>(BUILTIN_PROGRAMS[0]?.programId ?? "");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [units, setUnits] = useState<"kg" | "lb">("kg");
  const [values, setValues] = useState<Record<string, string>>({});
  const [seeded, setSeeded] = useState(false);

  /**
   * Every program the athlete can pick, built-in and custom together.
   *
   * The custom ones are COMPILED IN THE BROWSER from the same module the server
   * uses (ADR-0019), so the preview below is the real rollout rather than an
   * approximation of it.
   */
  const programs = useMemo(() => [...BUILTIN_PROGRAMS, ...customPrograms], [customPrograms]);
  const program = useMemo(
    () => programs.find((p) => p.programId === programId) ?? programs[0],
    [programs, programId],
  );

  useEffect(() => {
    api
      .catalogue()
      .then((r) => setCatalogue(r.exercises))
      // A catalogue that will not load leaves the pickers empty but still
      // typeable; the page's own error surface is for failures that block work.
      .catch(() => setCatalogue([]));
  }, []);

  useEffect(() => {
    // Custom programs need their plans to compile. A definition that will not
    // compile is skipped rather than crashing the picker — one broken program
    // must not make the others unpickable.
    Promise.all([api.programs(), api.plans()])
      .then(([programsResponse, plansResponse]) => {
        const plans: StoredSessionPlan[] = plansResponse.plans;
        const compiled: Program[] = [];
        for (const definition of programsResponse.definitions) {
          if (definition.retired) continue;
          try {
            compiled.push(compileCustomProgram(definition, plans));
          } catch {
            // Already reported by the API in `broken`; skipping it here keeps
            // one bad definition from making every other program unpickable.
          }
        }
        setCustomPrograms(compiled);
      })
      .catch(() => setCustomPrograms([]));
  }, []);

  useEffect(() => {
    Promise.all([api.currentBlock(), api.progress()])
      .then(([r, p]) => {
        setCurrent(r.block);
        setBlockCount(r.blockCount ?? 0);
        setBests(p.personalBests ?? {});

        if (r.block) {
          // Pre-filled from the live block, so the common action — "same setup,
          // new maxes" — is editing one number rather than retyping eleven.
          setProgramId(r.block.programId);
          setStartDate(r.block.startDate);
          setUnits(r.block.units);
          setValues(
            Object.fromEntries(Object.entries(r.block.parameters).map(([k, v]) => [k, String(v)])),
          );
        } else {
          setSeeded(Object.keys(p.personalBests ?? {}).length > 0);
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  /**
   * Fill in the selected program's declared defaults, and seed maxes from the log.
   *
   * Runs when the program changes, and deliberately does NOT clobber a value the
   * athlete already typed: switching from 5/3/1 to Candito should keep the squat
   * max you just entered, because it means the same thing in both.
   */
  useEffect(() => {
    if (!program) return;
    setValues((existing) => {
      const next = { ...existing };
      for (const spec of program.parameters) {
        if (next[spec.key] !== undefined && next[spec.key] !== "") continue;
        if (spec.default !== undefined) {
          next[spec.key] = String(spec.default);
          continue;
        }
        // No declared default: seed a max from the log rather than from an
        // invented number, so a first block starts from something true.
        const estimated = bests[spec.key]?.estimated;
        if ((spec.kind === "oneRepMax" || spec.kind === "weight") && estimated) {
          next[spec.key] = String(Math.round(estimated));
        }
      }
      return next;
    });
  }, [program, bests]);

  /**
   * The parameter bag, typed.
   *
   * A numeric-kinded parameter becomes a number and everything else stays a
   * string, which is exactly the split `ProgramParameters` models. Sending "100"
   * where the resolver expects 100 would work by coercion today and break the
   * first time a program compares rather than multiplies.
   */
  const parameters: ProgramParameters = useMemo(() => {
    const bag: ProgramParameters = { units };
    for (const spec of program?.parameters ?? []) {
      const raw = values[spec.key];
      if (raw === undefined || raw === "") continue;
      const numeric =
        spec.kind === "oneRepMax" ||
        spec.kind === "weight" ||
        spec.kind === "integer" ||
        spec.kind === "percentage";
      bag[spec.key] = numeric ? Number(raw) : raw;
    }
    return bag;
  }, [program, values, units]);

  // The preview is generated IN THE BROWSER from the same module the server uses
  // (ADR-0019), so it moves as you type. A round trip would make the block
  // something you see only after committing to it.
  const preview: Session[] = useMemo(() => {
    if (!program) return [];
    try {
      return rolloutBlock(program, {
        blockId: "preview",
        programId: program.programId,
        startDate,
        units,
        parameters: withDefaults(program, parameters),
      });
    } catch {
      // An invalid date is the only realistic failure, and it is transient —
      // half-typed input. Showing nothing beats an error the user is mid-way
      // through fixing.
      return [];
    }
  }, [program, parameters, startDate, units]);

  const create = async () => {
    if (!program) return;
    setSaving(true);
    setError(null);
    try {
      await api.createBlock({
        programId: program.programId,
        startDate,
        units,
        parameters,
      });
      navigate("/overview");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading what="your block inputs" />;

  const replacing = current !== null && current.startDate === startDate;
  const weeks = [...new Set(preview.map((s) => s.week))].sort((a, b) => a - b);

  /** Everything the catalogue offers for a slot, given the movement it needs. */
  const optionsFor = (key: string): string[] => {
    const movement = SLOT_MOVEMENT[key] ?? null;
    return catalogue
      .filter((e) => !e.retired && (movement === null || e.movement === movement))
      .map((e) => e.exercise)
      .sort((a, b) => a.localeCompare(b));
  };

  const inspected = preview.find((s) => `${s.week}-${s.day}` === inspecting);

  /** Parameters grouped for the form, in declaration order. */
  const groups = new Map<string, ProgramParameterSpec[]>();
  for (const spec of program?.parameters ?? []) {
    const key = spec.group ?? "Inputs";
    groups.set(key, [...(groups.get(key) ?? []), spec]);
  }

  return (
    <>
      <h1>Start a block</h1>
      {error && <Banner variant="error">{error}</Banner>}

      <section className="card">
        {current ? (
          <>
            <h2>You have a block</h2>
            <p className="muted">
              Started {formatDate(current.startDate)} · {current.units}
              {blockCount > 1 && <> · {blockCount} blocks recorded in total</>}
            </p>
            <p>
              <a href="/overview">See how it is going</a> · <a href="/log">Log a session</a>
            </p>
          </>
        ) : (
          <>
            <h2>You have no block yet</h2>
            <p className="muted">
              A block is one run of a program. Everything it prescribes is computed from the values
              below, so nothing here is guesswork you have to repeat later.
            </p>
          </>
        )}
      </section>

      {/* The program choice comes FIRST, because it decides what every field
          below even is. */}
      <section className="card">
        <h2>Program</h2>
        <div className="grid">
          {programs.map((p) => (
            <button
              type="button"
              key={p.programId}
              className={`choice${p.programId === program?.programId ? " choice--active" : ""}`}
              aria-pressed={p.programId === program?.programId}
              onClick={() => setProgramId(p.programId)}
            >
              <strong>{p.name}</strong>
              {p.origin === "custom" && <span className="pill">yours</span>}
              <span className="muted">{p.description}</span>
              {p.attribution && <span className="muted">— {p.attribution}</span>}
            </button>
          ))}
        </div>
        <p className="muted">
          Built-in and your own programs are the same kind of thing, built the same way.{" "}
          <a href="/plans">Build your own</a> from session plans.
        </p>
      </section>

      <section className="card">
        <h2>When and in what units</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="units">Units</label>
            <select
              id="units"
              value={units}
              onChange={(e) => setUnits(e.target.value === "lb" ? "lb" : "kg")}
            >
              <option value="kg">kg</option>
              <option value="lb">lb</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="startDate">Start date</label>
            <input
              id="startDate"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
        </div>
      </section>

      {/* Rendered entirely from the program's own parameter declaration. A new
          program needs no code here. */}
      {[...groups.entries()].map(([groupName, specs]) => (
        <section className="card" key={groupName}>
          <h2>{groupName}</h2>
          <div className={specs.some((s) => s.kind === "exercise") ? "grid" : "row"}>
            {specs.map((spec) => (
              <ParameterField
                key={spec.key}
                spec={spec}
                value={values[spec.key] ?? ""}
                units={units}
                best={bests[spec.key]}
                options={spec.kind === "exercise" ? optionsFor(spec.key) : []}
                movementHint={
                  spec.kind === "exercise" && isSlotKey(spec.key)
                    ? // A slot with no required movement accepts anything, which
                      // is what the sheet's free-text fields meant.
                      movementLabel(SLOT_MOVEMENT[spec.key] ?? "") || "any movement"
                    : null
                }
                onChange={(v) => setValues((prev) => ({ ...prev, [spec.key]: v }))}
              />
            ))}
          </div>
          {groupName === "Maxes" && seeded && !current && (
            <p className="muted">
              Seeded from your estimated maxes. Adjust anything that does not match what you would
              actually attempt today.
            </p>
          )}
          {groupName === "Accessories" && (
            <p className="muted">
              Options come from the <a href="/exercises">exercise catalogue</a>, filtered by the
              movement each slot needs. Curate an exercise there and it appears here.
            </p>
          )}
        </section>
      ))}

      {/* The preview lives HERE rather than only on the overview, because the
          question it answers — "which days does this land on?" — is one you ask
          before committing, not after. */}
      <section className="card">
        <h2>What this produces</h2>
        {weeks.length === 0 ? (
          <p className="muted">Fill in the inputs above to see the block.</p>
        ) : (
          <>
            <p className="muted">
              {preview.length} sessions across {weeks.length} weeks, from{" "}
              {formatDate(preview[0]?.date ?? startDate)} to{" "}
              {formatDate(preview.at(-1)?.date ?? startDate)}.
            </p>
            <div className="calendar">
              {weeks.map((week) => {
                const weekSessions = preview.filter((s) => s.week === week);
                return (
                  <div key={week} className="calendar__week">
                    <div className="calendar__label">
                      <strong>Week {week}</strong>
                      <span className="muted">{weekSessions[0]?.phase ?? ""}</span>
                    </div>
                    <div className="calendar__days">
                      {weekSessions.map((session) => {
                        const id = `${session.week}-${session.day}`;
                        return (
                          <button
                            type="button"
                            className={`day day--future${inspecting === id ? " day--active" : ""}`}
                            key={id}
                            aria-pressed={inspecting === id}
                            onClick={() => setInspecting(inspecting === id ? null : id)}
                          >
                            <span className="day__date">{formatShortDate(session.date)}</span>
                            <span className="day__name">{session.name}</span>
                            <span className="day__meta">
                              {groupByExercise(session.activities).length} exercises
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* The squares were previously inert, which made the preview a
                shape and not an inspection: you could see that week 3 has four
                days without seeing what any of them prescribe. */}
            {inspected ? (
              <div className="session-detail">
                <h3>
                  {inspected.name}
                  <span className="muted"> · {formatDate(inspected.date)}</span>
                </h3>
                {inspected.intensityLabel && <p className="muted">{inspected.intensityLabel}</p>}
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Exercise</th>
                        <th>Prescribed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupByExercise(inspected.activities).map((group) => (
                        <tr key={group.exercise}>
                          <td>{group.exercise}</td>
                          <td className="mono">
                            {group.activities.every((a) => a.reps.kind === "unprescribed")
                              ? "—"
                              : group.activities
                                  .map(
                                    (a) =>
                                      `${a.weight !== undefined ? `${a.weight}${units} ` : ""}${repLabel(a.reps)}`,
                                  )
                                  .join(", ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {inspected.notes.map((note) => (
                  <p key={note} className="muted">
                    {note}
                  </p>
                ))}
              </div>
            ) : (
              <p className="muted">Select a day to see exactly what it prescribes.</p>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2>{replacing ? "Replace this block" : "Create the block"}</h2>
        <p className="muted">
          {replacing ? (
            <>
              A block with this start date already exists, so this writes a{" "}
              <strong>replacement</strong> — the newer one becomes live and the old one stays in the
              record. Nothing is deleted or edited in place, deliberately: what you believed in
              March stays answerable.
            </>
          ) : (
            <>
              This creates a block starting {formatDate(startDate)}. Choosing today's date while a
              block is running effectively resets it — the newer block becomes the live one from its
              start date onward.
            </>
          )}
        </p>
        <button
          className="primary"
          type="button"
          onClick={create}
          disabled={saving || preview.length === 0}
        >
          {saving ? "Saving…" : replacing ? "Replace block" : "Create block"}
        </button>
      </section>
    </>
  );
};

/**
 * One declared parameter, rendered by kind.
 *
 * The whole form is this function in a loop, which is what makes a new program a
 * data change rather than a UI change.
 */
const ParameterField = ({
  spec,
  value,
  units,
  best,
  options,
  movementHint,
  onChange,
}: {
  spec: ProgramParameterSpec;
  value: string;
  units: string;
  best: PersonalBest | undefined;
  options: string[];
  movementHint: string | null;
  onChange: (value: string) => void;
}) => {
  if (spec.kind === "exercise") {
    return (
      <Combobox
        id={`param-${spec.key}`}
        label={
          <>
            {spec.label}
            {movementHint && <span className="muted"> — {movementHint}</span>}
          </>
        }
        value={value}
        options={options}
        onChange={onChange}
        placeholder="Search or type"
      />
    );
  }

  if (spec.kind === "choice") {
    return (
      <div className="field">
        <label htmlFor={`param-${spec.key}`}>{spec.label}</label>
        <select id={`param-${spec.key}`} value={value} onChange={(e) => onChange(e.target.value)}>
          {(spec.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {spec.help && <span className="field__hint muted">{spec.help}</span>}
      </div>
    );
  }

  const step = spec.kind === "integer" ? "1" : spec.kind === "percentage" ? "0.5" : "2.5";

  return (
    <div className="field">
      <label htmlFor={`param-${spec.key}`}>
        {spec.label}
        {(spec.kind === "oneRepMax" || spec.kind === "weight") && (
          <span className="muted"> ({units})</span>
        )}
      </label>
      <input
        id={`param-${spec.key}`}
        type="number"
        min="0"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {/* The estimate from the log, offered rather than imposed. It is computed
          from every activity ever recorded, so it is a better starting guess
          than memory — but a max is a decision, and overwriting one silently
          would be the wrong kind of help. */}
      {(spec.kind === "oneRepMax" || spec.kind === "weight") && (
        <Estimate best={best} onUse={onChange} />
      )}
      {spec.help && <span className="field__hint muted">{spec.help}</span>}
    </div>
  );
};

const Estimate = ({
  best,
  onUse,
}: {
  best: PersonalBest | undefined;
  onUse: (value: string) => void;
}) => {
  if (!best) return <span className="muted field__hint">No logged sets to estimate from.</span>;
  const value = String(Math.round(best.estimated));
  return (
    <span className="field__hint muted">
      Estimated {value} from {best.weight}×{best.reps}{" "}
      <button type="button" className="linkish" onClick={() => onUse(value)}>
        use
      </button>
    </span>
  );
};
