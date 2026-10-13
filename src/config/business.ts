import type { ShiftRole } from '../domain/roles';

/** Business rules the manager UI needs (design data-gaps). One place; synthetic defaults. */
export const PREMIUM_RANGE = { minPct: 0, maxPct: 50 } as const;
/**
 * Sanity bounds for an hourly base rate that did not come from the manager typing it into the form (a model read it
 * out of free text). Outside this range the value is rejected and the rules parser is used instead.
 */
export const PARSED_RATE_LIMITS = { minCents: 500, maxCents: 10_000 } as const;
export const GAP_DATE_LIMITS = { maxDaysAhead: 14 } as const;
export const MAGIC_LINK_TTL_MINUTES = 15;

/** Prefill for the base rate after a parse (M3 "Role default" tag). Hourly USD cents. */
export const ROLE_DEFAULT_RATE_CENTS: Record<ShiftRole, number> = {
  line_cook: 2200,
  prep_cook: 1900,
  server: 1800,
  bartender: 2400,
  bar_back: 1900,
  dishwasher: 1600,
  barista: 1700,
  host: 1600,
  event_staff: 2000,
};

/** M2 shift-day rules. Config, not hard-coded in the services. */
export const SHIFT_DAY = {
  /** A worker may tap "I've arrived" up to this long before the start time. */
  arriveEarlyMinutes: 60,
  /** After a no-show the shift is re-offered only if at least this much of it is left. */
  noShowReofferMinRemainingMinutes: 60,
  /** Fill window for a no-show re-offer: how long the new waves have before the slot is UNFILLED. */
  noShowReofferFillMinutes: 30,
} as const;
