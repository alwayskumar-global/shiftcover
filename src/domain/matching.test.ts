import { describe, expect, it } from 'vitest';
import { MATCHING, WAVES } from '../config/matching';
import { maxRateCents } from './money';
import {
  filterReasons,
  haversineKm,
  isAvailable,
  rankCandidates,
  scoreCandidate,
  type CandidateFacts,
  type GapFacts,
} from './matching';

const TZ = 'America/Los_Angeles';
// Wednesday 2026-10-14, 07:00-15:00 Pacific = 14:00-22:00 UTC (PDT, UTC-7)
const gap: GapFacts = {
  role: 'line_cook',
  startAt: new Date('2026-10-14T14:00:00Z'),
  endAt: new Date('2026-10-14T22:00:00Z'),
  venue: { orgId: 'org1', lat: 45.5231, lng: -122.6765, timezone: TZ },
};
const allDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 0,
  endMinute: 1440,
}));

const base: CandidateFacts = {
  workerId: 'w1',
  name: 'Worker One',
  orgId: 'org1',
  status: 'active',
  skills: ['line_cook'],
  certs: [{ cert: 'food_handler', validUntil: '2027-01-01' }],
  availability: allDay,
  reliability: 0.9,
  acceptanceRate: 0.8,
  avgResponseSeconds: 120,
  homeLat: 45.53,
  homeLng: -122.68,
  shifts: [],
  priorShiftsAtVenue: 5,
};
const reasons = (c: Partial<CandidateFacts>) => filterReasons({ ...base, ...c }, gap, MATCHING);

describe('hard filters', () => {
  it('passes a fully eligible worker', () => {
    expect(reasons({})).toEqual([]);
  });
  it('venue: other org or inactive', () => {
    expect(reasons({ orgId: 'other' })).toContain('venue_not_allowed');
    expect(reasons({ status: 'inactive' })).toContain('venue_not_allowed');
    expect(reasons({ status: 'invited' })).toContain('venue_not_allowed');
  });
  it('role/skills', () => {
    expect(reasons({ skills: ['server'] })).toContain('role_mismatch');
  });
  it('certifications: missing, expired, valid through shift day', () => {
    expect(reasons({ certs: [] })).toContain('certification_missing_or_expired');
    expect(reasons({ certs: [{ cert: 'food_handler', validUntil: '2026-10-13' }] })).toContain(
      'certification_missing_or_expired',
    );
    expect(reasons({ certs: [{ cert: 'food_handler', validUntil: '2026-10-14' }] })).toEqual([]);
    expect(reasons({ certs: [{ cert: 'food_handler', validUntil: null }] })).toEqual([]);
    expect(reasons({ certs: [{ cert: 'alcohol_service', validUntil: null }] })).toContain(
      'certification_missing_or_expired',
    );
  });
  it('availability is evaluated in venue-local time', () => {
    // Wed 2026-10-14 is weekday 3. Available 07:00-15:00 local exactly -> ok; 08:00 start -> not.
    const exact = [{ weekday: 3, startMinute: 420, endMinute: 900 }];
    expect(reasons({ availability: exact })).toEqual([]);
    expect(reasons({ availability: [{ weekday: 3, startMinute: 480, endMinute: 900 }] })).toContain(
      'not_available',
    );
    expect(reasons({ availability: [{ weekday: 2, startMinute: 0, endMinute: 1440 }] })).toContain(
      'not_available',
    );
    expect(reasons({ availability: [] })).toContain('not_available');
  });
  it('availability across midnight needs both days covered', () => {
    const start = new Date('2026-10-15T02:00:00Z'); // Wed 19:00 local
    const end = new Date('2026-10-15T08:00:00Z'); // Thu 01:00 local
    const w = [
      { weekday: 3, startMinute: 1080, endMinute: 1440 },
      { weekday: 4, startMinute: 0, endMinute: 120 },
    ];
    expect(isAvailable(w, start, end, TZ)).toBe(true);
    expect(isAvailable([w[0]!], start, end, TZ)).toBe(false);
  });
  it('overlap and minimum rest', () => {
    const at = (s: string, e: string) => ({ startAt: new Date(s), endAt: new Date(e) });
    expect(reasons({ shifts: [at('2026-10-14T20:00:00Z', '2026-10-15T02:00:00Z')] })).toContain(
      'overlapping_shift',
    );
    // ends 1h before the gap starts -> rest violation (< 8h)
    expect(reasons({ shifts: [at('2026-10-14T05:00:00Z', '2026-10-14T13:00:00Z')] })).toContain(
      'insufficient_rest',
    );
    // starts 3h after the gap ends
    expect(reasons({ shifts: [at('2026-10-15T01:00:00Z', '2026-10-15T07:00:00Z')] })).toContain(
      'insufficient_rest',
    );
    // 8h rest exactly is fine
    expect(reasons({ shifts: [at('2026-10-13T22:00:00Z', '2026-10-14T06:00:00Z')] })).toEqual([]);
  });
  it('weekly hours limit (Mon-based week in venue time)', () => {
    const day = (d: number) => ({
      startAt: new Date(`2026-10-${String(d).padStart(2, '0')}T15:00:00Z`),
      endAt: new Date(`2026-10-${String(d).padStart(2, '0')}T23:00:00Z`),
    });
    // 4 x 8h = 32h earlier in the week + 8h gap = 40h -> allowed; 5 x 8h -> 48h -> blocked
    expect(reasons({ shifts: [day(12), day(13), day(16), day(17)] })).toEqual([]);
    expect(reasons({ shifts: [day(12), day(13), day(16), day(17), day(18)] })).toContain(
      'weekly_hours_exceeded',
    );
    // a shift in the previous week does not count
    expect(reasons({ shifts: [day(5), day(6), day(7), day(8), day(9)] })).toEqual([]);
  });
  it('search radius is a hard filter in miles; missing home location passes', () => {
    const at = (radiusMi?: number) => ({ ...gap, radiusMi });
    // ~0.8 km away: inside any radius
    expect(filterReasons(base, at(1), MATCHING)).toEqual([]);
    // ~22 km (13.7 mi) north
    const far = { ...base, homeLat: 45.72, homeLng: -122.6765 };
    expect(filterReasons(far, at(10), MATCHING)).toContain('outside_radius');
    expect(filterReasons(far, at(15), MATCHING)).toEqual([]); // widening admits them
    expect(filterReasons(far, at(undefined), MATCHING)).toEqual([]); // no radius = no filter
    expect(filterReasons({ ...far, homeLat: null, homeLng: null }, at(10), MATCHING)).toEqual([]);
  });

  it('reports every failed rule', () => {
    const r = reasons({ skills: [], certs: [], availability: [] });
    expect(r).toEqual(
      expect.arrayContaining([
        'role_mismatch',
        'certification_missing_or_expired',
        'not_available',
      ]),
    );
  });
});

