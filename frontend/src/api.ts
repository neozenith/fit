import type {
  BlockConfig,
  CustomProgramDefinition,
  LoggedExerciseActivity,
  MeasurementRecord,
  ProgramParameterSpec,
  Session,
  StoredSessionPlan,
} from "@fit/program";

/**
 * The API client.
 *
 * Same-origin by construction: locally Vite proxies `/api`, and deployed
 * CloudFront serves both the SPA and the API from one hostname. That means no
 * CORS configuration exists anywhere, and the session cookie is simply sent —
 * which is exactly why the dev server proxies rather than pointing at another
 * origin (ADR-0016).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    // Sends the __session cookie. Without it every request is anonymous and the
    // edge answers 401 to the fetch rather than redirecting it — see below.
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init?.headers },
  });

  if (response.status === 401) {
    // The edge answers /api/* with 401 rather than a 302 to the IdP, because
    // following a cross-origin redirect from fetch produces an opaque CORS
    // failure the SPA cannot act on. A full-page navigation CAN follow it, so
    // that is what happens here.
    window.location.href = `/oauth2/start?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError(401, "not authenticated — redirecting to sign in");
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof body["error"] === "string" ? body["error"] : `request failed (${response.status})`,
      body["issues"],
    );
  }

  return body as T;
};

export interface CuratedExercise {
  exercise: string;
  equipment: string;
  movement: string;
  unilateral?: boolean;
  isometric?: boolean;
  bodyweightLoaded?: boolean;
  retired?: boolean;
  /** True when a stored override exists rather than the shipped seed value. */
  curated?: boolean;
}

/**
 * A word in one of the two classification vocabularies.
 *
 * `key` is the stable identifier catalogue entries and `SLOT_MOVEMENT` store;
 * `label` is only what gets displayed, so relabelling can never orphan a slot.
 */
export interface VocabularyWord {
  key: string;
  label: string;
  retired?: boolean;
  curated?: boolean;
  /** A prescribed accessory slot needs this movement, so it cannot be retired. */
  inUseBySlot?: boolean;
}

export type VocabularyAxis = "equipment" | "movement";
export type Vocabularies = Record<VocabularyAxis, VocabularyWord[]>;

/**
 * A Program as the API describes it — everything but the schedule function.
 *
 * `origin` is the ONLY thing distinguishing a built-in from one the athlete
 * authored, and it exists so the UI can label it, not so anything can branch on
 * it (ADR-0037).
 */
export interface ProgramSummary {
  programId: string;
  name: string;
  description: string;
  attribution: string | null;
  origin: "builtin" | "custom";
  parameters: ProgramParameterSpec[];
}

export interface BlockSummary {
  block: BlockConfig;
  program: ProgramSummary | null;
  /** The block's program no longer resolves. Its logged history still stands. */
  programMissing?: boolean;
  progress: BlockProgress;
  sessionCount: number;
  completeCount: number;
  firstDate: string;
  lastDate: string;
  /** How many earlier versions of this block exist (ADR-0029). */
  supersededCount: number;
  /** Hidden by a delete record. Its config and its logged activities still exist. */
  deleted?: boolean;
  /** Activities logged at or before this are excluded from progress. */
  resetAt?: string | null;
}

/** One set as it was actually recorded. */
export interface LoggedSet {
  timestamp: string;
  reps: number;
  weight?: number;
  setIndex?: number;
}

/**
 * Sets logged per session, keyed `week-day` then exercise name.
 *
 * The SETS, not a tally: the log marks off one prescribed set at a time, so it
 * has to show what was recorded against each.
 */
export type BlockProgress = Record<string, Record<string, LoggedSet[]>>;

export interface Identity {
  email: string;
  actor: string;
  environment: string;
}

export interface WeeklyMedian {
  weekStart: string;
  bodyWeight?: number;
  waistCircumference?: number;
}

export interface PersonalBest {
  weight: number;
  reps: number;
  estimated: number;
  timestamp: string;
}

/**
 * One logged activity as it comes back from the API.
 *
 * `kind` and `id` are optional because five years of imported history and every
 * pre-rebuild write predate both (ADR-0038).
 */
