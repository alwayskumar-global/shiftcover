/**
 * Synthetic demo data for org "Maple & Rye" (Portland, OR). Shared by the seed script and by the test that
 * locks the headline-gap ranking, so the two can never drift apart.
 * Roles follow the design sample roster: front-of-house and bar staff are NOT eligible for kitchen shifts
 * unless explicitly cross-trained (see `skills`).
 */
import type { CandidateFacts } from '../../src/domain/matching';
import { addDaysToDateString, zonedTimeToUtc } from '../../src/lib/time';

export const ORG_NAME = 'Maple & Rye';
export const MANAGER = { name: 'Dana Whitfield', email: 'dana.whitfield@example.com' };
export const TZ = 'America/Los_Angeles';
// Synthetic downtown-Portland coordinates.
export const VENUE = {
  name: 'Maple & Rye',
  area: 'Portland, OR',
  address: '1021 NW Everett St, Portland, OR 97209',
  searchRadiusMi: 10,
  lat: 45.5231,
  lng: -122.6765,
  radiusM: 150,
};

export type DemoWorker = {
  name: string;
  email: string;
  /** Primary role first; any later kitchen role is an explicit cross-training. */
  skills: string[];
  reliability: number;
  acceptance: number;
  response: number;
  home: [number, number];
  /** validUntil 'EXPIRED' = expired yesterday (resolved against the seed date). */
  certs: Array<{ cert: string; validUntil: string | 'EXPIRED' }>;
  /** [weekdays, from HH:MM, to HH:MM] in venue-local time */
  avail: Array<[number[], string, string]>;
};

const ALL = [0, 1, 2, 3, 4, 5, 6];

export const DEMO_WORKERS: DemoWorker[] = [
  {
    name: 'Maria Alvarez',
    email: 'maria.alvarez@example.com',
    skills: ['line_cook', 'prep_cook'],
    reliability: 0.96,
    acceptance: 0.9,
    response: 60,
    home: [45.5202, -122.6742],
    certs: [{ cert: 'food_handler', validUntil: '2027-06-30' }],
    avail: [[ALL, '06:00', '23:00']],
  },
  {
    name: 'Jordan Reyes',
    email: 'jordan.reyes@example.com',
    skills: ['line_cook', 'prep_cook'],
    reliability: 0.94,
    acceptance: 0.88,
    response: 70,
    home: [45.5233, -122.6611],
    certs: [{ cert: 'food_handler', validUntil: '2027-08-20' }],
    avail: [[ALL, '05:00', '23:00']],
  },
  {
    name: 'Marcus Lee',
    email: 'marcus.lee@example.com',
    skills: ['prep_cook', 'line_cook'],
    reliability: 0.9,
    acceptance: 0.8,
    response: 110,
    home: [45.5121, -122.6587],
    certs: [{ cert: 'food_handler', validUntil: '2027-01-15' }],
    avail: [[ALL, '05:00', '23:00']],
  },
  {
    name: 'Chloe Dubois',
    email: 'chloe.dubois@example.com',
    skills: ['prep_cook', 'line_cook'],
    reliability: 0.88,
    acceptance: 0.78,
    response: 140,
    home: [45.5342, -122.6501],
    certs: [{ cert: 'food_handler', validUntil: '2027-03-12' }],
    avail: [[ALL, '05:00', '23:00']],
  },
  {
    name: 'Devon Brooks',
    email: 'devon.brooks@example.com',
    skills: ['server', 'host'],
    reliability: 0.84,
    acceptance: 0.7,
    response: 240,
    home: [45.4981, -122.6402],
    certs: [],
    avail: [[ALL, '10:00', '23:59']],
  },
  {
    name: 'Aisha Khan',
    email: 'aisha.khan@example.com',
    skills: ['barista', 'server'],
    reliability: 0.9,
    acceptance: 0.82,
    response: 100,
    home: [45.5405, -122.6812],
    certs: [],
    avail: [[ALL, '05:30', '18:00']],
  },
  {
    name: 'Priya Nair',
    email: 'priya.nair@example.com',
    skills: ['bartender', 'bar_back'],
    reliability: 0.94,
    acceptance: 0.88,
    response: 75,
    home: [45.5233, -122.6611],
    certs: [{ cert: 'alcohol_service', validUntil: '2027-08-20' }],
    avail: [[ALL, '12:00', '23:59']],
  },
  {
    name: 'Sam Whitfield',
    email: 'sam.whitfield@example.com',
    skills: ['bar_back', 'event_staff'],
    reliability: 0.79,
    acceptance: 0.65,
    response: 300,
    home: [45.4902, -122.6902],
    certs: [],
    avail: [[ALL, '12:00', '23:59']],
  },
  {
    name: 'Lena Park',
    email: 'lena.park@example.com',
    skills: ['line_cook', 'prep_cook'],
    reliability: 0.87,
    acceptance: 0.78,
    response: 130,
    home: [45.5112, -122.6712],
    certs: [{ cert: 'food_handler', validUntil: 'EXPIRED' }],
    avail: [[ALL, '05:00', '22:00']],
  },
  {
    name: 'Tom Okafor',
    email: 'tom.okafor@example.com',
    skills: ['dishwasher'],
    reliability: 0.82,
    acceptance: 0.72,
    response: 200,
    home: [45.5504, -122.6402],
    certs: [],
    avail: [[ALL, '06:00', '23:00']],
  },
];

