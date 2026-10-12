import { and, eq } from 'drizzle-orm';
import { payments, shiftSlots, venues } from '../db/schema';
import { ServiceError } from './types';
import { maxAuthorization, type MaxAuthorization } from '../domain/money';
import { isShiftRole, type ShiftRole } from '../domain/roles';
import { moveSlot, movePayment } from './transitions';
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
    input.maxPremiumPct < 0 ||
    input.maxPremiumPct > 100
  ) {
    throw new ServiceError('invalid_input', 'invalid max premium');
  }
  const hold: MaxAuthorization = maxAuthorization({
    baseRateCents: input.baseRateCents,
    maxPremiumPct: input.maxPremiumPct,
    minutes,
    feeBps: config.platformFeeBps,
  });
  const actor = `user:${ctx.userId}`;
  const now = deps.now();

  return db.transaction(async (tx) => {
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
    const [pay] = await tx.select().from(payments).where(eq(payments.slotId, slotId));
    if (!pay || pay.status !== 'AUTHORIZED') {
      throw new ServiceError(
        'payment_not_authorized',
        'payment must be AUTHORIZED before offering',
      );
    }
    if (row.slot.status === 'OFFERING') return row.slot;
    return moveSlot(tx, slotId, 'OFFERING', { actor });
  });

  await deps.enqueue('send_wave', { slotId, wave: 1 }, { singletonKey: `wave:${slotId}:1` });
  const fillBy = result.fillBy ?? result.startAt;
  const delay = Math.max(0, Math.ceil((fillBy.getTime() - deps.now().getTime()) / 1000));
  await deps.enqueue(
    'fill_deadline',
    { slotId },
    { singletonKey: `deadline:${slotId}`, startAfter: delay },
  );
  return result;
}
