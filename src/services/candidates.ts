import { and, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { MATCHING } from '../config/matching';
import {
  shiftSlots,
  venues,
  workerAvailability,
  workerCertifications,
  workers,
} from '../db/schema';
import {
  rankCandidates,
  type CandidateFacts,
  type GapFacts,
  type MatchResult,
} from '../domain/matching';
import { isShiftRole } from '../domain/roles';
import { ServiceError, type DbLike } from './types';

const COMMITTED = ['CONFIRMED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'SETTLING'] as const;
const PRIOR_AT_VENUE = ['IN_PROGRESS', 'PENDING_APPROVAL', 'SETTLING', 'SETTLED'] as const;
const WEEK_MS = 7 * 24 * 3_600_000;

type SlotRow = typeof shiftSlots.$inferSelect;

export async function loadGapFacts(
  h: DbLike,
  slot: SlotRow,
): Promise<GapFacts & { venueId: string }> {
  const [venue] = await h.select().from(venues).where(eq(venues.id, slot.venueId));
  if (!venue) throw new ServiceError('not_found', 'venue not found');
  if (!isShiftRole(slot.role)) throw new ServiceError('invalid_input', 'unknown role');
  return {
    venueId: venue.id,
    role: slot.role,
    startAt: slot.startAt,
    endAt: slot.endAt,
    venue: { orgId: venue.orgId, lat: venue.lat, lng: venue.lng, timezone: venue.timezone },
    radiusMi: slot.searchRadiusMi ?? venue.searchRadiusMi,
  };
}

/** Load every active worker in the venue's org with the facts the filters and score need. */
export async function loadCandidates(
  h: DbLike,
  slot: SlotRow,
  gap: GapFacts,
): Promise<CandidateFacts[]> {
  const ws = await h
    .select()
    .from(workers)
    .where(and(eq(workers.orgId, gap.venue.orgId), eq(workers.status, 'active')));
  if (ws.length === 0) return [];
  const ids = ws.map((w) => w.id);

  const [avail, certs, shifts, prior] = await Promise.all([
    h.select().from(workerAvailability).where(inArray(workerAvailability.workerId, ids)),
    h.select().from(workerCertifications).where(inArray(workerCertifications.workerId, ids)),
    h
      .select({
        workerId: shiftSlots.workerId,
        startAt: shiftSlots.startAt,
        endAt: shiftSlots.endAt,
      })
      .from(shiftSlots)
      .where(
        and(
          inArray(shiftSlots.workerId, ids),
          inArray(shiftSlots.status, [...COMMITTED]),
          ne(shiftSlots.id, slot.id),
          gte(shiftSlots.endAt, new Date(slot.startAt.getTime() - WEEK_MS)),
          lt(shiftSlots.startAt, new Date(slot.endAt.getTime() + WEEK_MS)),
        ),
      ),
    h
      .select({ workerId: shiftSlots.workerId, n: sql<number>`count(*)::int` })
      .from(shiftSlots)
      .where(
        and(
          inArray(shiftSlots.workerId, ids),
          eq(shiftSlots.venueId, slot.venueId),
          inArray(shiftSlots.status, [...PRIOR_AT_VENUE]),
        ),
      )
      .groupBy(shiftSlots.workerId),
  ]);

  return ws.map((w) => ({
    workerId: w.id,
    name: w.name,
    orgId: w.orgId,
    status: w.status,
    skills: w.skills,
    certs: certs
      .filter((c) => c.workerId === w.id)
      .map((c) => ({ cert: c.cert, validUntil: c.validUntil })),
    availability: avail
      .filter((a) => a.workerId === w.id)
      .map((a) => ({ weekday: a.weekday, startMinute: a.startMinute, endMinute: a.endMinute })),
    reliability: w.reliabilityScore,
    acceptanceRate: w.acceptanceRate,
    avgResponseSeconds: w.avgResponseSeconds,
    homeLat: w.homeLat,
    homeLng: w.homeLng,
    shifts: shifts
      .filter((s) => s.workerId === w.id)
      .map((s) => ({ startAt: s.startAt, endAt: s.endAt })),
    priorShiftsAtVenue: prior.find((p) => p.workerId === w.id)?.n ?? 0,
  }));
}

/** The ranking plus the facts it was computed from (the "why this worker" text is built from both). */
export async function matchWithFacts(h: DbLike, slot: SlotRow) {
  const gap = await loadGapFacts(h, slot);
  const cands = await loadCandidates(h, slot, gap);
  const result = rankCandidates(cands, gap, MATCHING);
  const facts = new Map(cands.map((c) => [c.workerId, c]));
  if (!slot.replacesSlotId) return { result, facts, gap };
  // The worker who called out of the replaced shift is never offered its cover.
  const [orig] = await h
    .select({ workerId: shiftSlots.workerId })
    .from(shiftSlots)
    .where(eq(shiftSlots.id, slot.replacesSlotId));
  const out = orig?.workerId;
  if (!out) return { result, facts, gap };
  const gone = result.ranked.find((r) => r.workerId === out);
  return {
    result: {
      ranked: result.ranked.filter((r) => r.workerId !== out),
      excluded: gone
        ? [...result.excluded, { workerId: out, name: gone.name, reasons: ['called_out' as const] }]
        : result.excluded,
    },
    facts,
    gap,
  };
}

export async function matchForSlot(h: DbLike, slot: SlotRow): Promise<MatchResult> {
  return (await matchWithFacts(h, slot)).result;
}