/** [worker, role, startDay, startHour, endDay, endHour, base cents, max premium %] relative to "today". */
export type RosterSpec = [string, string, number, number, number, number, number, number];
export const DEMO_ROSTER: RosterSpec[] = [
  ['Maria Alvarez', 'line_cook', 0, 7, 0, 15, 2200, 20], // the shift that becomes the gap
  ['Aisha Khan', 'barista', 0, 6, 0, 12, 1700, 15],
  ['Tom Okafor', 'dishwasher', 0, 10, 0, 18, 1600, 10],
  ['Devon Brooks', 'server', 0, 11, 0, 19, 1800, 20],
  ['Priya Nair', 'bartender', 0, 17, 0, 23, 2400, 25],
  ['Sam Whitfield', 'bar_back', 0, 18, 1, 2, 1900, 20],
  // Marcus works tomorrow: still eligible today (rest rule).
  ['Marcus Lee', 'prep_cook', 1, 10, 1, 18, 1900, 15],
];

export const hhmmToMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

export const resolveValidUntil = (v: string, today: string) =>
  v === 'EXPIRED' ? addDaysToDateString(today, -1) : v;

export function rosterInstants(today: string, spec: RosterSpec) {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const at = (day: number, hh: number) => zonedTimeToUtc(y, m, d + day, hh, 0, TZ);
  return { startAt: at(spec[2], spec[3]), endAt: at(spec[4], spec[5]) };
}

/** In-memory CandidateFacts for the matching engine (no database), as of `today` (venue-local YYYY-MM-DD). */
export function demoCandidates(today: string, orgId = 'demo-org'): CandidateFacts[] {
  return DEMO_WORKERS.map((w) => ({
    workerId: w.name,
    name: w.name,
    orgId,
    status: 'active' as const,
    skills: w.skills,
    certs: w.certs.map((c) => ({
      cert: c.cert,
      validUntil: resolveValidUntil(c.validUntil, today),
    })),
    availability: w.avail.flatMap(([days, from, to]) =>
      days.map((weekday) => ({
        weekday,
        startMinute: hhmmToMinutes(from),
        endMinute: hhmmToMinutes(to),
      })),
    ),
    reliability: w.reliability,
    acceptanceRate: w.acceptance,
    avgResponseSeconds: w.response,
    homeLat: w.home[0],
    homeLng: w.home[1],
    shifts: DEMO_ROSTER.filter((r) => r[0] === w.name && r[0] !== 'Maria Alvarez').map((r) =>
      rosterInstants(today, r),
    ),
    priorShiftsAtVenue: 0,
  }));
}

/** The headline gap: Line cook, today 7:00-15:00, replacing Maria's shift (so she is excluded as called out). */
export function headlineGap(today: string, orgId = 'demo-org') {
  const { startAt, endAt } = rosterInstants(today, DEMO_ROSTER[0]!);
  return {
    role: 'line_cook' as const,
    startAt,
    endAt,
    venue: { orgId, lat: VENUE.lat, lng: VENUE.lng, timezone: TZ },
    radiusMi: VENUE.searchRadiusMi,
  };
}