describe('ranking', () => {
  const a = { ...base, workerId: 'a', name: 'A', reliability: 0.95 };
  const b = { ...base, workerId: 'b', name: 'B', reliability: 0.6 };
  const c = { ...base, workerId: 'c', name: 'C', reliability: 0.6 };
  const out = { ...base, workerId: 'z', name: 'Z', skills: [] };

  it('is deterministic regardless of input order, with id tie-break', () => {
    const r1 = rankCandidates([b, c, a, out], gap, MATCHING);
    const r2 = rankCandidates([out, c, b, a], gap, MATCHING);
    expect(r1.ranked.map((x) => x.workerId)).toEqual(['a', 'b', 'c']);
    expect(r2.ranked).toEqual(r1.ranked);
    expect(r1.excluded.map((x) => x.workerId)).toEqual(['z']);
  });

  it('returns the score breakdown and weights sum to 1', () => {
    const s = scoreCandidate(a, gap, MATCHING);
    expect(Object.keys(s.parts)).toEqual([
      'reliability',
      'acceptance',
      'response',
      'distance',
      'venueHistory',
    ]);
    expect(Object.values(MATCHING.weights).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 10);
    expect(s.total).toBeGreaterThan(0);
    expect(s.total).toBeLessThanOrEqual(1);
  });

  it('closer, faster, more experienced workers score higher', () => {
    const near = scoreCandidate(
      { ...base, homeLat: 45.5231, homeLng: -122.6765 },
      gap,
      MATCHING,
    ).total;
    const far = scoreCandidate({ ...base, homeLat: 45.9, homeLng: -122.2 }, gap, MATCHING).total;
    expect(near).toBeGreaterThan(far);
    expect(
      scoreCandidate({ ...base, avgResponseSeconds: 30 }, gap, MATCHING).total,
    ).toBeGreaterThan(scoreCandidate({ ...base, avgResponseSeconds: 800 }, gap, MATCHING).total);
    expect(
      scoreCandidate({ ...base, priorShiftsAtVenue: 10 }, gap, MATCHING).total,
    ).toBeGreaterThan(scoreCandidate({ ...base, priorShiftsAtVenue: 0 }, gap, MATCHING).total);
  });

  it('haversine sanity', () => {
    expect(haversineKm(45.5, -122.6, 45.5, -122.6)).toBe(0);
    expect(haversineKm(45.5, -122.6, 45.6, -122.6)).toBeCloseTo(11.1, 0);
  });
});

describe('wave plan', () => {
  it('matches PLAN.md 8: 3 @ base, next 5 @ +10%, everyone @ +20%', () => {
    expect(WAVES.map((w) => [w.wave, w.audience, w.premiumPct])).toEqual([
      [1, 3, 0],
      [2, 5, 10],
      [3, Number.POSITIVE_INFINITY, 20],
    ]);
  });
  it('a wave rate never exceeds the slot cap, for any cap', () => {
    for (const capPct of [0, 5, 10, 15, 20, 50]) {
      for (const w of WAVES) {
        const pct = Math.min(w.premiumPct, capPct);
        expect(maxRateCents(2200, pct)).toBeLessThanOrEqual(maxRateCents(2200, capPct));
      }
    }
  });
});
