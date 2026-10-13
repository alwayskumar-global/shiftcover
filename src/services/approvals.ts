import { and, asc, eq, inArray } from 'drizzle-orm';
import { initialsOf, avatarTint, publicPaymentStatus } from '../api/adapters';
import { payments, shiftSlots, venues, workers } from '../db/schema';
import { maxApprovableHours } from '../domain/money';
import type { ServiceDeps } from './types';

/**
 * Hours waiting for the manager (PLAN 4C/4D): shifts in PENDING_APPROVAL, plus shifts mid-settlement whose charge was
 * declined (the manager retries from the same card). Every figure the screen shows comes from here or from the fee
 * config returned with it; the browser only multiplies what it is given to preview the charge.
 */
export async function listApprovals(deps: ServiceDeps, orgId: string) {
  const rows = await deps.db
    .select({ slot: shiftSlots, venue: venues, worker: workers })
    .from(shiftSlots)
    .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
    .leftJoin(workers, eq(workers.id, shiftSlots.workerId))
    .where(
      and(eq(venues.orgId, orgId), inArray(shiftSlots.status, ['PENDING_APPROVAL', 'SETTLING'])),
    )
    .orderBy(asc(shiftSlots.checkOutAt));
  const ids = rows.map((r) => r.slot.id);
  const pays = ids.length
    ? await deps.db.select().from(payments).where(inArray(payments.slotId, ids))
    : [];
  const latest = new Map<string, (typeof pays)[number]>();
  for (const p of pays) {
    const cur = latest.get(p.slotId);
    if (!cur || p.attempt > cur.attempt) latest.set(p.slotId, p);
  }
  const feeBps = deps.config.platformFeeBps;
  const fixedFeeCents = deps.config.platformFixedFeeCents ?? 0;
  const items = rows.flatMap((r) => {
    const pay = latest.get(r.slot.id);
    if (!pay || !r.worker || r.slot.offeredRateCents === null) return [];
    if (r.slot.status === 'SETTLING' && pay.status !== 'CAPTURE_DECLINED') return [];
    const s = r.slot;
    return [
      {
        slotId: s.id,
        slotStatus: s.status,
        workerName: r.worker.name,
        workerInitials: initialsOf(r.worker.name),
        workerTint: avatarTint(r.worker.id),
        role: s.role,
        venueTz: r.venue.timezone,
        startAt: s.startAt,
        endAt: s.endAt,
        scheduledHours:
          Math.round(((s.endAt.getTime() - s.startAt.getTime()) / 3_600_000) * 100) / 100,
        checkInAt: s.checkInAt,
        checkOutAt: s.checkOutAt,
        actualHours: s.actualHours === null ? null : Number(s.actualHours),
        approvedHours: s.approvedHours === null ? null : Number(s.approvedHours),
        rateCents: s.offeredRateCents!,
        authorizedCents: pay.authorizedCents,
        maxHours: maxApprovableHours({
          rateCents: s.offeredRateCents!,
          authorizedCents: pay.authorizedCents,
          feeBps,
          fixedFeeCents,
        }),
        paymentStatus: publicPaymentStatus(pay.status),
        lastError: pay.lastError,
        captureReference: pay.captureId,
      },
    ];
  });
  return { serverTime: deps.now(), feeBps, fixedFeeCents, items };
}
