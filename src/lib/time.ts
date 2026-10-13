/** Timezone helpers on Intl only (no dependency). Venue-local time drives availability and "today". */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

export function localDateString(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The UTC instant at which the wall clock in `timeZone` reads y-m-d hh:mm (DST-safe for normal times). */
export function zonedTimeToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(ts), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = guess - asUtc;
    if (diff === 0) break;
    ts += diff;
  }
  return new Date(ts);
}

/** Start/end instants of the local calendar day containing y-m-d. */
export function localDayBounds(dateStr: string, timeZone: string): { start: Date; end: Date } {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const start = zonedTimeToUtc(y, m, d, 0, 0, timeZone);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const end = zonedTimeToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
    timeZone,
  );
  return { start, end };
}

export function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** Monday-based week key (local date of that week's Monday). */
export function localWeekKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  const daysSinceMonday = (p.weekday + 6) % 7;
  const dateStr = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return addDaysToDateString(dateStr, -daysSinceMonday);
}

/**
 * A local `Date` whose wall-clock fields equal the instant's wall clock in `timeZone`. Bryntum renders in the
 * browser's zone, so feeding it these keeps the roster on VENUE time for a manager in any zone.
 */
export function wallClockDate(iso: string | Date, timeZone: string): Date {
  const p = localParts(typeof iso === 'string' ? new Date(iso) : iso, timeZone);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute);
}
