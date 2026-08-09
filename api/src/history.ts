import { ARCHIVE_BUCKET } from "./const.js";
import { parquetGlob, queryParquet, toNumber } from "./query.js";

/**
 * Analytics over the imported training history.
 *
 * The source is five years of a spreadsheet, curated into Parquet by
 * `tools/curate_history.py` and published to this environment's archive bucket
 * by `tools/publish-history.ts`. Only FACTS were imported — sets, weigh-ins,
 * activities, and the exercise catalogue. Every number below is derived here,
 * in SQL, rather than read from one of the workbook's twenty-eight pivot
 * sheets.
 *
 * That distinction is the whole design. A pivot table imported as data is an
 * answer with no question attached: it cannot be re-derived, cannot be checked,
 * and silently keeps whatever assumptions its author had in 2021. Deriving here
 * means every chart in the app is reproducible from the facts, and a
 * disagreement with the spreadsheet is a question that can actually be settled.
 *
 * Read with DuckDB straight off S3 (ADR-0025). The dataset is ~2000 rows, which
 * is why no aggregate is precomputed and no cache exists: a full scan of every
 * table costs less than the bookkeeping to avoid it.
 */

const TABLES = ["strength_sets", "body_metrics", "cardio_activities", "exercises"] as const;
export type HistoryTable = (typeof TABLES)[number];

/** `s3://{archive}/history/{table}/**\/*.parquet` — the layout publish-history writes. */
const source = (table: HistoryTable): string => parquetGlob(ARCHIVE_BUCKET, `history/${table}`);

/**
 * The shape returned when there is no imported history.
 *
 * An environment can be perfectly healthy and hold no history: the import is a
 * deliberate operator action, not part of a deploy. Saying so explicitly beats
 * an empty chart, which is indistinguishable from a broken query.
 */
export interface Unavailable {
  available: false;
  reason: string;
}

const UNAVAILABLE: Unavailable = {
  available: false,
  reason: "No training history has been imported into this environment yet.",
};

const noBucket = (): boolean => ARCHIVE_BUCKET === "";

/** Rep counts the workbook tracked as milestones, and the app keeps. */
export const REP_MAXES = [1, 3, 5, 10, 12] as const;

export interface HistorySummary {
  available: true;
  from: string;
  to: string;
  sessions: number;
  sets: number;
  totalVolumeKg: number;
  exercises: number;
  activities: number;
  weighIns: number;
  weightFirstKg: number | null;
  weightLatestKg: number | null;
}

export const summary = async (): Promise<HistorySummary | Unavailable> => {
  if (noBucket()) return UNAVAILABLE;

  const strength = await queryParquet<Record<string, unknown>>(
    source("strength_sets"),
    `
    SELECT
      min(date)::VARCHAR              AS from_date,
      max(date)::VARCHAR              AS to_date,
      count(DISTINCT date)            AS sessions,
      count(*)                        AS sets,
      COALESCE(sum(volume_kg), 0)     AS total_volume_kg,
      count(DISTINCT exercise)        AS exercises
    FROM read_parquet(?)
    `,
    [source("strength_sets")],
  );
  if (strength === null) return UNAVAILABLE;

  // Absent siblings are NOT fatal. Strength is the spine of this dataset;
  // cardio and weigh-ins are independent imports that may legitimately not be
  // there, and reporting zero for them is accurate rather than degraded.
  const cardio = await queryParquet<{ n: bigint }>(
    source("cardio_activities"),
    "SELECT count(*) AS n FROM read_parquet(?)",
    [source("cardio_activities")],
  );
  const body = await queryParquet<Record<string, unknown>>(
    source("body_metrics"),
    `
    SELECT
      count(*)                                          AS n,
      first(weight_kg ORDER BY measured_at)             AS first_kg,
      last(weight_kg ORDER BY measured_at)              AS latest_kg
    FROM read_parquet(?)
    `,
    [source("body_metrics")],
  );

  const s = strength[0] ?? {};
  const b = body?.[0] ?? {};
  return {
    available: true,
    from: String(s["from_date"] ?? ""),
    to: String(s["to_date"] ?? ""),
    sessions: toNumber(s["sessions"]),
    sets: toNumber(s["sets"]),
    totalVolumeKg: Math.round(toNumber(s["total_volume_kg"])),
    exercises: toNumber(s["exercises"]),
    activities: toNumber(cardio?.[0]?.n),
    weighIns: toNumber(b["n"]),
    weightFirstKg: b["first_kg"] === undefined ? null : toNumber(b["first_kg"]),
    weightLatestKg: b["latest_kg"] === undefined ? null : toNumber(b["latest_kg"]),
  };
};

