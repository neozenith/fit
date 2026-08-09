import {
  type BlockConfig,
  DEFAULT_ACCESSORIES,
  estimatedOneRepMax,
  expandSeason,
  generateBlock,
  LIFT_LABELS,
  type MeasurementRecord,
  personalBests,
  proposeNextBlock,
  type SetRecord,
  weeklyMedians,
} from "@fit/program";
import { z } from "zod";
import { ENVIRONMENT } from "./const.js";
import { queryFinops } from "./finops.js";
import {
  bodyweight as historyBodyweight,
  bundle as historyBundle,
  cardio as historyCardio,
  exercises as historyExercises,
  repMaxes as historyRepMaxes,
  streaks as historyStreaks,
  summary as historySummary,
  volume as historyVolume,
} from "./history.js";
import { type Identity, UnauthenticatedError, userKey, verifyIdentity } from "./identity.js";
import { type Item, putItem, putItems, queryByType, sortKey } from "./repo.js";
import {
  createBlockSchema,
  finopsQuerySchema,
  historyVolumeQuerySchema,
  historyWindowSchema,
  logSetsSchema,
  measurementSchema,
  seasonPlanSchema,
  testResultsSchema,
} from "./schemas.js";

/**
 * The router.
 *
 * Runtime-agnostic on purpose: it takes a `Request` and returns a `Response`,
 * so the Lambda entry point and the local server are both thin adapters over
 * the SAME code (ADR-0016). There is no second implementation to drift.
 */

export interface Context {
  identity: Identity;
  sessionKey: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // The API is never cacheable. CloudFront already has caching disabled on
      // /api/*; this is belt and braces for any other intermediary.
      "cache-control": "no-store",
    },
  });

const newId = (): string => crypto.randomUUID();
const nowIso = (): string => new Date().toISOString();

// --- Handlers ----------------------------------------------------------------

const getBlocks = async (ctx: Context): Promise<Response> => {
  const items = await queryByType<BlockConfig>("blocks", userKey(ctx.identity), "BLOCK");
  return json({ blocks: items.map(stripKeys) });
};

const stripKeys = <T>(item: T & Item): T => {
  const { pk: _pk, sk: _sk, ...rest } = item;
  // The cast is safe and necessary: `Item`'s index signature makes `Omit`
  // collapse every named property into `unknown`, so TypeScript cannot see
  // that removing pk/sk leaves exactly T.
  return rest as T;
};

const createBlock = async (ctx: Context, body: unknown): Promise<Response> => {
  const input = createBlockSchema.parse(body);
  const blockId = newId();

  const config: BlockConfig = {
    blockId,
    startDate: input.startDate,
    units: input.units,
    oneRepMax: input.oneRepMax,
    // Explicitly drop undefined keys before merging. A partial object from zod
    // carries absent fields as `undefined` PROPERTIES, and spreading it would
    // overwrite each default with undefined rather than leaving it in place.
    accessories: {
      ...DEFAULT_ACCESSORIES,
      ...Object.fromEntries(
        Object.entries(input.accessories ?? {}).filter(([, v]) => v !== undefined),
      ),
    },
    ...(input.derivedFrom ? { derivedFrom: input.derivedFrom } : {}),
  };

  await putItem("blocks", {
    pk: userKey(ctx.identity),
    // Sorted by START DATE rather than creation time, so "the current block" is
    // a query against the calendar rather than against when someone happened to
    // type it in. A block created today for next month must not sort as current.
    sk: sortKey("BLOCK", input.startDate, blockId),
    ...config,
    createdAt: nowIso(),
    createdBy: ctx.identity.actor,
  });

  return json({ block: config }, 201);
};

/**
 * The prescription. Nothing here is read from storage except the block config —
 * every weight is computed on the spot (ADR-0001).
 */
const getSessions = async (
  ctx: Context,
  blockId: string,
  weekSixChoice: string | null,
): Promise<Response> => {
  const block = await findBlock(ctx, blockId);
  if (!block) return json({ error: "block_not_found" }, 404);

  const choice = weekSixChoice === "deload" || weekSixChoice === "test" ? weekSixChoice : "skip";

  return json({ block, sessions: generateBlock(block, choice) });
};

