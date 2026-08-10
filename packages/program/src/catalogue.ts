/**
 * The exercise catalogue: what a movement IS, independent of any one session.
 *
 * Two axes, because two different questions get asked of it:
 *
 *   EQUIPMENT answers "what do I need" — the axis for filtering history.
 *   MOVEMENT answers "what does this train" — the axis for filling a
 *   prescribed accessory slot, where "a horizontal pull" is the requirement
 *   and the specific bar is the choice.
 *
 * Only the second one is new, and it exists because equipment could not do the
 * job: the deadlift-variation slot was offering a hardcoded list of four, so
 * Romanian Deadlift — unambiguously a hinge, and in the log 5 times — could not
 * be picked. A hardcoded menu per slot is a second source of truth that goes
 * stale the moment a movement is learned.
 */

/**
 * Both axes are VOCABULARIES, not enums.
 *
 * They were closed `as const` unions, which meant adding a kind of equipment was
 * a code change and a deploy. That is the wrong shape for this data: the
 * catalogue's own Lens (ADR-0034) says a value consulted from several places
 * should have one home as data, and equipment is exactly that — "Band" was
 * missing, so every banded movement was filed under `Machine`, which is not
 * what a banded lat pulldown is by any reading.
 *
 * What lives here is the SEED. The stored vocabulary starts from it and
 * diverges; nothing in this package reads a vocabulary to make a decision, so
 * a value it has never heard of is not an error.
 */

export type Movement = string;
export type Equipment = string;

/**
 * Movement keys are SLUGS and the label is separate, because `SLOT_MOVEMENT`
 * references a key. Renaming "Horizontal pull" to "Horizontal pulling" must not
 * silently empty the accessory slot that asks for it.
 */
export const SEED_MOVEMENTS: readonly { key: string; label: string }[] = [
  { key: "squat", label: "Squat" },
  { key: "hinge", label: "Hinge" },
  { key: "lunge", label: "Lunge" },
  { key: "horizontal-push", label: "Horizontal push" },
  { key: "vertical-push", label: "Vertical push" },
  { key: "horizontal-pull", label: "Horizontal pull" },
  { key: "vertical-pull", label: "Vertical pull" },
  { key: "olympic", label: "Olympic" },
  { key: "core", label: "Core" },
  { key: "carry", label: "Carry" },
  { key: "conditioning", label: "Conditioning" },
  { key: "other", label: "Other" },
];

export const SEED_EQUIPMENT: readonly string[] = [
  "Barbell",
  "Dumbbell",
  "Kettlebell",
  "Cable",
  "Band",
  "Landmine",
  "Plate",
  "Machine",
  "Bodyweight",
  "Other",
];

/** Fallback label for a movement key with no entry — never silently blank. */
export const movementLabel = (
  key: string,
  vocabulary: readonly { key: string; label: string }[] = SEED_MOVEMENTS,
): string => vocabulary.find((m) => m.key === key)?.label ?? key;

/**
 * Every optional field is `| undefined`, not a bare `?`.
 *
 * Under `exactOptionalPropertyTypes` an absent key and a present-undefined one
 * are different types, and a zod-parsed object produces the latter — so a bare
 * `?` rejects exactly the value the API's own parser hands it.
 */
export interface CatalogueEntry {
  exercise: string;
  equipment: Equipment;
  movement: Movement;
  /** Recorded per side, so its volume is not comparable to a bilateral lift. */
  unilateral?: boolean | undefined;
  /** `reps` are seconds held, so volume is undefined for it. */
  isometric?: boolean | undefined;
  /** Loaded by the athlete's own mass rather than by a plate. */
  bodyweightLoaded?: boolean | undefined;
  /** Hidden from pickers without erasing its history. */
  retired?: boolean | undefined;
}

/**
 * The seed catalogue.
 *
 * Every movement the Google Form offered, plus everything the imported archive
 * contains, each classified on both axes. This is the FLOOR: the curated
 * catalogue in DynamoDB starts here and diverges as entries are corrected, so a
 * fresh environment is useful before anyone has curated anything.
 */