export interface ExerciseRow {
  exercise: string;
  equipment: string;
  entries: number;
  totalSets: number;
  totalVolumeKg: number;
  heaviestKg: number;
  firstSeen: string;
  lastSeen: string;
  isIsometric: boolean;
  isUnilateral: boolean;
  isBodyweightLoaded: boolean;
}

/**
 * The exercise catalogue.
 *
 * Read from the curated table rather than re-derived with a `GROUP BY`, because
 * the catalogue carries classifications (isometric, unilateral,
 * bodyweight-loaded) that are judgements about the movement, not facts about
 * the log. Those belong to curation, where they are reviewable in one file.
 */
export const exercises = async (): Promise<
  { available: true; exercises: ExerciseRow[] } | Unavailable
> => {
  if (noBucket()) return UNAVAILABLE;
  const rows = await queryParquet<Record<string, unknown>>(
    source("exercises"),
    `
    SELECT * FROM read_parquet(?)
    ORDER BY total_volume_kg DESC NULLS LAST, exercise
    `,
    [source("exercises")],
  );
  if (rows === null) return UNAVAILABLE;

  return {
    available: true,
    exercises: rows.map((r) => ({
      exercise: String(r["exercise"]),
      equipment: String(r["equipment"] ?? "Other"),
      entries: toNumber(r["entries"]),
      totalSets: toNumber(r["total_sets"]),
      totalVolumeKg: Math.round(toNumber(r["total_volume_kg"])),
      heaviestKg: toNumber(r["heaviest_kg"]),
      firstSeen: String(r["first_seen"] ?? "").slice(0, 10),
      lastSeen: String(r["last_seen"] ?? "").slice(0, 10),
      isIsometric: Boolean(r["is_isometric"]),
      isUnilateral: Boolean(r["is_unilateral"]),
      isBodyweightLoaded: Boolean(r["is_bodyweight_loaded"]),
    })),
  };
};

export interface VolumePoint {
  period: string;
  exercise: string;
  volumeKg: number;
  sets: number;
  topWeightKg: number;
}

/**
 * Training volume over time, weekly or monthly.
 *
 * `date_trunc('week', ...)` is ISO — weeks start Monday. The workbook started
 * them on Sunday, so a week's totals will not line up cell-for-cell with it.
 * That is a deliberate choice of the standard over the spreadsheet's habit;
 * the totals over any full month are identical either way.
 */
export const volume = async (
  grain: "week" | "month",
  exercise?: string,
): Promise<{ available: true; grain: string; points: VolumePoint[] } | Unavailable> => {
  if (noBucket()) return UNAVAILABLE;

  const rows = await queryParquet<Record<string, unknown>>(
    source("strength_sets"),
    `
    SELECT
      strftime(date_trunc('${grain}', date), '%Y-%m-%d') AS period,
      exercise                                           AS exercise,
      COALESCE(sum(volume_kg), 0)                        AS volume_kg,
      sum(sets)                                          AS sets,
      max(weight_kg)                                     AS top_weight_kg
    FROM read_parquet(?)
    WHERE is_isometric = false
      AND (? IS NULL OR exercise = ?)
    GROUP BY period, exercise
    ORDER BY period, volume_kg DESC
    `,
    [source("strength_sets"), exercise ?? null, exercise ?? null],
  );
  if (rows === null) return UNAVAILABLE;

  return {
    available: true,
    grain,
    points: rows.map((r) => ({
      period: String(r["period"]),
      exercise: String(r["exercise"]),
      volumeKg: Math.round(toNumber(r["volume_kg"])),
      sets: toNumber(r["sets"]),
      topWeightKg: toNumber(r["top_weight_kg"]),
    })),
  };
};

export interface RepMaxRow {
  exercise: string;
  reps: number;
  weightKg: number;
  achievedOn: string;
  bodyweightRatio: number | null;
}

