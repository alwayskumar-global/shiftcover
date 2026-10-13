import { latestPayment } from './payment-queries';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PREMIUM_RANGE } from '../config/business';
import { MATCHING } from '../config/matching';
import { offers, payments, shiftSlots, venues } from '../db/schema';
import { ServiceError } from './types';
import { maxAuthorization, type MaxAuthorization } from '../domain/money';
import { isShiftRole, type ShiftRole } from '../domain/roles';
import { ensureOrder, releaseHold } from './payments';
import { moveOffer, movePayment, moveSlot, writeAudit } from './transitions';
import type { ServiceDeps } from './types';

export interface ManagerCtx {
  orgId: string;
  userId: string;
}

export interface CreateGapInput {
  venueId: string;
  role: string;
  startAt: Date;
  endAt: Date;
  baseRateCents: number;
  maxPremiumPct: number;
  /** The shift this gap replaces (e.g. a worker called in sick); it is cancelled. */
  replacesSlotId?: string;
  gapReason?: string;
}

const MAX_SHIFT_MINUTES = 16 * 60;
const FILL_BY_BEFORE_START_MS = 30 * 60_000;
const MIN_FILL_WINDOW_MS = 10 * 60_000;

/** Default fill_by = start - 30 min, but never already past: at least 10 min from now (capped at start). */
export function defaultFillBy(startAt: Date, now: Date): Date {
  const byRule = startAt.getTime() - FILL_BY_BEFORE_START_MS;
  const floor = Math.min(startAt.getTime(), now.getTime() + MIN_FILL_WINDOW_MS);
  return new Date(Math.max(byRule, floor));
}

export async function createGap(deps: ServiceDeps, ctx: ManagerCtx, input: CreateGapInput) {
  const { db, config } = deps;
  if (!isShiftRole(input.role)) throw new ServiceError('invalid_input', 'unknown role');
  const minutes = Math.round((input.endAt.getTime() - input.startAt.getTime()) / 60_000);
  if (!(minutes > 0 && minutes <= MAX_SHIFT_MINUTES))
    throw new ServiceError('invalid_input', 'invalid shift length');
  if (!Number.isInteger(input.baseRateCents) || input.baseRateCents <= 0)
    throw new ServiceError('invalid_input', 'invalid base rate');
  if (
    !Number.isInteger(input.maxPremiumPct) ||
    input.maxPremiumPct < PREMIUM_RANGE.minPct ||
    input.maxPremiumPct > PREMIUM_RANGE.maxPct
  ) {
    throw new ServiceError('invalid_input', 'invalid max premium');
  }
  const hold: MaxAuthorization = maxAuthorization({
    baseRateCents: input.baseRateCents,
    maxPremiumPct: input.maxPremiumPct,
    minutes,
    feeBps: config.platformFeeBps,
    fixedFeeCents: config.platformFixedFeeCents,
  });
  const actor = `user:${ctx.userId}`;
  const now = deps.now();

  const created = await db.transaction(async (tx) => {
    const [venue] = await tx
      .select()
      .from(venues)
      .where(and(eq(venues.id, input.venueId), eq(venues.orgId, ctx.orgId)));
    if (!venue) throw new ServiceError('not_found', 'venue not found');

    if (input.replacesSlotId) {
      const [orig] = await tx
        .select({ id: shiftSlots.id })
        .from(shiftSlots)
        .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
        .where(and(eq(shiftSlots.id, input.replacesSlotId), eq(venues.orgId, ctx.orgId)));
      if (!orig) throw new ServiceError('not_found', 'replaced slot not found');
      await moveSlot(tx, orig.id, 'CANCELLED', { actor, meta: { reason: 'replaced_by_gap' } });
    }

    const [created] = await tx
      .insert(shiftSlots)
      .values({
        venueId: venue.id,
        role: input.role,
        startAt: input.startAt,
        endAt: input.endAt,
        status: 'PLANNED',
        baseRateCents: input.baseRateCents,
        maxPremiumPct: input.maxPremiumPct,
        fillBy: defaultFillBy(input.startAt, now),
        replacesSlotId: input.replacesSlotId ?? null,
        gapReason: input.gapReason ?? null,
      })
      .returning();
    const slot = await moveSlot(tx, created!.id, 'OPEN', { actor, meta: { source: 'createGap' } });

    const [pay] = await tx
      .insert(payments)
      .values({ slotId: slot.id, status: 'NONE', authorizedCents: hold.authorizedCents })
      .returning();
    const payment = await movePayment(tx, pay!.id, 'AUTH_PENDING_APPROVAL', { actor });
    return { slot, payment, hold, role: input.role as ShiftRole, minutes };
  });

  // Real money: create the PayPal order now (intent AUTHORIZE, the max hold) and keep its id. Best effort: the gap
  // exists either way, and the approval button asks the server for the order again (ensureOrder is idempotent).
  if (deps.payments) {
    try {
      await ensureOrder(deps, ctx, created.slot.id);
    } catch {
      console.error('[createGap] PayPal order not created yet; the approval step will retry it');
    }
  }
  return created;
}

