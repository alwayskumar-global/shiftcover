import type { ShiftRole } from '../domain/roles';

/** Business rules the manager UI needs (design data-gaps). One place; synthetic defaults. */
export const PREMIUM_RANGE = { minPct: 0, maxPct: 50 } as const;
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
