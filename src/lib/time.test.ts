import { describe, expect, it } from 'vitest';
import { localDateString, localDayBounds, localParts } from './time';

const PDX = 'America/Los_Angeles';
const IST = 'Asia/Kolkata';

describe('venue-local "today"', () => {
  // 2026-10-13 03:00 UTC: UTC and India are already on the 13th, Portland (UTC-7, PDT) is still on the 12th.
  const t = new Date('2026-10-13T03:00:00Z');
  it('Portland is on the 12th while UTC and India are on the 13th', () => {
    expect(localDateString(t, 'UTC')).toBe('2026-10-13');
    expect(localDateString(t, IST)).toBe('2026-10-13');
    expect(localDateString(t, PDX)).toBe('2026-10-12');
  });

  // 2026-10-12 20:00 UTC: India (UTC+5:30) is already on the 13th; UTC and Portland are on the 12th.
  it('India is a day ahead of UTC and Portland late in the UTC day', () => {
    const u = new Date('2026-10-12T20:00:00Z');
    expect(localDateString(u, 'UTC')).toBe('2026-10-12');
    expect(localDateString(u, IST)).toBe('2026-10-13');
    expect(localDateString(u, PDX)).toBe('2026-10-12');
  });

  it('three zones can never all differ (UTC+5:30 ahead needs UTC >= 18:30, Portland behind needs UTC < 07:00)', () => {
    for (let h = 0; h < 24; h++) {
      const d = new Date(Date.UTC(2026, 9, 13, h, 0));
      const dates = new Set([
        localDateString(d, 'UTC'),
        localDateString(d, IST),
        localDateString(d, PDX),
      ]);
      expect(dates.size).toBeLessThanOrEqual(2);
    }
  });

  it('flips to the 13th in Portland at 07:00 UTC (00:00 PDT)', () => {
    expect(localDateString(new Date('2026-10-13T06:59:59Z'), PDX)).toBe('2026-10-12');
    expect(localDateString(new Date('2026-10-13T07:00:00Z'), PDX)).toBe('2026-10-13');
  });

  it('a venue day is the Portland day, whatever zone the viewer is in', () => {
    const { start, end } = localDayBounds('2026-10-13', PDX);
    expect(start.toISOString()).toBe('2026-10-13T07:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-14T07:00:00.000Z');
    // Maria's 07:00-15:00 Portland shift on the 13th falls inside it
    expect(
      new Date('2026-10-13T14:00:00Z') >= start && new Date('2026-10-13T22:00:00Z') <= end,
    ).toBe(true);
  });

  it('renders a shift time in the venue zone, not the viewer zone', () => {
    const p = localParts(new Date('2026-10-13T14:00:00Z'), PDX);
    expect([p.hour, p.minute]).toEqual([7, 0]);
    expect(localParts(new Date('2026-10-13T14:00:00Z'), IST).hour).toBe(19);
  });
});