/**
 * Requires the payment to be AUTHORIZED, moves OPEN -> OFFERING and schedules wave 1 + the fill deadline.
 * Safe to call again for a slot already OFFERING: it only re-enqueues (singleton keys make that idempotent).
 */
export async function startOffering(deps: ServiceDeps, ctx: ManagerCtx, slotId: string) {
  const { db } = deps;
  const actor = `user:${ctx.userId}`;
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ slot: shiftSlots })
      .from(shiftSlots)
      .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
      .where(and(eq(shiftSlots.id, slotId), eq(venues.orgId, ctx.orgId)))
      .for('update', { of: shiftSlots });
    if (!row) throw new ServiceError('not_found', 'gap not found');
    const pay = await latestPayment(tx, slotId);
    if (!pay || pay.status !== 'AUTHORIZED') {
      throw new ServiceError(
        'payment_not_authorized',
        'payment must be AUTHORIZED before offering',
      );
    }
    if (row.slot.status === 'OFFERING') return row.slot;
    return moveSlot(tx, slotId, 'OFFERING', { actor });
  });

  // The slot is already OFFERING and committed. A dispatch failure here must not become a failed request or a
  // stuck slot: log it and let recoverDispatch (the `recover_dispatch` job, every minute) re-enqueue. Enqueueing
  // uses singleton keys, so retries and the recovery job can never double-send.
  const fillBy = result.fillBy ?? result.startAt;
  const delay = Math.max(0, Math.ceil((fillBy.getTime() - deps.now().getTime()) / 1000));
  const attempts: Array<[string, () => Promise<unknown>]> = [
    [
      'send_wave',
      () => deps.enqueue('send_wave', { slotId, wave: 1 }, { singletonKey: `wave:${slotId}:1` }),
    ],
    [
      'fill_deadline',
      () =>
        deps.enqueue(
          'fill_deadline',
          { slotId },
          { singletonKey: `deadline:${slotId}`, startAfter: delay },
        ),
    ],
  ];
  for (const [name, run] of attempts) {
    try {
      await run();
    } catch {
      console.error(
        `[startOffering] dispatch of ${name} failed for slot ${slotId}; recover_dispatch will retry`,
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------- widen radius
export async function widenRadius(
  deps: ServiceDeps,
  ctx: ManagerCtx,
  slotId: string,
  newMi: number,
) {
  const actor = `user:${ctx.userId}`;
  const now = deps.now();
  let reopened = false;
  let wave = 1;
  const slot = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ slot: shiftSlots, venue: venues })
      .from(shiftSlots)
      .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
      .where(and(eq(shiftSlots.id, slotId), eq(venues.orgId, ctx.orgId)))
      .for('update', { of: shiftSlots });
    if (!row) throw new ServiceError('not_found', 'gap not found');
    const current = row.slot.searchRadiusMi ?? row.venue.searchRadiusMi;
    if (!['OPEN', 'OFFERING', 'UNFILLED'].includes(row.slot.status)) {
      throw new ServiceError(
        'invalid_state',
        'the search radius can only change while the gap is unfilled',
      );
    }
    if (!Number.isInteger(newMi) || newMi <= current || newMi > MATCHING.maxSearchRadiusMi) {
      throw new ServiceError(
        'invalid_input',
        `radius must be a whole number above ${current} and at most ${MATCHING.maxSearchRadiusMi}`,
      );
    }
    await writeAudit(tx, {
      actor,
      action: 'shift_slot.widen_radius',
      entity: 'shift_slot',
      entityId: slotId,
      before: { searchRadiusMi: current },
      after: { searchRadiusMi: newMi },
    });
    if (row.slot.status === 'UNFILLED') {
      // The hold was released at the deadline: re-open with a fresh payment attempt that needs approval again.
      reopened = true;
      const prev = await latestPayment(tx, slotId);
      const next = await moveSlot(
        tx,
        slotId,
        'OPEN',
        { actor, meta: { reason: 'widen_radius' } },
        {
          searchRadiusMi: newMi,
          fillBy: defaultFillBy(row.slot.startAt, now),
        },
      );
      const [pay] = await tx
        .insert(payments)
        .values({
          slotId,
          attempt: (prev?.attempt ?? 0) + 1,
          status: 'NONE',
          authorizedCents: prev?.authorizedCents ?? 0,
        })
        .returning();
      await movePayment(tx, pay!.id, 'AUTH_PENDING_APPROVAL', { actor });
      return next;
    }
    const [updated] = await tx
      .update(shiftSlots)
      .set({ searchRadiusMi: newMi, updatedAt: sql`now()` })
      .where(eq(shiftSlots.id, slotId))
      .returning();
    const waves = await tx
      .select({ wave: offers.wave })
      .from(offers)
      .where(eq(offers.slotId, slotId));
    wave = waves.reduce((m, o) => Math.max(m, o.wave), 1);
    return updated!;
  });

  if (!reopened && slot.status === 'OFFERING') {
    // Re-run the current wave so workers newly inside the radius are offered right away (idempotent).
    try {
      await deps.enqueue(
        'send_wave',
        { slotId, wave },
        { singletonKey: `wave:${slotId}:${wave}:r${newMi}` },
      );
    } catch {
      console.error(
        `[widenRadius] dispatch failed for slot ${slotId}; the next wave will include the wider radius`,
      );
    }
  }
  return { slot, reopened };
}