const findBlock = async (ctx: Context, blockId: string): Promise<BlockConfig | null> => {
  const items = await queryByType<BlockConfig>("blocks", userKey(ctx.identity), "BLOCK");
  const found = items.find((b) => b.blockId === blockId);
  return found ? (stripKeys(found) as BlockConfig) : null;
};

/** The block whose six weeks contain today, or the most recent one before it. */
const getCurrentBlock = async (ctx: Context): Promise<Response> => {
  const items = await queryByType<BlockConfig>("blocks", userKey(ctx.identity), "BLOCK");
  const today = nowIso().slice(0, 10);
  // Items come back newest-start-date first, so the first block that has
  // already started is the current one.
  const current = items.find((b) => b.startDate <= today) ?? items[0];
  if (!current) return json({ block: null, sessions: [] });

  const config = stripKeys(current) as BlockConfig;
  return json({ block: config, sessions: generateBlock(config) });
};

/**
 * Propose the next block from this one's Week 5 results.
 *
 * A PROPOSAL — nothing is written (ADR-0013). The athlete accepts it by
 * POSTing the returned config to /api/blocks, which is what makes an
 * unaccepted projection incapable of changing anything.
 */
const projectNextBlock = async (ctx: Context, body: unknown): Promise<Response> => {
  const input = testResultsSchema.parse(body);
  const current = await findBlock(ctx, input.blockId);
  if (!current) return json({ error: "block_not_found" }, 404);

  const proposal = proposeNextBlock(current, input.results, {
    blockId: newId(),
    startDate: input.startDate,
  });

  return json({
    ...proposal,
    note: "Nothing has been written. POST the config to /api/blocks to accept it.",
  });
};

const logSets = async (ctx: Context, body: unknown): Promise<Response> => {
  const input = logSetsSchema.parse(body);
  const pk = userKey(ctx.identity);

  const records = input.sets.map((s) => {
    const timestamp = s.timestamp ?? nowIso();
    const id = newId();
    return {
      pk,
      sk: sortKey("SET", timestamp, id),
      id,
      ...s,
      timestamp,
      loggedBy: ctx.identity.actor,
    };
  });

  await putItems("sets", records);
  return json({ written: records.length, sets: records.map(stripKeys) }, 201);
};

const getSets = async (ctx: Context, url: URL): Promise<Response> => {
  const since = url.searchParams.get("since") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? "500");

  const items = await queryByType<SetRecord>("sets", userKey(ctx.identity), "SET", {
    limit: Number.isFinite(limit) ? Math.min(limit, 2000) : 500,
    ...(since ? { since } : {}),
  });

  const records = items.map(stripKeys) as SetRecord[];
  return json({
    sets: records,
    // Computed here rather than stored, for the same reason prescriptions are
    // (ADR-0001): a corrected set must not leave a stale best behind.
    personalBests: personalBests(records, LIFT_LABELS),
  });
};

const logMeasurement = async (ctx: Context, body: unknown): Promise<Response> => {
  const input = measurementSchema.parse(body);
  const timestamp = input.timestamp ?? nowIso();
  const id = newId();

  await putItem("measurements", {
    pk: userKey(ctx.identity),
    sk: sortKey("MEASURE", timestamp, id),
    id,
    ...input,
    timestamp,
  });

  return json({ measurement: { ...input, timestamp, id } }, 201);
};

const getMeasurements = async (ctx: Context, url: URL): Promise<Response> => {
  const since = url.searchParams.get("since") ?? undefined;
  const items = await queryByType<MeasurementRecord>(
    "measurements",
    userKey(ctx.identity),
    "MEASURE",
    { limit: 2000, ...(since ? { since } : {}) },
  );

  const records = items.map(stripKeys) as MeasurementRecord[];

  // Weekly MEDIANS, not means: one post-meal weigh-in moves a mean by a
  // kilogram, and the weekly figure exists to see through exactly that.
  const weekStarts = [...new Set(records.map((r) => mondayOf(r.timestamp.slice(0, 10))))].sort();

  return json({ measurements: records, weekly: weeklyMedians(records, weekStarts) });
};

