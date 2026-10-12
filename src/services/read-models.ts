import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { offers, payments, shiftSlots, venues, workers } from '../db/schema';
import { ROLE_LABELS, isShiftRole, type ShiftRole } from '../domain/roles';
import { localDateString, localDayBounds } from '../lib/time';
import { ServiceError, type DbLike } from './types';

const label = (r: string) => (isShiftRole(r) ? ROLE_LABELS[r] : r);
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

export async function primaryVenue(h: DbLike, orgId: string) {
  const [v] = await h
    .select()
    .from(venues)
    .where(eq(venues.orgId, orgId))
    .orderBy(asc(venues.createdAt))
    .limit(1);
  if (!v) throw new ServiceError('not_found', 'no venue for this organisation');
  return v;
}

/** Roster for one venue-local day, shaped for the Bryntum Scheduler (resources + events + summary). */
export async function roster(h: DbLike, orgId: string, date: string | undefined, now: Date) {
  const venue = await primaryVenue(h, orgId);
  const day = date ?? localDateString(now, venue.timezone);
  const { start, end } = localDayBounds(day, venue.timezone);

  const ws = await h
    .select()
    .from(workers)
    .where(and(eq(workers.orgId, orgId), inArray(workers.status, ['active', 'invited'])))
    .orderBy(asc(workers.name));
  const slots = await h
    .select({ slot: shiftSlots, workerName: workers.name })
    .from(shiftSlots)
    .leftJoin(workers, eq(workers.id, shiftSlots.workerId))
    .where(
      and(
        eq(shiftSlots.venueId, venue.id),
        lt(shiftSlots.startAt, end),
        gte(shiftSlots.endAt, start),
      ),
    )
    .orderBy(asc(shiftSlots.startAt));

  const gapStatuses = ['OPEN', 'OFFERING', 'UNFILLED'];
  const assigned = ['CONFIRMED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'SETTLING', 'SETTLED'];
  const live = slots.filter((s) => s.slot.status !== 'CANCELLED');
  return {
    date: day,
    timezone: venue.timezone,
    venue: { id: venue.id, name: venue.name },
    summary: {
      openGaps: live.filter((s) => s.slot.status === 'OPEN').length,
      offering: live.filter((s) => s.slot.status === 'OFFERING').length,
      shiftsToday: live.filter((s) => assigned.includes(s.slot.status)).length,
    },
    resources: ws.map((w) => ({
      id: w.id,
      kind: 'worker' as const,
      name: w.name,
      initials: initials(w.name),
      roles: w.skills,
      reliabilityScore: w.reliabilityScore,
    })),
    events: slots.map(({ slot, workerName }) => ({
      id: slot.id,
      resourceId: slot.workerId,
      workerName,
      role: slot.role as ShiftRole,
      roleLabel: label(slot.role),
      status: slot.status,
      isGap: gapStatuses.includes(slot.status),
      startDate: slot.startAt.toISOString(),
      endDate: slot.endAt.toISOString(),
      baseRateCents: slot.baseRateCents,
      offeredRateCents: slot.offeredRateCents,
    })),
  };
}

export async function gapDetail(h: DbLike, orgId: string, slotId: string) {
  const [row] = await h
    .select({ slot: shiftSlots, venueName: venues.name, workerName: workers.name })
    .from(shiftSlots)
    .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
    .leftJoin(workers, eq(workers.id, shiftSlots.workerId))
    .where(and(eq(shiftSlots.id, slotId), eq(venues.orgId, orgId)));
  if (!row) throw new ServiceError('not_found', 'gap not found');
  const { slot } = row;

  const os = await h
    .select({ offer: offers, workerName: workers.name })
    .from(offers)
    .innerJoin(workers, eq(workers.id, offers.workerId))
    .where(eq(offers.slotId, slotId))
    .orderBy(asc(offers.wave), asc(offers.createdAt));
  const [pay] = await h.select().from(payments).where(eq(payments.slotId, slotId));

  const waveNums = [...new Set(os.map((o) => o.offer.wave))];
  const waves = waveNums.map((wave) => {
    const rows = os.filter((o) => o.offer.wave === wave).map((o) => o.offer);
    const count = (s: string) => rows.filter((o) => o.status === s).length;
    return {
      wave,
      rateCents: rows[0]!.rateCents,
      sent: rows.length,
      // "opened" counts every offer that was opened at some point (opened, claimed, or since withdrawn)
      opened: rows.filter((o) => o.openedAt !== null).length,
      claimed: count('CLAIMED'),
      expired: count('EXPIRED'),
      withdrawn: count('WITHDRAWN'),
      declined: count('DECLINED'),
      sentAt: rows
        .reduce((min, o) => (o.createdAt < min ? o.createdAt : min), rows[0]!.createdAt)
        .toISOString(),
    };
  });

  return {
    slot: {
      id: slot.id,
      venueId: slot.venueId,
      venueName: row.venueName,
      role: slot.role as ShiftRole,
      roleLabel: label(slot.role),
      status: slot.status,
      startAt: slot.startAt.toISOString(),
      endAt: slot.endAt.toISOString(),
      fillBy: slot.fillBy?.toISOString() ?? null,
      baseRateCents: slot.baseRateCents,
      maxPremiumPct: slot.maxPremiumPct,
      offeredRateCents: slot.offeredRateCents,
      version: slot.version,
      worker: slot.workerId && row.workerName ? { id: slot.workerId, name: row.workerName } : null,
    },
    waves,
    offers: os.map(({ offer, workerName }) => ({
      id: offer.id,
      workerId: offer.workerId,
      workerName,
      wave: offer.wave,
      rateCents: offer.rateCents,
      status: offer.status,
      expiresAt: offer.expiresAt.toISOString(),
      openedAt: offer.openedAt?.toISOString() ?? null,
      claimedAt: offer.claimedAt?.toISOString() ?? null,
    })),
    payment: pay
      ? {
          status: pay.status,
          currency: 'USD' as const,
          authorizedCents: pay.authorizedCents,
          capturedCents: pay.capturedCents,
          workerPayCents: pay.workerPayCents,
          platformFeeCents: pay.platformFeeCents,
        }
      : null,
  };
}

export async function findRecognisedSlot(
  h: DbLike,
  orgId: string,
  venueId: string,
  firstName: string,
  window: { start: Date; end: Date } | null,
  day: { start: Date; end: Date },
) {
  const rows = await h
    .select({ slot: shiftSlots, name: workers.name })
    .from(shiftSlots)
    .innerJoin(workers, eq(workers.id, shiftSlots.workerId))
    .where(
      and(
        eq(shiftSlots.venueId, venueId),
        eq(workers.orgId, orgId),
        eq(shiftSlots.status, 'CONFIRMED'),
        sql`lower(${workers.name}) like ${firstName.toLowerCase() + ' %'}`,
        lt(shiftSlots.startAt, window?.end ?? day.end),
        gte(shiftSlots.endAt, window?.start ?? day.start),
      ),
    )
    .orderBy(asc(shiftSlots.startAt));
  return rows[0]?.slot ?? null;
}