export type LoggedActivity = Omit<LoggedExerciseActivity, "kind" | "id"> & {
  kind?: "logged";
  id?: string;
};

/** A custom program whose plans no longer compile, and why. */
export interface BrokenProgram {
  programId: string;
  name: string;
  reason: string;
}

export const api = {
  me: () => request<Identity>("/api/me"),

  currentBlock: () =>
    request<{
      block: BlockConfig | null;
      program: ProgramSummary | null;
      programMissing?: boolean;
      sessions: Session[];
      progress: BlockProgress;
      /** How many blocks exist at all — "never made one" vs "this is the live one". */
      blockCount: number;
    }>("/api/blocks/current"),

  /** Every block with its own progress — the year view's single request. */
  blocks: (includeDeleted = false) =>
    request<{ blocks: BlockSummary[]; brokenPrograms: BrokenProgram[] }>(
      `/api/blocks${includeDeleted ? "?deleted=true" : ""}`,
    ),

  // --- Programs and plans ----------------------------------------------------
  // Built-in and custom arrive in ONE list. The picker does not group them, and
  // nothing here can tell them apart except by reading `origin`.

  /**
   * Every program, plus the raw definitions of the custom ones.
   *
   * The definitions come along because a `Program` carries its schedule as a
   * FUNCTION and JSON cannot. The SPA compiles them against the plans to preview
   * a custom block in the browser, using the same module the server uses.
   */
  programs: () =>
    request<{
      programs: ProgramSummary[];
      definitions: CustomProgramDefinition[];
      broken: BrokenProgram[];
    }>("/api/programs"),

  putProgram: (definition: CustomProgramDefinition) =>
    request<{ program: CustomProgramDefinition; warnings: string[] }>("/api/programs", {
      method: "PUT",
      body: JSON.stringify(definition),
    }),

  plans: () => request<{ plans: StoredSessionPlan[] }>("/api/plans"),

  putPlan: (plan: unknown) =>
    request<{ plan: StoredSessionPlan }>("/api/plans", {
      method: "PUT",
      body: JSON.stringify(plan),
    }),

  /** Delete, restore or reset one block. All three are append-only. */
  setBlockState: (blockId: string, action: "delete" | "restore" | "reset") =>
    request<{ blockId: string; action: string; at: string }>(
      `/api/blocks/${encodeURIComponent(blockId)}/state`,
      { method: "POST", body: JSON.stringify({ action }) },
    ),

  catalogue: () => request<{ exercises: CuratedExercise[] }>("/api/catalogue"),

  curateExercise: (entry: CuratedExercise) =>
    request<{ exercise: CuratedExercise }>("/api/catalogue", {
      method: "PUT",
      body: JSON.stringify(entry),
    }),

  vocabulary: () => request<Vocabularies>("/api/vocabulary"),

  putVocabulary: (axis: VocabularyAxis, word: VocabularyWord) =>
    request<{ word: VocabularyWord }>(`/api/vocabulary/${axis}`, {
      method: "PUT",
      body: JSON.stringify(word),
    }),

  sessions: (blockId: string) =>
    request<{ block: BlockConfig; program: ProgramSummary; sessions: Session[] }>(
      `/api/blocks/${encodeURIComponent(blockId)}/sessions`,
    ),

  createBlock: (body: unknown) =>
    request<{ block: BlockConfig; program: ProgramSummary }>("/api/blocks", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  projectNextBlock: (body: unknown) =>
    request<{
      config: BlockConfig;
      projections: unknown[];
      carriedForward: string[];
      note: string;
    }>("/api/blocks/project", { method: "POST", body: JSON.stringify(body) }),

  /**
   * Logged activities — the data that actually matters.
   *
   * Free of any program: an activity needs an exercise, a rep count and a
   * timestamp, and nothing else (ADR-0036).
   */
  activities: (params: { since?: string; exercise?: string } = {}) => {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][],
    );
    return request<{
      activities: LoggedActivity[];
      personalBests: Record<string, PersonalBest>;
    }>(`/api/activities${query.size > 0 ? `?${query}` : ""}`);
  },

  logActivities: (activities: unknown[]) =>
    request<{ written: number }>("/api/activities", {
      method: "POST",
      body: JSON.stringify({ activities }),
    }),

  measurements: () =>
    request<{ measurements: MeasurementRecord[]; weekly: WeeklyMedian[] }>("/api/measurements"),

  logMeasurement: (body: unknown) =>
    request<{ measurement: MeasurementRecord }>("/api/measurements", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  season: () => request<{ plan: unknown; weeks: unknown[] }>("/api/season"),

  progress: () =>
    request<{
      series: Record<string, Array<{ date: string; estimated: number }>>;
      personalBests: Record<string, PersonalBest>;
    }>("/api/progress"),

  finops: (params: Record<string, string> = {}) =>
    request<{
      available: boolean;
      reason?: string;
      groupBy?: string;
      range?: string;
      grain?: string;
      rows: Array<{ period: string; key: string; cost: number }>;
    }>(`/api/finops?${new URLSearchParams(params)}`),

  finopsRecency: () =>
    request<{ latest: string | null; ageSeconds: number | null; rows: number }>(
      "/api/finops/recency",
    ),

  // --- Imported history ------------------------------------------------------
  // Every one of these can answer `available: false` — the import is an
  // operator action, so an environment can be entirely healthy and hold none.
  //
  // Each takes the query parameters straight through from the URL, which is
  // what makes a shared link reproduce a chart exactly: the page never holds
  // filter state the address bar does not.

  history: () =>
    request<{ available: false; reason: string } | ({ available: true } & HistoryBundle)>(
      "/api/history",
    ),

  historySummary: () =>
    request<{ available: false; reason: string } | ({ available: true } & HistorySummary)>(
      "/api/history/summary",
    ),

  historyExercises: () =>
    request<
      { available: false; reason: string } | { available: true; exercises: HistoryExercise[] }
    >("/api/history/exercises"),

  historyVolume: (params: Record<string, string>) =>
    request<
      | { available: false; reason: string }
      | { available: true; grain: string; points: HistoryVolumePoint[] }
    >(`/api/history/volume?${new URLSearchParams(params)}`),

  historyRepMaxes: () =>
    request<{ available: false; reason: string } | { available: true; repMaxes: HistoryRepMax[] }>(
      "/api/history/rep-maxes",
    ),

  historyBodyweight: (params: Record<string, string> = {}) =>
    request<{ available: false; reason: string } | { available: true; points: HistoryBodyPoint[] }>(
      `/api/history/bodyweight?${new URLSearchParams(params)}`,
    ),

  historyCardio: (params: Record<string, string> = {}) =>
    request<{ available: false; reason: string } | { available: true; weeks: HistoryCardioWeek[] }>(
      `/api/history/cardio?${new URLSearchParams(params)}`,
    ),

  historyStreaks: () =>
    request<{ available: false; reason: string } | { available: true; streaks: HistoryStreak[] }>(
      "/api/history/streaks",
    ),
};

export interface HistorySummary {
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

export interface HistoryBundle {
  summary: HistorySummary;
  exercises: HistoryExercise[];
  repMaxes: HistoryRepMax[];
  bodyweight: HistoryBodyPoint[];
  cardio: HistoryCardioWeek[];
  streaks: HistoryStreak[];
}

export interface HistoryExercise {
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

export interface HistoryVolumePoint {
  period: string;
  exercise: string;
  volumeKg: number;
  sets: number;
  topWeightKg: number;
}

export interface HistoryRepMax {
  exercise: string;
  reps: number;
  weightKg: number;
  achievedOn: string;
  bodyweightRatio: number | null;
}

export interface HistoryBodyPoint {
  date: string;
  weightKg: number;
  bmi: number;
  trendKg: number;
}

export interface HistoryCardioWeek {
  week: string;
  activities: number;
  distanceKm: number;
  movingHours: number;
  elevationM: number;
  avgWattsPerKg: number | null;
}

export interface HistoryStreak {
  start: string;
  end: string;
  days: number;
  activeDays: number;
}