/** ISO week start (Monday) for a date, in UTC so no timezone can shift it. */
const mondayOf = (isoDate: string): string => {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  // getUTCDay: 0 is Sunday, which is 6 days after the Monday that starts its week.
  const offset = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - offset);
  return dt.toISOString().slice(0, 10);
};

const getSeason = async (ctx: Context): Promise<Response> => {
  const items = await queryByType<{ plan: unknown }>("season", userKey(ctx.identity), "SEASON", {
    limit: 1,
  });
  const stored = items[0];
  if (!stored) return json({ plan: null, weeks: [] });

  const plan = seasonPlanSchema.parse(stored.plan);
  return json({ plan, weeks: expandSeason(plan) });
};

const putSeason = async (ctx: Context, body: unknown): Promise<Response> => {
  const plan = seasonPlanSchema.parse(body);
  await putItem("season", {
    pk: userKey(ctx.identity),
    sk: sortKey("SEASON", plan.startDate, "plan"),
    plan,
    updatedAt: nowIso(),
  });
  return json({ plan, weeks: expandSeason(plan) });
};

const getProgress = async (ctx: Context): Promise<Response> => {
  const items = await queryByType<SetRecord>("sets", userKey(ctx.identity), "SET", {
    limit: 2000,
    ascending: true,
  });
  const records = items.map(stripKeys) as SetRecord[];

  // Epley here, NOT the program's rep table. The two estimators are kept apart
  // deliberately so improving this chart can never change a training plan.
  const series: Record<string, Array<{ date: string; estimated: number }>> = {};
  for (const r of records) {
    if (r.weight === undefined) continue;
    const lift = Object.entries(LIFT_LABELS).find(
      ([, label]) => label.toLowerCase() === r.exercise.toLowerCase(),
    )?.[0];
    if (!lift) continue;
    let points = series[lift];
    if (!points) {
      points = [];
      series[lift] = points;
    }
    points.push({
      date: r.timestamp.slice(0, 10),
      estimated: Math.round(estimatedOneRepMax(r.weight, r.reps) * 10) / 10,
    });
  }

  return json({ series, personalBests: personalBests(records, LIFT_LABELS) });
};

// --- Dispatch ----------------------------------------------------------------

interface Route {
  method: string;
  pattern: RegExp;
  handle: (ctx: Context, req: Request, url: URL, params: string[]) => Promise<Response>;
}

