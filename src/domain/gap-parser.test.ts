import { describe, expect, it } from 'vitest';
import fixtures from '../../scripts/fixtures/gap-phrases.json';
import { localDateString, localParts } from '../lib/time';
import { parseGapText } from './gap-parser';

const TZ = 'America/Los_Angeles';
const now = new Date('2026-10-14T13:40:00Z'); // 06:40 PDT, Wed 2026-10-14
const ctx = { now, timezone: TZ };
const hhmm = (d: Date) => {
  const p = localParts(d, TZ);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

describe('rules parser: the headline demo phrase', () => {
  it('"Maria called in sick, need a line cook 7 to 3 today"', () => {
    const r = parseGapText('Maria called in sick, need a line cook 7 to 3 today', ctx);
    expect(r.role).toBe('line_cook');
    expect(r.calledOutName).toBe('Maria');
    expect(hhmm(r.startAt!)).toBe('07:00');
    expect(hhmm(r.endAt!)).toBe('15:00');
    expect(localDateString(r.startAt!, TZ)).toBe('2026-10-14');
    expect(r.baseRateCents).toBeNull();
    expect(r.missing).toEqual(['baseRate']);
  });
});

describe('rules parser on the 20 seeded phrases', () => {
  const cases = fixtures.cases;
  const results = cases.map((c) => {
    const r = parseGapText(c.text, ctx);
    const e = c.expected;
    const dayOffset =
      r.startAt === null
        ? -1
        : (Date.parse(localDateString(r.startAt, TZ)) - Date.parse(localDateString(now, TZ))) /
          86_400_000;
    return {
      text: c.text,
      ok: {
        role: r.role === e.role,
        day: dayOffset === e.date_offset_days,
        start: !!r.startAt && hhmm(r.startAt) === e.start_time,
        end: !!r.endAt && hhmm(r.endAt) === e.end_time,
        rate: r.baseRateCents === e.base_rate_cents,
        premium: r.maxPremiumPct === e.max_premium_pct,
      },
    };
  });

  it('gets every field right on every phrase (they are the seeded demo set)', () => {
    const bad = results.filter((r) => Object.values(r.ok).some((v) => !v));
    expect(bad.map((b) => ({ text: b.text, ok: b.ok }))).toEqual([]);
  });

  it('is not fooled by the embedded instruction in phrase 19', () => {
    const r = parseGapText(cases[18]!.text, ctx);
    expect(r.baseRateCents).toBe(1800);
  });
});

describe('rules parser edge cases', () => {
  it('flags what it could not find instead of guessing', () => {
    const r = parseGapText('we need somebody tomorrow', ctx);
    expect(r.missing).toEqual(['role', 'time', 'baseRate']);
    expect(r.startAt).toBeNull();
  });
  it('overnight shifts end on the next day', () => {
    const r = parseGapText('bartender tonight 6pm to 2am $24/hr', ctx);
    expect(r.endAt!.getTime() - r.startAt!.getTime()).toBe(8 * 3_600_000);
  });
  it('is pure and repeatable', () => {
    const a = parseGapText('server 5pm-11pm tomorrow $18/hr', ctx);
    const b = parseGapText('server 5pm-11pm tomorrow $18/hr', ctx);
    expect(a).toEqual(b);
  });
});