export const SEED_CATALOGUE: CatalogueEntry[] = [
  { exercise: "Barbell Back Squat", equipment: "Barbell", movement: "squat" },
  { exercise: "Barbell Front Squat", equipment: "Barbell", movement: "squat" },
  { exercise: "Barbell Overhead Squat", equipment: "Barbell", movement: "squat" },
  { exercise: "Barbell Deadlift", equipment: "Barbell", movement: "hinge" },
  { exercise: "Romanian Dead Lift", equipment: "Barbell", movement: "hinge" },
  { exercise: "Barbell Hip thrusts", equipment: "Barbell", movement: "hinge" },
  { exercise: "Barbell Bench Press", equipment: "Barbell", movement: "horizontal-push" },
  {
    exercise: "Barbell Bench Press (inclined)",
    equipment: "Barbell",
    movement: "horizontal-push",
  },
  { exercise: "Barbell Shoulder Press", equipment: "Barbell", movement: "vertical-push" },
  { exercise: "Barbell Pendlay Row", equipment: "Barbell", movement: "horizontal-pull" },
  { exercise: "Pendlay Row", equipment: "Barbell", movement: "horizontal-pull" },
  { exercise: "Barbell Clean", equipment: "Barbell", movement: "olympic" },
  { exercise: "Barbell Power Snatch", equipment: "Barbell", movement: "olympic" },

  { exercise: "Dumbbell Bench Press", equipment: "Dumbbell", movement: "horizontal-push" },
  { exercise: "Dumbbell Piston Press", equipment: "Dumbbell", movement: "vertical-push" },
  { exercise: "Dumbbell Lateral Raise", equipment: "Dumbbell", movement: "vertical-push" },
  {
    exercise: "Dumbbell Prone Bench Row Flat",
    equipment: "Dumbbell",
    movement: "horizontal-pull",
  },
  {
    exercise: "Dumbbell Prone Bench Row Inclined",
    equipment: "Dumbbell",
    movement: "horizontal-pull",
  },
  {
    exercise: "Dumbbell Single Arm Bent Over Row",
    equipment: "Dumbbell",
    movement: "horizontal-pull",
    unilateral: true,
  },
  {
    exercise: "Dumbbell Single Leg Deadlift",
    equipment: "Dumbbell",
    movement: "hinge",
    unilateral: true,
  },
  { exercise: "Dumbbell Snatch", equipment: "Dumbbell", movement: "olympic", unilateral: true },
  { exercise: "Dumbbell Split Squat", equipment: "Dumbbell", movement: "lunge" },
  { exercise: "Dumbbell Bicep Curls", equipment: "Dumbbell", movement: "other" },
  { exercise: "Dumbbell Tricep Kickbacks", equipment: "Dumbbell", movement: "other" },

  {
    exercise: "Kettlebell SA Swing (each side)",
    equipment: "Kettlebell",
    movement: "hinge",
    unilateral: true,
  },
  {
    exercise: "Kettlebell SA Row (each side)",
    equipment: "Kettlebell",
    movement: "horizontal-pull",
    unilateral: true,
  },
  {
    exercise: "Kettlebell SA Clean (each side)",
    equipment: "Kettlebell",
    movement: "olympic",
    unilateral: true,
  },
  {
    exercise: "Kettlebell SA Front Squat (each side)",
    equipment: "Kettlebell",
    movement: "squat",
    unilateral: true,
  },
  {
    exercise: "Kettlebell SA Press (each side)",
    equipment: "Kettlebell",
    movement: "vertical-push",
    unilateral: true,
  },
  { exercise: "Kettlebell Side Lunge", equipment: "Kettlebell", movement: "lunge" },

  { exercise: "Cable Pallof Press", equipment: "Cable", movement: "core" },
  { exercise: "Cable Woodchop", equipment: "Cable", movement: "core" },

  {
    exercise: "Landmine SA Row",
    equipment: "Landmine",
    movement: "horizontal-pull",
    unilateral: true,
  },
  { exercise: "Landmine Twist", equipment: "Landmine", movement: "core" },

  { exercise: "Plate Deadbug", equipment: "Plate", movement: "core" },
  { exercise: "Plate Russian Twist", equipment: "Plate", movement: "core" },
  { exercise: "Plate Woodchop", equipment: "Plate", movement: "core" },
  { exercise: "Plate Overhead Lunges", equipment: "Plate", movement: "lunge" },
  { exercise: "Plate Overhead Tricep Extension", equipment: "Plate", movement: "other" },
  {
    exercise: "Plate Press Single Arm (Edge Up)",
    equipment: "Plate",
    movement: "horizontal-push",
    unilateral: true,
  },
  {
    exercise: "Plate Press Single Arm (Face Up)",
    equipment: "Plate",
    movement: "horizontal-push",
    unilateral: true,
  },

  {
    exercise: "Pull up",
    equipment: "Bodyweight",
    movement: "vertical-pull",
    bodyweightLoaded: true,
  },
  {
    exercise: "Push ups",
    equipment: "Bodyweight",
    movement: "horizontal-push",
    bodyweightLoaded: true,
  },
  {
    exercise: "Push ups (feet elevated)",
    equipment: "Bodyweight",
    movement: "horizontal-push",
    bodyweightLoaded: true,
  },
  {
    exercise: "Plank Shoulder Taps (each side)",
    equipment: "Bodyweight",
    movement: "core",
    unilateral: true,
  },
  { exercise: "Plank (time)", equipment: "Bodyweight", movement: "core", isometric: true },
  { exercise: "Hover (time)", equipment: "Bodyweight", movement: "core", isometric: true },
  { exercise: "Rower", equipment: "Machine", movement: "conditioning" },

  // The program's own accessory menus. They were a hardcoded list per slot,
  // which is exactly the second source of truth this catalogue replaces — so
  // they are entries here like everything else.
  { exercise: "Dumbbell Row", equipment: "Dumbbell", movement: "horizontal-pull" },
  { exercise: "Barbell Row", equipment: "Barbell", movement: "horizontal-pull" },
  { exercise: "Machine Row", equipment: "Machine", movement: "horizontal-pull" },
  { exercise: "Olympic Ring Row", equipment: "Bodyweight", movement: "horizontal-pull" },
  { exercise: "Seated Dumbbell OHP", equipment: "Dumbbell", movement: "vertical-push" },
  { exercise: "Standing Dumbbell OHP", equipment: "Dumbbell", movement: "vertical-push" },
  { exercise: "Military Press", equipment: "Barbell", movement: "vertical-push" },
  {
    exercise: "Weighted Pull-up",
    equipment: "Bodyweight",
    movement: "vertical-pull",
    bodyweightLoaded: true,
  },
  {
    exercise: "Weighted Chin-up",
    equipment: "Bodyweight",
    movement: "vertical-pull",
    bodyweightLoaded: true,
  },
  { exercise: "Lat Pulldown", equipment: "Machine", movement: "vertical-pull" },
  // A band, not a machine. It was filed under Machine only because the seed
  // vocabulary had no "Band" in it — the closed enum did not just omit a value,
  // it silently mis-classified every movement that needed one.
  { exercise: "Banded Lat Pulldown", equipment: "Band", movement: "vertical-pull" },
  { exercise: "Stiff Legged Deadlift", equipment: "Barbell", movement: "hinge" },
  { exercise: "Snatch Grip Deadlift", equipment: "Barbell", movement: "hinge" },
  { exercise: "Deficit Deadlift", equipment: "Barbell", movement: "hinge" },
  { exercise: "Pause Deadlift", equipment: "Barbell", movement: "hinge" },
  {
    exercise: "Landmine Single-Arm Overhead Press",
    equipment: "Landmine",
    movement: "vertical-push",
    unilateral: true,
  },
  {
    exercise: "Landmine Single-Arm Row",
    equipment: "Landmine",
    movement: "horizontal-pull",
    unilateral: true,
  },
  { exercise: "Plate Push Press", equipment: "Plate", movement: "vertical-push" },
  { exercise: "Dumbbell Lunges", equipment: "Dumbbell", movement: "lunge" },
];