/**
 * Heaviest load ever moved for at least N reps, per exercise.
 *
 * "At least" is the point, and it is where a naive `WHERE reps = N` gets it
 * wrong: a set of 10 at 100kg is proof of a 5-rep max of at least 100kg, so
 * excluding it would report a 5RM lower than a set that was actually performed.
 * The workbook's own `MaxWeightPerReps` sheet does the same thing, which is how
 * its 3RM and 5RM columns come to hold identical values for several lifts.
 *
 * The bodyweight ratio joins to the weigh-in NEAREST the lift — an ASOF join,
 * not an equality join. Weigh-ins and sessions are independent events that
 * rarely share a date; requiring them to match would drop most of the rows.
 */
export const repMaxes = async (): Promise<
  { available: true; repMaxes: RepMaxRow[] } | Unavailable
> => {
  if (noBucket()) return UNAVAILABLE;

  const rows = await queryParquet<Record<string, unknown>>(
    source("strength_sets"),
    `
    WITH sets AS (
      SELECT date, exercise, reps, weight_kg
      FROM read_parquet(?)
      WHERE is_isometric = false AND weight_kg > 0
    ),
    weigh_ins AS (
      SELECT date, weight_kg AS bodyweight_kg FROM read_parquet(?)
    ),
    targets AS (SELECT unnest([1, 3, 5, 10, 12]) AS target_reps),
    ranked AS (
      SELECT
        s.exercise,
        t.target_reps,
        s.weight_kg,
        s.date,
        row_number() OVER (
          PARTITION BY s.exercise, t.target_reps
          ORDER BY s.weight_kg DESC, s.date ASC
        ) AS rank
      FROM sets s
      CROSS JOIN targets t
      WHERE s.reps >= t.target_reps
    )
    SELECT r.exercise, r.target_reps, r.weight_kg, r.date::VARCHAR AS achieved_on, w.bodyweight_kg
    FROM ranked r
    ASOF LEFT JOIN weigh_ins w ON r.date >= w.date
    WHERE r.rank = 1
    ORDER BY r.exercise, r.target_reps
    `,
    [source("strength_sets"), source("body_metrics")],
  );
  if (rows === null) return UNAVAILABLE;

  return {
    available: true,
    repMaxes: rows.map((r) => {
      const bodyweight = r["bodyweight_kg"] == null ? null : toNumber(r["bodyweight_kg"]);
      const weightKg = toNumber(r["weight_kg"]);
      return {
        exercise: String(r["exercise"]),
        reps: toNumber(r["target_reps"]),
        weightKg,
        achievedOn: String(r["achieved_on"] ?? "").slice(0, 10),
        bodyweightRatio:
          bodyweight && bodyweight > 0 ? Math.round((weightKg / bodyweight) * 1000) / 1000 : null,
      };
    }),
  };
};

export interface BodyPoint {
  date: string;
  weightKg: number;
  bmi: number;
  trendKg: number;
}

/**
 * Body weight over time, with a 7-day trailing mean.
 *
 * The raw series swings a kilo or more between consecutive mornings — hydration
 * and gut content, not tissue. Charting it alone invites reading noise as
 * progress, which is why the smoothed line is computed here and returned
 * alongside rather than left to the client.
 */
export const bodyweight = async (): Promise<
  { available: true; points: BodyPoint[] } | Unavailable
> => {
  if (noBucket()) return UNAVAILABLE;

  const rows = await queryParquet<Record<string, unknown>>(
    source("body_metrics"),
    `
    WITH daily AS (
      SELECT date, avg(weight_kg) AS weight_kg, avg(bmi) AS bmi
      FROM read_parquet(?)
      GROUP BY date
    )
    SELECT
      date::VARCHAR AS date,
      round(weight_kg, 2) AS weight_kg,
      round(bmi, 2)       AS bmi,
      round(avg(weight_kg) OVER (
        ORDER BY date RANGE BETWEEN INTERVAL 6 DAYS PRECEDING AND CURRENT ROW
      ), 2) AS trend_kg
    FROM daily
    ORDER BY date
    `,
    [source("body_metrics")],
  );
  if (rows === null) return UNAVAILABLE;

  return {
    available: true,
    points: rows.map((r) => ({
      date: String(r["date"]).slice(0, 10),
      weightKg: toNumber(r["weight_kg"]),
      bmi: toNumber(r["bmi"]),
      trendKg: toNumber(r["trend_kg"]),
    })),
  };
};

export interface CardioWeek {
  week: string;
  activities: number;
  distanceKm: number;
  movingHours: number;
  elevationM: number;
  avgWattsPerKg: number | null;
}

