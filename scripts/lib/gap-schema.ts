import { z } from 'zod';

export const HOSPITALITY_ROLES = [
  'line_cook',
  'prep_cook',
  'server',
  'bartender',
  'bar_back',
  'dishwasher',
  'barista',
  'host',
  'event_staff',
] as const;

/** Structured gap the intake LLM must return. Manager confirms before anything happens. */
export const gapSchema = z.object({
  role: z.enum(HOSPITALITY_ROLES),
  date_offset_days: z.number().int().min(0).max(14),
  start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  base_rate_cents: z.number().int().min(0).nullable(),
  max_premium_pct: z.number().int().min(0).max(100).nullable(),
});
export type Gap = z.infer<typeof gapSchema>;

export const GAP_FIELDS = Object.keys(gapSchema.shape) as Array<keyof Gap>;

export function scoreFields(actual: Gap, expected: Gap): Record<keyof Gap, boolean> {
  return Object.fromEntries(GAP_FIELDS.map((f) => [f, actual[f] === expected[f]])) as Record<
    keyof Gap,
    boolean
  >;
}