/**
 * Which movement each prescribed accessory slot requires.
 *
 * This is what makes the pickers derive from the catalogue rather than from a
 * per-slot list. The program asks for "a horizontal pull"; which one is the
 * athlete's choice, and the catalogue already knows which movements qualify.
 */
export const SLOT_MOVEMENT: Record<string, Movement | null> = {
  upperBackHorizontal: "horizontal-pull",
  shoulder: "vertical-push",
  upperBackVertical: "vertical-pull",
  deadliftVariation: "hinge",
  // The spreadsheet's optional slots were free choice, and stay that way.
  optional1: null,
  optional2: null,
  optionalLower1: null,
  optionalLower2: null,
};

/**
 * Movement keys a prescribed slot depends on.
 *
 * Deleting one of these is what turns an accessory picker into an empty list —
 * the slot asks for a movement nothing is classified as any more, and the
 * failure is silent because an empty picker looks like a filtering choice. The
 * API refuses the delete instead, and the UI marks these as in use.
 *
 * Derived from `SLOT_MOVEMENT` rather than listed, so a slot added later is
 * protected without anyone remembering to update a second list.
 */
export const SLOT_REQUIRED_MOVEMENTS: readonly string[] = [
  ...new Set(Object.values(SLOT_MOVEMENT).filter((m): m is string => m !== null)),
];
