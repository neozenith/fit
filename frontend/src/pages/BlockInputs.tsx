import {
  type AccessoryChoices,
  type BlockConfig,
  DEFAULT_ACCESSORIES,
  generateBlock,
  movementLabel,
  type Session,
  SLOT_MOVEMENT,
} from "@fit/program";
import { useEffect, useMemo, useState } from "react";
import { api, type CuratedExercise, type PersonalBest } from "../api.js";
import { Combobox } from "../combobox.jsx";
import { Banner, formatDate, formatShortDate, Loading, repLabel } from "../components.jsx";
import { navigate } from "../router.jsx";

/**
 * The Inputs sheet: everything a six-week block is projected FROM.
 *
 * Named `/block-inputs` rather than `/block` because that is what it is. The
 * page collects the handful of values the entire block is a pure function of
 * (ADR-0001) — three one-rep maxes, a start date, units, accessory choices —
 * and previews the six weeks those values produce, so the dates land somewhere
 * visible BEFORE the block is committed rather than after.
 *
 * ON EDITING AND DELETING. Storage is append-only and the API role has no
 * `DeleteItem` (ADR-0029), so neither exists. "Edit" and "reset" are the same
 * act: write a new block with the same start date, which supersedes the old one.
 * That is stated plainly rather than hidden behind a Save button that quietly
 * writes a second row.
 */

const LIFTS = [
  { key: "squat", label: "Squat" },
  { key: "bench", label: "Bench press" },
  { key: "deadlift", label: "Deadlift" },
] as const;

/**
 * The accessory slots.
 *
 * Their options come from the CATALOGUE, filtered by the movement each slot
 * requires (`SLOT_MOVEMENT`). The hardcoded four-string menu each prescribed
 * slot used to carry was a second source of truth, and it showed: Romanian
 * Deadlift is in the log five times and is unambiguously a hinge, yet could not
 * be picked as a deadlift variation because it was not one of the four strings.
 *
 * The optional slots require no particular movement and so offer everything —
 * which is what the spreadsheet's free-text fields meant.
 */
const SLOTS: Array<{ key: keyof AccessoryChoices; label: string }> = [
  { key: "upperBackHorizontal", label: "Upper back — horizontal pull" },
  { key: "shoulder", label: "Shoulder" },
  { key: "upperBackVertical", label: "Upper back — vertical pull" },
  { key: "deadliftVariation", label: "Deadlift variation" },
  { key: "optional1", label: "Optional exercise 1" },
  { key: "optional2", label: "Optional exercise 2" },
  { key: "optionalLower1", label: "Optional lower body 1" },
  { key: "optionalLower2", label: "Optional lower body 2" },
];

