import { desc, eq } from 'drizzle-orm';
import { offers, shiftSlots, venues } from '../db/schema';
import type { DbLike } from './types';

/**
 * Everything a worker may read about themselves. Every query is scoped by the authenticated worker id
 * (PLAN.md 11): there is no code path that takes another worker's id from the request.
 */
export async function workerShifts(h: DbLike, workerId: string) {
  const mine = await h
    .select({
      offerId: offers.id,
      offerStatus: offers.status,
      rateCents: offers.rateCents,
      expiresAt: offers.expiresAt,
      slotId: shiftSlots.id,
      slotStatus: shiftSlots.status,
      role: shiftSlots.role,
      startAt: shiftSlots.startAt,
      endAt: shiftSlots.endAt,
      assignedToMe: shiftSlots.workerId,
      venueName: venues.name,
    })
    .from(offers)
    .innerJoin(shiftSlots, eq(shiftSlots.id, offers.slotId))
    .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
    .where(eq(offers.workerId, workerId))
    .orderBy(desc(shiftSlots.startAt));
  return mine.map((m) => ({
    offerId: m.offerId,
    offerStatus: m.offerStatus,
    rateCents: m.rateCents,
    expiresAt: m.expiresAt.toISOString(),
    slotId: m.slotId,
    slotStatus: m.slotStatus,
    role: m.role,
    startAt: m.startAt.toISOString(),
    endAt: m.endAt.toISOString(),
    venueName: m.venueName,
    isMine: m.assignedToMe === workerId,
  }));
}
