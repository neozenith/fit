import { useEffect, useState } from "react";
import { api, type HistoryExercise } from "./api.js";
import { useQueryParam } from "./router.jsx";

/**
 * The exercise catalogue, and the equipment filter every exercise picker gets.
 *
 * Equipment is the axis people actually think in — "what have I done with a
 * barbell" is a question; "what have I done starting with the letter B" is not.
 * So wherever an exercise can be chosen, the equipment category narrows the
 * choices first, and both live in the URL like every other filter (ADR-0027).
 *
 * Kept here rather than in each page because the two filters are COUPLED:
 * selecting an equipment category must narrow the exercise list, and changing
 * equipment must clear an exercise that is no longer in it. Duplicating that
 * across three pages is how they drift.
 */

export const useCatalogue = (): { exercises: HistoryExercise[]; loaded: boolean } => {
  const [exercises, setExercises] = useState<HistoryExercise[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api
      .historyExercises()
      .then((r) => setExercises(r.available ? r.exercises : []))
      // An absent catalogue is not an error for the pages that use it — they
      // simply offer no exercise filter. The page's own data request reports
      // any real failure.
      .catch(() => setExercises([]))
      .finally(() => setLoaded(true));
  }, []);

  return { exercises, loaded };
};

export interface ExerciseSelection {
  equipment: string;
  exercise: string;
  /** Every equipment category present in the catalogue, ordered by size. */
  equipmentOptions: Array<{ value: string; label: string }>;
  /** Exercises within the selected category, or all of them. */
  exerciseOptions: Array<{ value: string; label: string }>;
  /** Request parameters, omitting whichever filters are unset. */
  params: Record<string, string>;
}

/**
 * The coupled equipment + exercise selection, read from and written to the URL.
 *
 * When the chosen exercise is not in the chosen equipment category the exercise
 * is IGNORED rather than silently corrected. Rewriting the URL on load would
 * mean a shared link quietly becomes a different link, which breaks the
 * addressability contract in the one case where it matters most — someone
 * else's link arriving with an unexpected combination.
 */
export const useExerciseSelection = (exercises: HistoryExercise[]): ExerciseSelection => {
  const [equipment] = useQueryParam("equipment", "");
  const [exercise] = useQueryParam("exercise", "");

  const counts = new Map<string, number>();
  for (const e of exercises) counts.set(e.equipment, (counts.get(e.equipment) ?? 0) + 1);

  const equipmentOptions = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, n]) => ({ value, label: `${value} (${n})` }));

  const inCategory = equipment ? exercises.filter((e) => e.equipment === equipment) : exercises;
  const exerciseOptions = [...inCategory]
    .sort((a, b) => a.exercise.localeCompare(b.exercise))
    .map((e) => ({ value: e.exercise, label: e.exercise }));

  const effective = inCategory.some((e) => e.exercise === exercise) ? exercise : "";

  return {
    equipment,
    exercise: effective,
    equipmentOptions,
    exerciseOptions,
    params: {
      ...(equipment ? { equipment } : {}),
      ...(effective ? { exercise: effective } : {}),
    },
  };
};