export const BlockInputsPage = () => {
  const [current, setCurrent] = useState<BlockConfig | null>(null);
  const [blockCount, setBlockCount] = useState(0);
  const [bests, setBests] = useState<Record<string, PersonalBest>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<CuratedExercise[]>([]);
  const [inspecting, setInspecting] = useState<string | null>(null);

  const [draft, setDraft] = useState({
    startDate: new Date().toISOString().slice(0, 10),
    units: "kg",
    squat: "100",
    bench: "80",
    deadlift: "140",
    accessories: DEFAULT_ACCESSORIES as AccessoryChoices,
  });
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    api
      .catalogue()
      .then((r) => setCatalogue(r.exercises))
      // A catalogue that will not load leaves the pickers empty but still
      // typeable; the page's own error surface is for failures that block work.
      .catch(() => setCatalogue([]));
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
          setDraft({
            startDate: r.block.startDate,
            units: r.block.units,
            squat: String(r.block.oneRepMax.squat),
            bench: String(r.block.oneRepMax.bench),
            deadlift: String(r.block.oneRepMax.deadlift),
            accessories: r.block.accessories,
          });
        } else {
          // No block yet: seed from the estimated maxes rather than from
          // invented defaults, so a first block starts from something true.
          const estimate = (lift: string) => p.personalBests?.[lift]?.estimated;
          setDraft((d) => ({
            ...d,
            squat: estimate("squat") ? String(Math.round(estimate("squat") as number)) : d.squat,
            bench: estimate("bench") ? String(Math.round(estimate("bench") as number)) : d.bench,
            deadlift: estimate("deadlift")
              ? String(Math.round(estimate("deadlift") as number))
              : d.deadlift,
          }));
          setSeeded(Object.keys(p.personalBests ?? {}).length > 0);
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const setAccessory = (key: keyof AccessoryChoices, value: string) =>
    setDraft((d) => ({ ...d, accessories: { ...d.accessories, [key]: value } }));

  // The preview is generated IN THE BROWSER from the same module the server uses
  // (ADR-0019), so it moves as you type. A round trip would make the six weeks
  // something you see only after committing to them.
  const preview: Session[] = useMemo(() => {
    const numbers = {
      squat: Number(draft.squat),
      bench: Number(draft.bench),
      deadlift: Number(draft.deadlift),
    };
    if (Object.values(numbers).some((n) => !Number.isFinite(n) || n <= 0)) return [];
    try {
      return generateBlock({
        blockId: "preview",
        startDate: draft.startDate,
        units: draft.units as "kg" | "lb",
        oneRepMax: numbers,
        accessories: draft.accessories,
      });
    } catch {
      // An invalid date is the only realistic failure, and it is transient —
      // half-typed input. Showing nothing beats an error the user is mid-way
      // through fixing.
      return [];
    }
  }, [draft]);

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.createBlock({
        startDate: draft.startDate,
        units: draft.units,
        oneRepMax: {
          squat: Number(draft.squat),
          bench: Number(draft.bench),
          deadlift: Number(draft.deadlift),
        },
        accessories: draft.accessories,
      });
      navigate("/overview");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading what="your block inputs" />;

  const replacing = current !== null && current.startDate === draft.startDate;
  const weeks = [...new Set(preview.map((s) => s.week))].sort((a, b) => a - b);

  /** Everything the catalogue offers for a slot, given the movement it needs. */
  const optionsFor = (slot: keyof AccessoryChoices): string[] => {
    const movement = SLOT_MOVEMENT[slot] ?? null;
    return catalogue
      .filter((e) => !e.retired && (movement === null || e.movement === movement))
      .map((e) => e.exercise)
      .sort((a, b) => a.localeCompare(b));
  };

  const inspected = preview.find((s) => `${s.week}-${s.day}` === inspecting);

  return (
    <>
      <h1>Block inputs</h1>
      {error && <Banner variant="error">{error}</Banner>}

      <section className="card">
        {current ? (
          <>
            <h2>You have a block</h2>
            <p className="muted">
              Started {formatDate(current.startDate)} · {current.units} · seeds{" "}
              {current.oneRepMax.squat}/{current.oneRepMax.bench}/{current.oneRepMax.deadlift}
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
              Everything the six weeks prescribe is computed from the values below, so nothing here
              is guesswork you have to repeat later.
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2>Seed one-rep maxes</h2>
        <p className="muted">
          The whole block is a projection of these three numbers. No prescribed weight is ever
          stored — change a max and every session below moves with it.
        </p>
        <div className="row">
          {LIFTS.map((lift) => (
            <div className="field" key={lift.key}>
              <label htmlFor={lift.key}>{lift.label}</label>
              <input
                id={lift.key}
                type="number"
                min="1"
                step="2.5"
                value={draft[lift.key]}
                onChange={(e) => setDraft({ ...draft, [lift.key]: e.target.value })}
              />
              {/* The estimate from the log, offered rather than imposed. It is
                  computed from every set ever recorded, so it is a better
                  starting guess than memory — but a max is a decision, and
                  overwriting one silently would be the wrong kind of help. */}
              <Estimate
                best={bests[lift.key]}
                onUse={(v) => setDraft({ ...draft, [lift.key]: v })}
              />
            </div>
          ))}
          <div className="field">
            <label htmlFor="units">Units</label>
            <select
              id="units"
              value={draft.units}
              onChange={(e) => setDraft({ ...draft, units: e.target.value })}
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
              value={draft.startDate}
              onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
            />
          </div>
        </div>
        {seeded && !current && (
          <p className="muted">
            Seeded from your estimated maxes. Adjust anything that does not match what you would
            actually attempt today.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Accessories</h2>
        <p className="muted">
          The four <em>optional</em> slots offer the full exercise list; the prescribed slots offer
          the program's own menus. Every field also accepts anything you type.
        </p>
        <div className="grid">
          {SLOTS.map((slot) => {
            const movement = SLOT_MOVEMENT[slot.key] ?? null;
            return (
              <Combobox
                key={slot.key}
                id={`slot-${slot.key}`}
                label={
                  <>
                    {slot.label}{" "}
                    <span className="muted">
                      — {movement ? movementLabel(movement) : "any movement"}
                    </span>
                  </>
                }
                value={draft.accessories[slot.key]}
                options={optionsFor(slot.key)}
                onChange={(value) => setAccessory(slot.key, value)}
                placeholder="Search or type"
              />
            );
          })}
        </div>
        <p className="muted">
          Options come from the <a href="/exercises">exercise catalogue</a>, filtered by the
          movement each slot needs. Curate an exercise there and it appears here.
        </p>
      </section>

      {/* The preview lives HERE rather than only on the overview, because the
          question it answers — "which days does this land on?" — is one you ask
          before committing, not after. */}
      <section className="card">
        <h2>What this produces</h2>
        {weeks.length === 0 ? (
          <p className="muted">Fill in three positive maxes and a start date to see the block.</p>
        ) : (
          <>
            <p className="muted">
              {preview.length} sessions from {formatDate(preview[0]?.date ?? draft.startDate)} to{" "}
              {formatDate(preview.at(-1)?.date ?? draft.startDate)}.
            </p>
            <div className="calendar">
              {weeks.map((week) => {
                const weekSessions = preview.filter((s) => s.week === week);
                return (
                  <div key={week} className="calendar__week">
                    <div className="calendar__label">
                      <strong>Week {week}</strong>
                      <span className="muted">{weekSessions[0]?.weekTitle ?? ""}</span>
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
                            <span className="day__name">Day {session.day}</span>
                            <span className="day__meta">
                              {session.exercises.filter((e) => e.sets.length > 0).length} exercises
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
                  Week {inspected.week}, day {inspected.day}
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
                      {inspected.exercises.map((exercise) => (
                        <tr key={exercise.exercise}>
                          <td>{exercise.exercise}</td>
                          <td className="mono">
                            {exercise.sets.length === 0
                              ? "—"
                              : exercise.sets
                                  .map(
                                    (set) =>
                                      `${set.weight !== undefined ? `${set.weight}${draft.units} ` : ""}${repLabel(set.reps)}`,
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
              This creates a block starting {formatDate(draft.startDate)}. Choosing today's date
              while a block is running effectively resets it — the newer block becomes the live one
              from its start date onward.
            </>
          )}
        </p>
        <button className="primary" type="button" onClick={create} disabled={saving}>
          {saving ? "Saving…" : replacing ? "Replace block" : "Create block"}
        </button>
      </section>
    </>
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
