/** Typed list of hospitality roles (PLAN.md 2/3: skills match). One source for DB check, Zod, parser, matching. */
export const SHIFT_ROLES = [
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
export type ShiftRole = (typeof SHIFT_ROLES)[number];

export const ROLE_LABELS: Record<ShiftRole, string> = {
  line_cook: 'Line cook',
  prep_cook: 'Prep cook',
  server: 'Server',
  bartender: 'Bartender',
  bar_back: 'Bar back',
  dishwasher: 'Dishwasher',
  barista: 'Barista',
  host: 'Host',
  event_staff: 'Event staff',
};

/** Certifications a worker must hold (valid on the shift date) to be eligible. Synthetic rules. */
export const ROLE_REQUIRED_CERTS: Record<ShiftRole, readonly string[]> = {
  line_cook: ['food_handler'],
  prep_cook: ['food_handler'],
  server: [],
  bartender: ['alcohol_service'],
  bar_back: [],
  dishwasher: [],
  barista: [],
  host: [],
  event_staff: [],
};

export function isShiftRole(value: string): value is ShiftRole {
  return (SHIFT_ROLES as readonly string[]).includes(value);
}
