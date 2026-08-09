import {
  ACCESSORY_OPTIONS,
  type AccessoryChoices,
  type BlockConfig,
  DEFAULT_ACCESSORIES,
} from "@fit/program";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useCatalogue } from "../catalogue.js";
import { Banner, formatDate, Loading } from "../components.jsx";
import { navigate } from "../router.jsx";

/**
 * The Inputs sheet: everything a six-week block is projected FROM.
 *
 * Named `/block-inputs` rather than `/block` because that is what it is. The
 * page does not show a block — the overview does — it collects the handful of
 * values the entire block is a pure function of (ADR-0001): three one-rep
 * maxes, a start date, units, and the accessory choices.
 *
 * ON EDITING AND DELETING. Storage is append-only and the API role has no
 * `DeleteItem` (ADR-0013), so neither exists. "Edit" and "reset" are both the
 * same act: write a new block with the same start date, which supersedes the
 * old one because the API resolves ties by latest write. That is stated plainly
 * below rather than hidden behind a button labelled "Save" that quietly creates
 * a second row — the previous version stays queryable, and that is the point.
 */

const LIFTS = [
  { key: "squat", label: "Squat" },
  { key: "bench", label: "Bench press" },
  { key: "deadlift", label: "Deadlift" },
] as const;

/**
 * The accessory slots, and where each one's suggestions come from.
 *
 * The three `ACCESSORY_OPTIONS` slots are the program's own prescribed menus.
 * The four OPTIONAL slots — the spreadsheet's "Optional Exercise 1/2" and
 * "Optional Lower Body 1/2" — were free text on the Inputs sheet, so they draw
 * their suggestions from the EXERCISE CATALOGUE instead: the movements actually
 * performed, which is a better menu than anything hardcoded here.
 */
const SLOTS: Array<{
  key: keyof AccessoryChoices;
  label: string;
  hint: string;
  menu: keyof typeof ACCESSORY_OPTIONS | "catalogue";
}> = [
  {
    key: "upperBackHorizontal",
    label: "Upper back — horizontal pull",
    hint: "Prescribed slot",
    menu: "upperBackHorizontal",
  },
  { key: "shoulder", label: "Shoulder", hint: "Prescribed slot", menu: "shoulder" },
  {
    key: "upperBackVertical",
    label: "Upper back — vertical pull",
    hint: "Prescribed slot",
    menu: "upperBackVertical",
  },
  {
    key: "deadliftVariation",
    label: "Deadlift variation",
    hint: "Prescribed slot",
    menu: "deadliftVariation",
  },
  { key: "optional1", label: "Optional exercise 1", hint: "Your choice", menu: "catalogue" },
  { key: "optional2", label: "Optional exercise 2", hint: "Your choice", menu: "catalogue" },
  { key: "optionalLower1", label: "Optional lower body 1", hint: "Your choice", menu: "catalogue" },
  { key: "optionalLower2", label: "Optional lower body 2", hint: "Your choice", menu: "catalogue" },
];

export const BlockInputsPage = () => {
  const [current, setCurrent] = useState<BlockConfig | null>(null);
  const [blockCount, setBlockCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { exercises: catalogue } = useCatalogue();

  const [draft, setDraft] = useState({
    startDate: new Date().toISOString().slice(0, 10),
    units: "kg",
    squat: "100",
    bench: "80",
    deadlift: "140",
    accessories: DEFAULT_ACCESSORIES as AccessoryChoices,
  });

  useEffect(() => {
    api
      .currentBlock()
      .then((r) => {
        setCurrent(r.block);
        setBlockCount(r.blockCount ?? 0);
        // Pre-filled from the live block, so the common action — "same setup,
        // new maxes" — is editing one number rather than retyping eleven.
        if (r.block) {
          setDraft({
            startDate: r.block.startDate,
            units: r.block.units,
            squat: String(r.block.oneRepMax.squat),
            bench: String(r.block.oneRepMax.bench),
            deadlift: String(r.block.oneRepMax.deadlift),
            accessories: r.block.accessories,
          });
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const setAccessory = (key: keyof AccessoryChoices, value: string) =>
    setDraft((d) => ({ ...d, accessories: { ...d.accessories, [key]: value } }));

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
  const catalogueOptions = [...catalogue]
    .sort((a, b) => a.equipment.localeCompare(b.equipment) || a.exercise.localeCompare(b.exercise))
    .map((e) => e.exercise);

  return (
    <>
      <h1>Block inputs</h1>
      {error && <Banner variant="error">{error}</Banner>}

      {/* State first, and unambiguously. "Do I have a block?" was the single
          least answerable question in the app. */}
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
              <a href="/overview">See the six weeks</a> · <a href="/log">Log a session</a>
            </p>
          </>
        ) : (
          <>
            <h2>You have no block yet</h2>
            <p className="muted">
              Fill in the inputs below and create one. Everything the six weeks prescribe is
              computed from these values, so nothing here is guesswork you have to repeat later.
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2>Seed one-rep maxes</h2>
        <p className="muted">
          The whole block is a projection of these three numbers. No prescribed weight is ever
          stored — change a max and every session in the block moves with it.
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
      </section>

      <section className="card">
        <h2>Accessories</h2>
        <p className="muted">
          The four <em>optional</em> slots offer every movement in your exercise catalogue — the
          things you have actually done. The prescribed slots offer the program's own menus. Any
          slot accepts free text.
        </p>
        <div className="grid">
          {SLOTS.map((slot) => {
            const suggestions =
              slot.menu === "catalogue" ? catalogueOptions : [...ACCESSORY_OPTIONS[slot.menu]];
            return (
              <div className="field" key={slot.key}>
                <label htmlFor={`slot-${slot.key}`}>
                  {slot.label} <span className="muted">— {slot.hint}</span>
                </label>
                {/* An input with a datalist, not a select: the spreadsheet let
                    these be anything, and a closed list would refuse a movement
                    the catalogue has not seen yet — which is every new one. */}
                <input
                  id={`slot-${slot.key}`}
                  list={`options-${slot.key}`}
                  value={draft.accessories[slot.key]}
                  onChange={(e) => setAccessory(slot.key, e.target.value)}
                />
                <datalist id={`options-${slot.key}`}>
                  {suggestions.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </div>
            );
          })}
        </div>
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
              This creates a new block starting {formatDate(draft.startDate)}. Choosing today's date
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
