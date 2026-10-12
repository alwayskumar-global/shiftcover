import type { MatchingConfig } from '../config/matching';
import { localParts, localWeekKey } from '../lib/time';
import { ROLE_REQUIRED_CERTS, type ShiftRole } from './roles';

/** Pure matching logic (PLAN.md 8). Hard filters in code only; a deterministic score ranks the rest. */

export interface CandidateFacts {
  workerId: string;
  name: string;
  orgId: string;
  status: 'invited' | 'active' | 'inactive';
  skills: readonly string[];
  certs: ReadonlyArray<{ cert: string; validUntil: string | null }>;
  availability: ReadonlyArray<{ weekday: number; startMinute: number; endMinute: number }>;
  reliability: number;
  acceptanceRate: number;
  avgResponseSeconds: number;
  homeLat: number | null;
  homeLng: number | null;
  /** Committed shifts (not this gap) around the gap's window. */
  shifts: ReadonlyArray<{ startAt: Date; endAt: Date }>;
  priorShiftsAtVenue: number;
}

export interface GapFacts {
  role: ShiftRole;
  startAt: Date;
  endAt: Date;
  venue: { orgId: string; lat: number; lng: number; timezone: string };
}

export type FilterReason =
  | 'venue_not_allowed'
  | 'role_mismatch'
  | 'certification_missing_or_expired'
  | 'not_available'
  | 'overlapping_shift'
  | 'insufficient_rest'
  | 'weekly_hours_exceeded'
  | 'called_out';

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** Is [start,end) covered by the worker's weekly windows, evaluated day by day in venue-local time? */
export function isAvailable(
  windows: CandidateFacts['availability'],
  startAt: Date,
  endAt: Date,
  timeZone: string,
): boolean {
  const p = localParts(startAt, timeZone);
  let weekday = p.weekday;
  let cursor = p.hour * 60 + p.minute; // local minutes within the current local day
  let remaining = Math.round((endAt.getTime() - startAt.getTime()) / MIN_MS);
  while (remaining > 0) {
    const segment = Math.min(remaining, 1440 - cursor);
    const covered = windows.some(
      (w) => w.weekday === weekday && w.startMinute <= cursor && w.endMinute >= cursor + segment,
    );
    if (!covered) return false;
    remaining -= segment;
    weekday = (weekday + 1) % 7;
    cursor = 0;
  }
  return true;
}

/** Empty array = eligible. Each failed rule contributes one reason. */
export function filterReasons(c: CandidateFacts, g: GapFacts, cfg: MatchingConfig): FilterReason[] {
  const reasons: FilterReason[] = [];
  if (c.orgId !== g.venue.orgId || c.status !== 'active') reasons.push('venue_not_allowed');
  if (!c.skills.includes(g.role)) reasons.push('role_mismatch');

  const endDay = new Date(g.endAt.getTime() - 1).toISOString().slice(0, 10);
  const needed = ROLE_REQUIRED_CERTS[g.role];
  const certOk = needed.every((need) =>
    c.certs.some((x) => x.cert === need && (x.validUntil === null || x.validUntil >= endDay)),
  );
  if (!certOk) reasons.push('certification_missing_or_expired');

  if (!isAvailable(c.availability, g.startAt, g.endAt, g.venue.timezone))
    reasons.push('not_available');

  const gapStart = g.startAt.getTime();
  const gapEnd = g.endAt.getTime();
  if (c.shifts.some((s) => s.startAt.getTime() < gapEnd && s.endAt.getTime() > gapStart)) {
    reasons.push('overlapping_shift');
  } else {
    const restMs = cfg.minRestHours * HOUR_MS;
    const tooClose = c.shifts.some(
      (s) =>
        (s.endAt.getTime() <= gapStart && gapStart - s.endAt.getTime() < restMs) ||
        (s.startAt.getTime() >= gapEnd && s.startAt.getTime() - gapEnd < restMs),
    );
    if (tooClose) reasons.push('insufficient_rest');
  }

  const week = localWeekKey(g.startAt, g.venue.timezone);
  const sameWeekMs = c.shifts
    .filter((s) => localWeekKey(s.startAt, g.venue.timezone) === week)
    .reduce((sum, s) => sum + (s.endAt.getTime() - s.startAt.getTime()), 0);
  if ((sameWeekMs + (gapEnd - gapStart)) / HOUR_MS > cfg.maxWeeklyHours)
    reasons.push('weekly_hours_exceeded');

  return reasons;
}

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export interface ScoreParts {
  reliability: number;
  acceptance: number;
  response: number;
  distance: number;
  venueHistory: number;
}

export interface Scored {
  total: number;
  parts: ScoreParts;
  distanceKm: number | null;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function scoreCandidate(c: CandidateFacts, g: GapFacts, cfg: MatchingConfig): Scored {
  const distanceKm =
    c.homeLat === null || c.homeLng === null
      ? null
      : haversineKm(c.homeLat, c.homeLng, g.venue.lat, g.venue.lng);
  const parts: ScoreParts = {
    reliability: clamp01(c.reliability),
    acceptance: clamp01(c.acceptanceRate),
    response: clamp01(1 - c.avgResponseSeconds / cfg.responseCapSeconds),
    distance: distanceKm === null ? 0 : clamp01(1 - distanceKm / cfg.maxDistanceKm),
    venueHistory: clamp01(c.priorShiftsAtVenue / cfg.venueHistoryCap),
  };
  const w = cfg.weights;
  const total = round6(
    parts.reliability * w.reliability +
      parts.acceptance * w.acceptance +
      parts.response * w.response +
      parts.distance * w.distance +
      parts.venueHistory * w.venueHistory,
  );
  return { total, parts, distanceKm };
}

export interface RankedCandidate {
  workerId: string;
  name: string;
  score: number;
  parts: ScoreParts;
  distanceKm: number | null;
}

export interface MatchResult {
  ranked: RankedCandidate[];
  excluded: Array<{ workerId: string; name: string; reasons: FilterReason[] }>;
}

/** Deterministic: sorted by score desc, ties broken by worker id. */
export function rankCandidates(
  cands: readonly CandidateFacts[],
  g: GapFacts,
  cfg: MatchingConfig,
): MatchResult {
  const ranked: RankedCandidate[] = [];
  const excluded: MatchResult['excluded'] = [];
  for (const c of cands) {
    const reasons = filterReasons(c, g, cfg);
    if (reasons.length) {
      excluded.push({ workerId: c.workerId, name: c.name, reasons });
      continue;
    }
    const s = scoreCandidate(c, g, cfg);
    ranked.push({
      workerId: c.workerId,
      name: c.name,
      score: s.total,
      parts: s.parts,
      distanceKm: s.distanceKm,
    });
  }
  ranked.sort((a, b) => b.score - a.score || a.workerId.localeCompare(b.workerId));
  excluded.sort((a, b) => a.workerId.localeCompare(b.workerId));
  return { ranked, excluded };
}
