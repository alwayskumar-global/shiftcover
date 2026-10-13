import { latestPayment } from './payment-queries';
import { randomUUID } from 'node:crypto';
import { ledgerEntries, shiftSlots } from '../db/schema';
import { eq } from 'drizzle-orm';
import { moveSlot, movePayment } from './transitions';
import type { Db } from '../db/client';
import { ServiceError } from './types';

/**
 * M1 payment stubs (PLAN.md money is real from M2). Server-side helpers only: they refuse to run
 * unless PAYMENTS_MODE=stub, and env.ts rejects that mode in production. Everything else about the
 * payment state machine (transitions, audit, ledger) is real.
 */

export function assertStubMode(mode: string): void {
  if (mode !== 'stub') throw new ServiceError('stub_disabled', 'payment stub is disabled');
}

export async function stubAuthorize(db: Db, mode: string, slotId: string, actor = 'system:stub') {
  assertStubMode(mode);
  return db.transaction(async (tx) => {
    const pay = await latestPayment(tx, slotId);
    if (!pay) throw new ServiceError('not_found', 'payment not found');
    const row = await movePayment(
      tx,
      pay.id,
      'AUTHORIZED',
      { actor, meta: { stub: true } },
      { paypalOrderId: `STUB-ORDER-${randomUUID()}`, authorizationId: `STUB-AUTH-${randomUUID()}` },
    );
    await tx.insert(ledgerEntries).values({
      paymentId: row.id,
      type: 'AUTHORIZED',
      amountCents: row.authorizedCents,
      ref: row.authorizationId,
    });
    return row;
  });
}

/** Void the authorization for an unfilled slot. M1: state + ledger only (no PayPal call). */
export async function stubVoid(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  slotId: string,
  actor: string,
) {
  const pay = await latestPayment(tx, slotId);
  if (!pay || !['AUTHORIZED', 'AUTH_PENDING_APPROVAL'].includes(pay.status)) return null;
  const wasAuthorized = pay.status === 'AUTHORIZED';
  const row = await movePayment(tx, pay.id, 'VOIDED', { actor, meta: { stub: true } });
  if (wasAuthorized) {
    // A hold that was never authorized has no money to release, so no ledger entry.
    await tx.insert(ledgerEntries).values({
      paymentId: row.id,
      type: 'VOIDED',
      amountCents: row.authorizedCents,
      ref: row.authorizationId,
    });
  }
  return row;
}

/**
 * Local-run settlement (PAYMENTS_MODE=stub only): the capture and the payout happen in state and ledger only, with
 * STUB ids and no PayPal call. The same transitions and ledger rows as the real path, so the screens behave the same.
 * The amounts were already computed and stored by approveAndPay (server-side), never taken from a client.
 */
export async function stubSettle(db: Db, mode: string, slotId: string, actor: string) {
  assertStubMode(mode);
  return db.transaction(async (tx) => {
    const pay = await latestPayment(tx, slotId);
    if (!pay) throw new ServiceError('not_found', 'payment not found');
    if (pay.status === 'AUTHORIZED' || pay.status === 'CAPTURE_DECLINED') {
      const total = pay.workerPayCents + pay.platformFeeCents;
      const cap = await movePayment(
        tx,
        pay.id,
        'CAPTURED',
        { actor, meta: { stub: true } },
        {
          captureId: `STUB-CAPTURE-${randomUUID()}`,
          capturedCents: total,
          lastError: null,
        },
      );
      await tx
        .insert(ledgerEntries)
        .values({ paymentId: pay.id, type: 'CAPTURED', amountCents: total, ref: cap.captureId });
      if (pay.platformFeeCents > 0)
        await tx.insert(ledgerEntries).values({
          paymentId: pay.id,
          type: 'PLATFORM_FEE',
          amountCents: pay.platformFeeCents,
          ref: cap.captureId,
        });
    }
    let cur = (await latestPayment(tx, slotId))!;
    if (cur.status === 'CAPTURED') {
      cur = await movePayment(
        tx,
        cur.id,
        'PAYOUT_PENDING',
        { actor, meta: { stub: true } },
        {
          senderBatchId: `sc-${cur.id}`,
          payoutBatchId: `STUB-PAYOUT-${randomUUID()}`,
        },
      );
      await tx.insert(ledgerEntries).values({
        paymentId: cur.id,
        type: 'PAYOUT_SENT',
        amountCents: cur.workerPayCents,
        ref: cur.payoutBatchId,
      });
    }
    if (cur.status === 'PAYOUT_PENDING') {
      cur = await movePayment(
        tx,
        cur.id,
        'PAID',
        { actor, meta: { stub: true } },
        { payoutStatus: 'SUCCESS' },
      );
      await tx.insert(ledgerEntries).values({
        paymentId: cur.id,
        type: 'PAID',
        amountCents: cur.workerPayCents,
        ref: cur.payoutBatchId,
      });
    }
    const [slot] = await tx.select().from(shiftSlots).where(eq(shiftSlots.id, slotId));
    if (slot?.status === 'SETTLING') await moveSlot(tx, slotId, 'SETTLED', { actor });
    return (await latestPayment(tx, slotId))!;
  });
}