const ROUTES: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/me$/,
    handle: async (ctx) => json({ ...ctx.identity, environment: ENVIRONMENT }),
  },
  { method: "GET", pattern: /^\/api\/blocks$/, handle: (ctx) => getBlocks(ctx) },
  {
    method: "POST",
    pattern: /^\/api\/blocks$/,
    handle: async (ctx, req) => createBlock(ctx, await req.json()),
  },
  { method: "GET", pattern: /^\/api\/blocks\/current$/, handle: (ctx) => getCurrentBlock(ctx) },
  {
    method: "GET",
    pattern: /^\/api\/blocks\/([^/]+)\/sessions$/,
    handle: (ctx, _req, url, params) =>
      getSessions(ctx, params[0] as string, url.searchParams.get("week6")),
  },
  {
    method: "POST",
    pattern: /^\/api\/blocks\/project$/,
    handle: async (ctx, req) => projectNextBlock(ctx, await req.json()),
  },
  { method: "GET", pattern: /^\/api\/sets$/, handle: (ctx, _req, url) => getSets(ctx, url) },
  {
    method: "POST",
    pattern: /^\/api\/sets$/,
    handle: async (ctx, req) => logSets(ctx, await req.json()),
  },
  {
    method: "GET",
    pattern: /^\/api\/measurements$/,
    handle: (ctx, _req, url) => getMeasurements(ctx, url),
  },
  {
    method: "POST",
    pattern: /^\/api\/measurements$/,
    handle: async (ctx, req) => logMeasurement(ctx, await req.json()),
  },
  { method: "GET", pattern: /^\/api\/season$/, handle: (ctx) => getSeason(ctx) },
  {
    method: "PUT",
    pattern: /^\/api\/season$/,
    handle: async (ctx, req) => putSeason(ctx, await req.json()),
  },
  { method: "GET", pattern: /^\/api\/progress$/, handle: (ctx) => getProgress(ctx) },
  // --- Imported history ------------------------------------------------------
  // Read-only, derived in SQL from the curated Parquet. No writes: the import
  // is an operator action (tools/publish-history.ts), never a request.
  // The bundle, not the summary: one response so a cold start is paid once
  // rather than once per panel. `/api/history/summary` keeps the narrow shape.
  { method: "GET", pattern: /^\/api\/history$/, handle: async () => json(await historyBundle()) },
  {
    method: "GET",
    pattern: /^\/api\/history\/summary$/,
    handle: async () => json(await historySummary()),
  },
  {
    method: "GET",
    pattern: /^\/api\/history\/exercises$/,
    handle: async () => json(await historyExercises()),
  },
  {
    method: "GET",
    pattern: /^\/api\/history\/volume$/,
    handle: async (_ctx, _req, url) => {
      const q = historyVolumeQuerySchema.parse(Object.fromEntries(url.searchParams));
      return json(await historyVolume(q.grain, q.exercise, { from: q.from, to: q.to }));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/history\/rep-maxes$/,
    handle: async () => json(await historyRepMaxes()),
  },
  {
    method: "GET",
    pattern: /^\/api\/history\/bodyweight$/,
    handle: async (_ctx, _req, url) =>
      json(
        await historyBodyweight(historyWindowSchema.parse(Object.fromEntries(url.searchParams))),
      ),
  },
  {
    method: "GET",
    pattern: /^\/api\/history\/cardio$/,
    handle: async (_ctx, _req, url) =>
      json(await historyCardio(historyWindowSchema.parse(Object.fromEntries(url.searchParams)))),
  },
  {
    method: "GET",
    pattern: /^\/api\/history\/streaks$/,
    handle: async () => json(await historyStreaks()),
  },
  {
    method: "GET",
    pattern: /^\/api\/finops$/,
    handle: async (_ctx, _req, url) =>
      json(await queryFinops(finopsQuerySchema.parse(Object.fromEntries(url.searchParams)))),
  },
];

/**
 * Handle one request.
 *
 * `sessionKey` is passed in rather than read here, so the caller controls where
 * it comes from — SSM in a deployed environment, a constant locally — without
 * this function branching on the environment.
 */
export const handleRequest = async (request: Request, sessionKey: string): Promise<Response> => {
  const url = new URL(request.url);

  // Unauthenticated by design: the health check must answer before the edge is
  // wired up, and it exposes nothing.
  if (url.pathname === "/api/health") {
    return json({ ok: true, environment: ENVIRONMENT });
  }

  let identity: Identity;
  try {
    identity = verifyIdentity(headerMap(request.headers), sessionKey);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return json({ error: "not_authenticated", reason: error.message }, 401);
    }
    throw error;
  }

  const ctx: Context = { identity, sessionKey };

  for (const route of ROUTES) {
    if (route.method !== request.method) continue;
    const match = url.pathname.match(route.pattern);
    if (!match) continue;

    try {
      return await route.handle(ctx, request, url, match.slice(1));
    } catch (error) {
      if (error instanceof z.ZodError) {
        // Name the offending field. A 500 three frames deeper tells the caller
        // nothing they can act on.
        return json({ error: "invalid_request", issues: error.issues }, 400);
      }
      throw error;
    }
  }

  return json({ error: "not_found", path: url.pathname }, 404);
};

const headerMap = (headers: Headers): Record<string, string | undefined> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
};
