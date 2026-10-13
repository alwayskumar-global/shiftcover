import { desc, eq, inArray } from 'drizzle-orm';
import { authUser, offers, payments, shiftSlots, users, venues } from '../db/schema';
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
      venueArea: venues.area,
      venueTz: venues.timezone,
      venueAddress: venues.address,
      orgId: venues.orgId,
      offeredRateCents: shiftSlots.offeredRateCents,
      checkInAt: shiftSlots.checkInAt,
      checkOutAt: shiftSlots.checkOutAt,
      approvedHours: shiftSlots.approvedHours,
    })
    .from(offers)
    .innerJoin(shiftSlots, eq(shiftSlots.id, offers.slotId))
    .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
    .where(eq(offers.workerId, workerId))
    .orderBy(desc(shiftSlots.startAt));
  // Latest payment attempt per slot (worker pay and status only; never the employer's amounts or PayPal references).
  const slotIds = [...new Set(mine.map((m) => m.slotId))];
  const pays = slotIds.length
    ? await h.select().from(payments).where(inArray(payments.slotId, slotIds))
    : [];
  const latest = new Map<string, (typeof pays)[number]>();
  for (const p of pays) {
    const cur = latest.get(p.slotId);
    if (!cur || p.attempt > cur.attempt) latest.set(p.slotId, p);
  }
  // The manager's name for the copy that says who is checking the hours: the organisation's first manager.
  const orgIds = [...new Set(mine.map((m) => m.orgId))];
  const managers = orgIds.length
    ? await h
        .select({ orgId: users.orgId, name: authUser.name, createdAt: users.createdAt })
        .from(users)
        .innerJoin(authUser, eq(authUser.email, users.email))
        .where(inArray(users.orgId, orgIds))
    : [];
  const managerOf = new Map<string, string>();
  for (const m of [...managers].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()))
    if (!managerOf.has(m.orgId)) managerOf.set(m.orgId, m.name);
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
    venueArea: m.venueArea,
    venueTz: m.venueTz,
    venueAddress: m.venueAddress,
    managerName: managerOf.get(m.orgId) ?? null,
    hours: Math.round(((m.endAt.getTime() - m.startAt.getTime()) / 3_600_000) * 100) / 100,
    offeredRateCents: m.offeredRateCents,
    checkInAt: m.checkInAt?.toISOString() ?? null,
    checkOutAt: m.checkOutAt?.toISOString() ?? null,
    approvedHours: m.approvedHours === null ? null : Number(m.approvedHours),
    paymentStatus: m.assignedToMe === workerId ? (latest.get(m.slotId)?.status ?? null) : null,
    workerPayCents: m.assignedToMe === workerId ? (latest.get(m.slotId)?.workerPayCents ?? 0) : 0,
  }));
}
