/** Matching weights and limits in ONE place (PLAN.md 8). Synthetic defaults; tune here only. */
export const MATCHING = {
  weights: {
    reliability: 0.35,
    acceptance: 0.2,
    response: 0.15,
    distance: 0.2,
    venueHistory: 0.1,
  },
  /** Hard limits. */
  maxWeeklyHours: 40,
  /** Largest search radius (miles) a manager can widen to. */
  maxSearchRadiusMi: 25,
  minRestHours: 8,
  /** Score normalisation. */
  maxDistanceKm: 25,
  responseCapSeconds: 900,
  venueHistoryCap: 10,
} as const;

export type MatchingConfig = typeof MATCHING;

/** Wave plan (PLAN.md 8): audience size and premium over base. Rate is always clamped to the slot cap. */
export const WAVES = [
  { wave: 1, audience: 3, premiumPct: 0 },
  { wave: 2, audience: 5, premiumPct: 10 },
  { wave: 3, audience: Number.POSITIVE_INFINITY, premiumPct: 20 },
] as const;
