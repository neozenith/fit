/**
 * The canonical exercise list.
 *
 * Taken verbatim from the Google Form this application replaces, which was the
 * only place a *complete* list ever existed. The imported archive is not a
 * substitute: it contains only what was actually performed, so every movement
 * that was offered but never logged — and every one logged only once under a
 * slightly different name — would silently vanish from a picker built from it.
 *
 * Used as the floor, not the ceiling. Pickers union this with whatever the
 * catalogue holds and still accept free text, because the source spreadsheet
 * did and a closed list refuses every new movement by construction.
 */
export const CANONICAL_EXERCISES = [
  "Barbell Back Squat",
  "Barbell Bench Press",
  "Barbell Bench Press (inclined)",
  "Barbell Clean",
  "Barbell Deadlift",
  "Barbell Front Squat",
  "Barbell Hip thrusts",
  "Barbell Overhead Squat",
  "Barbell Pendlay Row",
  "Barbell Power Snatch",
  "Barbell Shoulder Press",
  "Cable Pallof Press",
  "Cable Woodchop",
  "Dumbbell Bench Press",
  "Dumbbell Bicep Curls",
  "Dumbbell Lateral Raise",
  "Dumbbell Piston Press",
  "Dumbbell Prone Bench Row Flat",
  "Dumbbell Prone Bench Row Inclined",
  "Dumbbell Single Arm Bent Over Row",
  "Dumbbell Single Leg Deadlift",
  "Dumbbell Snatch",
  "Dumbbell Split Squat",
  "Dumbbell Tricep Kickbacks",
  "Hover (time)",
  "Kettlebell SA Clean (each side)",
  "Kettlebell SA Front Squat (each side)",
  "Kettlebell SA Press (each side)",
  "Kettlebell SA Row (each side)",
  "Kettlebell SA Swing (each side)",
  "Kettlebell Side Lunge",
  "Landmine SA Row",
  "Landmine Twist",
  "Pendlay Row",
  "Plank (time)",
  "Plank Shoulder Taps (each side)",
  "Plate Deadbug",
  "Plate Overhead Lunges",
  "Plate Overhead Tricep Extension",
  "Plate Press Single Arm (Edge Up)",
  "Plate Press Single Arm (Face Up)",
  "Plate Russian Twist",
  "Plate Woodchop",
  "Pull up",
  "Push ups",
  "Push ups (feet elevated)",
  "Romanian Dead Lift",
  "Rower",
] as const;

/**
 * The canonical list plus anything else observed, de-duplicated and sorted.
 *
 * Order is alphabetical rather than by frequency: this feeds a searchable
 * picker, where predictable position beats a ranking nobody can see.
 */
export const mergeExerciseNames = (...extra: readonly string[][]): string[] =>
  [...new Set([...CANONICAL_EXERCISES, ...extra.flat()].map((n) => n.trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
