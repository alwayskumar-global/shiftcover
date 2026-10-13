import { eq } from 'drizzle-orm';
import { SHIFT_DAY } from '../config/business';
import { shiftSlots, venues } from '../db/schema';
import { defaultFillBy, type ManagerCtx } from './gaps';
import { managersForVenue } from './managers';
import { releaseHold } from './payments';
import { moveSlot } from './transitions';
import { ServiceError, type ServiceDeps, type Tx } from './types';

/**
 * Shift day (PLAN.md 4C): the worker taps "I've arrived" and "Finished"; a manager can confirm the times when
 * the worker cannot. Only the two timestamps and the derived hours are stored: no location data of any kind.
 */

const MAX_SHIFT_HOURS = 16;

/** Hours between two instants with 2 decimals (what the manager sees before approving). */
export function hoursBetween(from: Date, to: Date): number {
  return Math.round(((to.getTime() - from.getTime()) / 3_600_000) * 100) / 100;
}

async function notifyHours(
  deps: ServiceDeps,
  tx: Tx,
  venueId: string,
  slotId: string,
  hours: number,
) {
  for (const m of await managersForVenue(tx, venueId)) {
    await deps.notifier(tx).send({
      recipient: `manager:${m.id}`,
      channels: ['in_app', 'email'],
      kind: 'hours_to_approve',
      payload: { slotId, actualHours: hours },
    });
  }
}

export async function arrive(deps: ServiceDeps, workerId: string, slotId: string) {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const [s] = await tx.select().from(shiftSlots).where(eq(shiftSlots.id, slotId)).for('update');
    if (!s || s.workerId !== workerId) throw new ServiceError('not_found', 'shift not found');
    if (s.status === 'IN_PROGRESS' || s.status === 'PENDING_APPROVAL') return s; // idempotent
    if (s.status !== 'CONFIRMED')
      throw new ServiceError('invalid_state', 'this shift cannot be started');
    if (now.getTime() < s.startAt.getTime() - SHIFT_DAY.arriveEarlyMinutes * 60_000)
      throw new ServiceError('invalid_state', 'it is too early to check in');
    if (now > s.endAt) throw new ServiceError('invalid_state', 'this shift has already ended');
    return moveSlot(
      tx,
      slotId,
      'IN_PROGRESS',
      { actor: `worker:${workerId}` },
      {
        checkInAt: now,
        checkInBy: 'worker',
      },
    );
  });
}

export async function finish(deps: ServiceDeps, workerId: string, slotId: string) {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const [s] = await tx.select().from(shiftSlots).where(eq(shiftSlots.id, slotId)).for('update');
    if (!s || s.workerId !== workerId) throw new ServiceError('not_found', 'shift not found');
    if (s.status === 'PENDING_APPROVAL') return s; // idempotent
    if (s.status !== 'IN_PROGRESS' || !s.checkInAt)
      throw new ServiceError('invalid_state', 'check in before finishing the shift');
    const hours = hoursBetween(s.checkInAt, now);
    const row = await moveSlot(
      tx,
      slotId,
      'PENDING_APPROVAL',
      { actor: `worker:${workerId}` },
      {
        checkOutAt: now,
        checkOutBy: 'worker',
        actualHours: hours.toFixed(2),
      },
    );
    await notifyHours(deps, tx, s.venueId, slotId, hours);
    return row;
  });
}

/** Manager fallback: confirm the times when the worker could not tap (e.g. no signal). */
export async function managerConfirmTimes(
  deps: ServiceDeps,
  ctx: ManagerCtx,
  slotId: string,
  input: { checkInAt: Date; checkOutAt?: Date },
) {
  const actor = `user:${ctx.userId}`;
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ slot: shiftSlots, venue: venues })
      .from(shiftSlots)
      .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
      .where(eq(shiftSlots.id, slotId))
      .for('update', { of: shiftSlots });
    if (!row || row.venue.orgId !== ctx.orgId)
      throw new ServiceError('not_found', 'shift not found');
    const s = row.slot;
    if (input.checkOutAt && hoursBetween(input.checkInAt, input.checkOutAt) <= 0)
      throw new ServiceError('invalid_input', 'check-out must be after check-in');
    if (input.checkOutAt && hoursBetween(input.checkInAt, input.checkOutAt) > MAX_SHIFT_HOURS)
      throw new ServiceError('invalid_input', 'that is longer than any shift');
    let cur = s;
    if (cur.status === 'CONFIRMED') {
      cur = await moveSlot(
        tx,
        slotId,
        'IN_PROGRESS',
        { actor },
        {
          checkInAt: input.checkInAt,
          checkInBy: actor,
        },
      );
    } else if (cur.status !== 'IN_PROGRESS') {
      throw new ServiceError('invalid_state', 'this shift is not in progress');
    }
    if (input.checkOutAt) {
      const checkIn = cur.checkInAt ?? input.checkInAt;
      const hours = hoursBetween(checkIn, input.checkOutAt);
      if (hours <= 0) throw new ServiceError('invalid_input', 'check-out must be after check-in');
      cur = await moveSlot(
        tx,
        slotId,
        'PENDING_APPROVAL',
        { actor },
        {
          checkOutAt: input.checkOutAt,
          checkOutBy: actor,
          actualHours: hours.toFixed(2),
        },
      );
      await notifyHours(deps, tx, s.venueId, slotId, hours);
    }
    return cur;
  });
}