// ---------------------------------------------------------------------------------------- cancel
/** Cancel an open, offering or confirmed gap: withdraw offers, release the hold, tell the booked worker. */
export async function cancelGap(
  deps: ServiceDeps,
  ctx: ManagerCtx,
  slotId: string,
  reason?: string,
) {
  const actor = `user:${ctx.userId}`;
  const cancelled = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ slot: shiftSlots })
      .from(shiftSlots)
      .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
      .where(and(eq(shiftSlots.id, slotId), eq(venues.orgId, ctx.orgId)))
      .for('update', { of: shiftSlots });
    if (!row) throw new ServiceError('not_found', 'gap not found');
    const { slot } = row;
    if (!['OPEN', 'OFFERING', 'CONFIRMED'].includes(slot.status)) {
      throw new ServiceError('invalid_state', 'this gap can no longer be cancelled');
    }
    const open = await tx
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.slotId, slotId), inArray(offers.status, ['SENT', 'OPENED'])));
    for (const o of open)
      await moveOffer(tx, o.id, 'WITHDRAWN', { actor, meta: { reason: 'gap_cancelled' } });
    const cancelled = await moveSlot(
      tx,
      slotId,
      'CANCELLED',
      { actor, meta: { reason: reason ?? null } },
      {
        cancelledAt: deps.now(),
        cancelledBy: actor,
      },
    );
    if (slot.status === 'CONFIRMED' && slot.workerId) {
      await deps.notifier(tx).send({
        recipient: `worker:${slot.workerId}`,
        channels: ['in_app', 'email', 'push'],
        kind: 'shift_cancelled',
        payload: { slotId, role: slot.role, startAt: slot.startAt.toISOString() },
      });
    }
    return cancelled;
  });
  // Release the hold after the commit (a PayPal call never runs inside a transaction); reconcile retries a failure.
  await releaseHold(deps, slotId, actor);
  return cancelled;
}
