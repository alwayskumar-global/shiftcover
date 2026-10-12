import { latestPayment } from './payment-queries';
import { randomUUID } from 'node:crypto';
import { ledgerEntries } from '../db/schema';
import { movePayment } from './transitions';
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
