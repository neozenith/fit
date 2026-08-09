/**
 * Block and session identifiers.
 *
 * A block's identity IS its start date. `B-20270810` sorts lexicographically
 * into chronological order, and two blocks that start on the same day are the
 * same block — which is exactly the supersede rule (ADR-0029) falling out of
 * the identifier rather than being enforced beside it. A UUID could express
 * neither, and its tie-break was effectively random.
 *
 * The display form spells the month — `B-2027AUG10` — because `B-20270810` is
 * unreadable at a glance and `2027-08-10` invites the day/month ambiguity this
 * app already stripped out of its date formatting.
 */

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** `2027-08-10` → `B-20270810`. The stored identity, and the sort key. */
export const blockId = (startDate: string): string => `B-${startDate.replaceAll("-", "")}`;

/** `B-20270810` → `B-2027AUG10`. For humans; never stored, never compared. */
export const blockLabel = (id: string): string => {
  const match = /^B-(\d{4})(\d{2})(\d{2})$/.exec(id);
  if (!match) return id;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return `B-${year}${MONTHS[Number(month) - 1] ?? month}${day}`;
};

/** `B-20270810` → `2027-08-10`, or null for an identifier of the older shape. */
export const blockStartDate = (id: string): string | null => {
  const match = /^B-(\d{4})(\d{2})(\d{2})$/.exec(id);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

/** `B-20270810-W5D1` — one session, addressable on its own. */
export const sessionRef = (id: string, week: number, day: number): string =>
  `${id}-W${week}D${day}`;

export interface ParsedSessionRef {
  blockId: string;
  week: number;
  day: number;
}

export const parseSessionRef = (ref: string): ParsedSessionRef | null => {
  const match = /^(B-\d{8})-W(\d+)D(\d+)$/.exec(ref);
  if (!match) return null;
  return {
    blockId: match[1] as string,
    week: Number(match[2]),
    day: Number(match[3]),
  };
};
