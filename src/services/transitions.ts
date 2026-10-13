import { and, eq, sql } from 'drizzle-orm';
import { auditLog, offers, payments, shiftSlots } from '../db/schema';
import type { AuditEntry } from '../domain/audit';
import { offerMachine } from '../domain/offer';
import { paymentMachine } from '../domain/payment';
import { slotMachine } from '../domain/slot';
import type { OfferState, PaymentState, SlotState } from '../domain/states';
import { ServiceError, type Tx } from './types';

/**
 * The ONLY place rows change status (PLAN.md 5): lock the row, run the pure state-machine function
 * (throws on an invalid transition), update, and write the audit row. Must run inside a transaction.
 */

export async function writeAudit(tx: Tx, a: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    actor: a.actor,
    action: a.action,
    entity: a.entity,
    entityId: a.entityId,
    before: a.before,
    after: a.after,
  });
}

export interface MoveCtx {
  actor: string;
  meta?: Record<string, unknown>;
}

type SlotRow = typeof shiftSlots.$inferSelect;
type OfferRow = typeof offers.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;

type PaymentPatch = Partial<
  Pick<
    PaymentRow,
    | 'paypalOrderId'
    | 'authorizationId'
    | 'captureId'
    | 'payoutBatchId'
    | 'payoutItemId'
    | 'senderBatchId'
    | 'authorizedCents'
    | 'capturedCents'
    | 'workerPayCents'
    | 'platformFeeCents'
    | 'lastError'
    | 'captureAttempt'
    | 'payoutAttempt'
    | 'payoutStatus'
    | 'paypalCaptureFeeCents'
    | 'paypalPayoutFeeCents'
    | 'authorizationExpiresAt'
  >
>;

export async function moveSlot(
  tx: Tx,
  slotId: string,
  to: SlotState,
  ctx: MoveCtx,
  patch: Partial<
    Pick<
      SlotRow,
      | 'workerId'
      | 'offeredRateCents'
      | 'fillBy'
      | 'searchRadiusMi'
      | 'cancelledAt'
      | 'cancelledBy'
      | 'gapReason'
      | 'checkInAt'
      | 'checkOutAt'
      | 'checkInBy'
      | 'checkOutBy'
      | 'actualHours'
      | 'approvedHours'
      | 'approvedAt'
      | 'approvedBy'
    >
  > = {},
): Promise<SlotRow> {
  const [cur] = await tx.select().from(shiftSlots).where(eq(shiftSlots.id, slotId)).for('update');
  if (!cur) throw new ServiceError('not_found', 'slot not found');
  const r = slotMachine.transition(cur.status, to, {
    entityId: slotId,
    actor: ctx.actor,
    meta: ctx.meta,
  });
  const [row] = await tx
    .update(shiftSlots)
    .set({ ...patch, status: to, version: sql`${shiftSlots.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(shiftSlots.id, slotId), eq(shiftSlots.version, cur.version)))
    .returning();
  if (!row) throw new ServiceError('invalid_state', 'slot changed concurrently');
  await writeAudit(tx, r.audit);
  return row;
}

export async function moveOffer(
  tx: Tx,
  offerId: string,
  to: OfferState,
  ctx: MoveCtx,
  patch: Partial<Pick<OfferRow, 'openedAt' | 'claimedAt'>> = {},
): Promise<OfferRow> {
  const [cur] = await tx.select().from(offers).where(eq(offers.id, offerId)).for('update');
  if (!cur) throw new ServiceError('not_found', 'offer not found');
  const r = offerMachine.transition(cur.status, to, {
    entityId: offerId,
    actor: ctx.actor,
    meta: ctx.meta,
  });
  const outcomeAt =
    to === 'DECLINED'
      ? { declinedAt: sql`now()` }
      : to === 'EXPIRED'
        ? { expiredAt: sql`now()` }
        : to === 'WITHDRAWN'
          ? { withdrawnAt: sql`now()` }
          : {};
  const [row] = await tx
    .update(offers)
    .set({ ...patch, ...outcomeAt, status: to })
    .where(eq(offers.id, offerId))
    .returning();
  await writeAudit(tx, r.audit);
  return row!;
}

export async function movePayment(
  tx: Tx,
  paymentId: string,
  to: PaymentState,
  ctx: MoveCtx,
  patch: PaymentPatch = {},
): Promise<PaymentRow> {
  const [cur] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
  if (!cur) throw new ServiceError('not_found', 'payment not found');
  const r = paymentMachine.transition(cur.status, to, {
    entityId: paymentId,
    actor: ctx.actor,
    meta: ctx.meta,
  });
  const [row] = await tx
    .update(payments)
    .set({ ...patch, status: to, updatedAt: sql`now()` })
    .where(eq(payments.id, paymentId))
    .returning();
  await writeAudit(tx, r.audit);
  return row!;
}

/**
 * Like movePayment, but a transition the machine does not allow from the CURRENT state returns null instead of
 * throwing. Webhooks and reconciliation use it: a duplicate or out-of-order event must never regress a state,
 * and being late for a payment that has already moved on is not an error.
 */
export async function tryMovePayment(
  tx: Tx,
  paymentId: string,
  to: PaymentState,
  ctx: MoveCtx,
  patch: PaymentPatch = {},
): Promise<PaymentRow | null> {
  const [cur] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
  if (!cur || !paymentMachine.canTransition(cur.status, to)) return null;
  return movePayment(tx, paymentId, to, ctx, patch);
}

/** Field-only update (references, attempt counters, last error) with an audit row; the status is untouched. */
export async function patchPayment(
  tx: Tx,
  paymentId: string,
  ctx: MoveCtx & { action: string },
  patch: PaymentPatch,
): Promise<PaymentRow> {
  const [cur] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
  if (!cur) throw new ServiceError('not_found', 'payment not found');
  const [row] = await tx
    .update(payments)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(payments.id, paymentId))
    .returning();
  await writeAudit(tx, {
    actor: ctx.actor,
    action: ctx.action,
    entity: 'payment',
    entityId: paymentId,
    before: { status: cur.status },
    after: { status: cur.status, ...ctx.meta },
  });
  return row!;
}