/**
 * Weekly cardio, with power normalised by the body weight of the time.
 *
 * Watts alone are not comparable across five years during which body weight
 * moved by more than ten kilos; watts per kilogram is. The weigh-in is again
 * matched ASOF — nearest on or before the ride.
 */
export const cardio = async (): Promise<{ available: true; weeks: CardioWeek[] } | Unavailable> => {
  if (noBucket()) return UNAVAILABLE;

  const rows = await queryParquet<Record<string, unknown>>(
    source("cardio_activities"),
    `
    WITH activities AS (
      SELECT date, distance_m, moving_s, elevation_m, weighted_average_watts
      FROM read_parquet(?)
    ),
    weigh_ins AS (
      SELECT date, weight_kg FROM read_parquet(?)
    ),
    joined AS (
      SELECT a.*, w.weight_kg AS bodyweight_kg
      FROM activities a
      ASOF LEFT JOIN weigh_ins w ON a.date >= w.date
    )
    SELECT
      strftime(date_trunc('week', date), '%Y-%m-%d') AS week,
      count(*)                                        AS activities,
      round(sum(distance_m) / 1000.0, 2)              AS distance_km,
      round(sum(moving_s) / 3600.0, 2)                AS moving_hours,
      round(sum(elevation_m), 0)                      AS elevation_m,
      round(avg(weighted_average_watts / nullif(bodyweight_kg, 0)), 2) AS avg_watts_per_kg
    FROM joined
    GROUP BY week
    ORDER BY week
    `,
    [source("cardio_activities"), source("body_metrics")],
  );
  if (rows === null) return UNAVAILABLE;

  return {
    available: true,
    weeks: rows.map((r) => ({
      week: String(r["week"]),
      activities: toNumber(r["activities"]),
      distanceKm: toNumber(r["distance_km"]),
      movingHours: toNumber(r["moving_hours"]),
      elevationM: toNumber(r["elevation_m"]),
      avgWattsPerKg: r["avg_watts_per_kg"] == null ? null : toNumber(r["avg_watts_per_kg"]),
    })),
  };
};

export interface StreakRow {
  start: string;
  end: string;
  days: number;
  activeDays: number;
}

/**
 * Runs of consecutive active days, counting a lift and a ride alike.
 *
 * The gap tolerance is TWO days, matching the workbook's own "allowable streak
 * gap": training six days a week with a rest day should read as one streak, not
 * as six one-day streaks. A strict definition would make the metric describe
 * the rest schedule instead of the training.
 *
 * Implemented as the classic gaps-and-islands: a new island starts wherever the
 * gap from the previous active day exceeds the tolerance, and a running sum of
 * those markers labels each island.
 */
export const streaks = async (
  limit = 20,
): Promise<{ available: true; streaks: StreakRow[] } | Unavailable> => {
  if (noBucket()) return UNAVAILABLE;

  const rows = await queryParquet<Record<string, unknown>>(
    source("strength_sets"),
    `
    WITH active AS (
      SELECT DISTINCT date FROM read_parquet(?)
      UNION
      SELECT DISTINCT date FROM read_parquet(?)
    ),
    gaps AS (
      SELECT
        date,
        CASE
          WHEN lag(date) OVER (ORDER BY date) IS NULL THEN 1
          WHEN date_diff('day', lag(date) OVER (ORDER BY date), date) > 2 THEN 1
          ELSE 0
        END AS is_new_island
      FROM active
    ),
    islands AS (
      SELECT date, sum(is_new_island) OVER (ORDER BY date) AS island FROM gaps
    )
    SELECT
      min(date)::VARCHAR                     AS start,
      max(date)::VARCHAR                     AS "end",
      date_diff('day', min(date), max(date)) + 1 AS days,
      count(*)                               AS active_days
    FROM islands
    GROUP BY island
    ORDER BY days DESC, start DESC
    LIMIT ?
    `,
    [source("strength_sets"), source("cardio_activities"), limit],
  );
  if (rows === null) return UNAVAILABLE;

  return {
    available: true,
    streaks: rows.map((r) => ({
      start: String(r["start"]).slice(0, 10),
      end: String(r["end"]).slice(0, 10),
      days: toNumber(r["days"]),
      activeDays: toNumber(r["active_days"]),
    })),
  };
};
