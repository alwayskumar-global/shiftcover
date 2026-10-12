/** One set of formatters for every screen (design inconsistency: one formatter, two time-range formats). */

export const formatUsd = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export const formatRate = (cents: number) => `${formatUsd(cents)}/hr`;

export const formatHours = (hours: number) =>
  `${Number.isInteger(hours) ? hours : hours.toFixed(2).replace(/0$/, '')} ${hours === 1 ? 'hour' : 'hours'}`;

const clock = (d: Date, tz: string, withMinutes: boolean) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: withMinutes ? '2-digit' : undefined,
    hour12: true,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    text: `${get('hour')}${withMinutes ? ':' + get('minute') : ''}`,
    ampm: get('dayPeriod').toUpperCase(),
  };
};

/** Full: "7:00 AM – 3:00 PM". */
export function formatTimeRange(startIso: string, endIso: string, tz: string) {
  const a = clock(new Date(startIso), tz, true);
  const b = clock(new Date(endIso), tz, true);
  return `${a.text} ${a.ampm} – ${b.text} ${b.ampm}`;
}

/** Single clock time: "7:00 AM". */
export function formatClock(iso: string, tz: string) {
  const c = clock(new Date(iso), tz, true);
  return `${c.text} ${c.ampm}`;
}

/** Compact (scheduler blocks): "7–3 PM", or "7 AM–3 PM" across noon; minutes only when non-zero. */
export function formatTimeRangeCompact(startIso: string, endIso: string, tz: string) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const min = (d: Date) =>
    Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, minute: '2-digit' }).format(d));
  const a = clock(s, tz, min(s) !== 0);
  const b = clock(e, tz, min(e) !== 0);
  return a.ampm === b.ampm
    ? `${a.text}–${b.text} ${b.ampm}`
    : `${a.text} ${a.ampm}–${b.text} ${b.ampm}`;
}

const ymd = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

/** "Today", "Tomorrow" or "Wed, Oct 14", judged against the SERVER's clock in the venue's zone. */
export function dayLabel(startIso: string, serverNowIso: string, tz: string) {
  const day = ymd(new Date(startIso), tz);
  const now = new Date(serverNowIso);
  if (day === ymd(now, tz)) return 'Today';
  if (day === ymd(new Date(now.getTime() + 86_400_000), tz)) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(startIso));
}

export const formatCountdown = (secs: number) => {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const formatMiles = (mi: number) => `${mi} mi`;