/**
 * Manager marks a no-show. PLAN decision (M2): the authorization is KEPT across a re-offer and released only when
 * the slot ends UNFILLED or CANCELLED. So with enough of the shift left the slot goes back to OFFERING for a new set
 * of workers; with too little left the hold is voided and the slot stays NO_SHOW.
 */
export async function markNoShow(deps: ServiceDeps, ctx: ManagerCtx, slotId: string) {
  const actor = `user:${ctx.userId}`;
  const now = deps.now();
  const out = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ slot: shiftSlots, venue: venues })
      .from(shiftSlots)
      .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
      .where(eq(shiftSlots.id, slotId))
      .for('update', { of: shiftSlots });
    if (!row || row.venue.orgId !== ctx.orgId)
      throw new ServiceError('not_found', 'shift not found');
    const s = row.slot;
    if (s.status !== 'CONFIRMED')
      throw new ServiceError('invalid_state', 'only a confirmed shift can be a no-show');
    if (now < s.startAt) throw new ServiceError('invalid_state', 'the shift has not started yet');
    const worker = s.workerId;
    await moveSlot(tx, slotId, 'NO_SHOW', { actor, meta: { workerId: worker } });
    const remainingMin = (s.endAt.getTime() - now.getTime()) / 60_000;
    const reoffer = remainingMin >= SHIFT_DAY.noShowReofferMinRemainingMinutes;
    let version = 0;
    if (reoffer) {
      const fillBy = new Date(
        Math.min(s.endAt.getTime(), now.getTime() + SHIFT_DAY.noShowReofferFillMinutes * 60_000),
      );
      const next = await moveSlot(
        tx,
        slotId,
        'OFFERING',
        { actor, meta: { reason: 'no_show_reoffer' } },
        {
          workerId: null,
          offeredRateCents: null,
          fillBy: fillBy > now ? fillBy : defaultFillBy(s.startAt, now),
        },
      );
      version = next.version;
    }
    for (const m of await managersForVenue(tx, s.venueId)) {
      await deps.notifier(tx).send({
        recipient: `manager:${m.id}`,
        channels: ['in_app', 'email'],
        kind: reoffer ? 'no_show_reoffer' : 'no_show',
        payload: { slotId },
      });
    }
    if (worker)
      await deps.notifier(tx).send({
        recipient: `worker:${worker}`,
        channels: ['in_app', 'email'],
        kind: 'no_show_recorded',
        payload: { slotId },
      });
    return {
      reoffer,
      version,
      fillBy: reoffer
        ? (await tx.select().from(shiftSlots).where(eq(shiftSlots.id, slotId)))[0]!.fillBy
        : null,
    };
  });

  if (out.reoffer) {
    const delay = Math.max(0, Math.ceil(((out.fillBy ?? now).getTime() - now.getTime()) / 1000));
    try {
      await deps.enqueue(
        'send_wave',
        { slotId, wave: 3, reoffer: true },
        { singletonKey: `wave:${slotId}:reoffer:${out.version}` },
      );
      await deps.enqueue(
        'fill_deadline',
        { slotId },
        { singletonKey: `deadline:${slotId}:${out.version}`, startAfter: delay },
      );
    } catch {
      console.error('[no-show] dispatch failed; recover_dispatch will pick the slot up');
    }
  } else {
    await releaseHold(deps, slotId, actor);
  }
  return { reoffered: out.reoffer };
}
