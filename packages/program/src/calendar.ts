/**
 * The season calendar: which week of the year belongs to which training block,
 * and which weeks are deliberately *not* strength blocks.
 *
 * The source spreadsheet's year sheet is hand-authored, and that is the point.
 * Six-week blocks do not tile a year evenly, and the gaps are where the other
 * events live — a cycling FTP test, a timed 5km, an end-of-year break. Blocks
 * are placed *around* those fixtures, so the calendar is athlete config, not a
 * derivation. The one thing that IS derived is the week's start date.
 */

/** Non-block weeks the athlete schedules between blocks. */
export type SeasonEvent = "ZWIFT_FTP" | "PARKRUN" | "BREAK" | "DELOAD";

export const SEASON_EVENT_LABELS: Record<SeasonEvent, string> = {
  ZWIFT_FTP: "Zwift FTP test",
  PARKRUN: "Parkrun",
  BREAK: "Break",
  DELOAD: "Deload",
};

export interface SeasonWeek {
  /** 1-indexed week of the season, counted from the season's start date. */
  weekOfSeason: number;
  /** ISO `YYYY-MM-DD` of the week's Monday-equivalent (the season start weekday). */
  startDate: string;
  month: number;
  /** Calendar quarter, 1-4, of the week's start date. */
  quarter: number;
  season: Season;
  /** Present when this week belongs to a strength block. */
  block?: { blockNumber: number; weekOfBlock: number };
  /** Present when this week is a scheduled non-block fixture. */
  event?: SeasonEvent;
}

export type Season = "Summer" | "Autumn" | "Winter" | "Spring";

/**
 * Southern-hemisphere meteorological seasons: December-February is Summer.
 *
 * The source sheet uses this convention (its January weeks are labelled
 * Summer), which is correct for the athlete's location and would be wrong
 * inverted. Named explicitly here so nobody "fixes" it.
 */
export const seasonOfMonth = (month: number): Season => {
  if (month === 12 || month <= 2) return "Summer";
  if (month <= 5) return "Autumn";
  if (month <= 8) return "Winter";
  return "Spring";
};

/** A week's assignment, as the athlete authors it. */
export type SeasonPlanEntry =
  | { kind: "block"; blockNumber: number; weekOfBlock: number }
  | { kind: "event"; event: SeasonEvent };

export interface SeasonPlan {
  /** ISO `YYYY-MM-DD` of week 1. Everything else is offset from it. */
  startDate: string;
  /** One entry per week, in order. Length defines the season. */
  weeks: SeasonPlanEntry[];
}

const addDays = (isoDate: string, days: number): string => {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

/** Expand a plan into dated weeks. */
export const expandSeason = (plan: SeasonPlan): SeasonWeek[] =>
  plan.weeks.map((entry, i) => {
    const startDate = addDays(plan.startDate, i * 7);
    const month = Number(startDate.slice(5, 7));
    return {
      weekOfSeason: i + 1,
      startDate,
      month,
      quarter: Math.floor((month - 1) / 3) + 1,
      season: seasonOfMonth(month),
      ...(entry.kind === "block"
        ? { block: { blockNumber: entry.blockNumber, weekOfBlock: entry.weekOfBlock } }
        : { event: entry.event }),
    };
  });

/**
 * Build a plan by alternating six-week blocks with scheduled fixtures.
 *
 * `fixtures` maps a week-of-season number to its event; every other week is
 * filled by the next week of the current block. This is a *convenience* for
 * authoring a fresh season — the resulting plan is then editable, because
 * reality reorders fixtures and the plan must follow reality rather than
 * regenerate over it.
 */
export const planSeason = (options: {
  startDate: string;
  weeks: number;
  fixtures?: Record<number, SeasonEvent>;
  weeksPerBlock?: number;
}): SeasonPlan => {
  const { startDate, weeks, fixtures = {}, weeksPerBlock = 6 } = options;
  const entries: SeasonPlanEntry[] = [];
  let blockNumber = 1;
  let weekOfBlock = 1;

  for (let week = 1; week <= weeks; week++) {
    const fixture = fixtures[week];
    if (fixture) {
      entries.push({ kind: "event", event: fixture });
      // A fixture interrupts a block rather than pausing it: the next strength
      // week starts a NEW block. That matches the source calendar, where every
      // block is a contiguous run of six.
      if (weekOfBlock > 1) {
        blockNumber += 1;
        weekOfBlock = 1;
      }
      continue;
    }
    entries.push({ kind: "block", blockNumber, weekOfBlock });
    if (weekOfBlock === weeksPerBlock) {
      blockNumber += 1;
      weekOfBlock = 1;
    } else {
      weekOfBlock += 1;
    }
  }

  return { startDate, weeks: entries };
};
