import { and, asc, eq, isNull, lt } from 'drizzle-orm';
import { ledgerEntries, paypalEvents, payments } from '../db/schema';
import { parseUsd } from '../domain/money';
import { applyPayoutItem, completeCapture, declineCapture, syncPayout } from './payments';
import { latestPayment } from './payment-queries';
import { patchPayment, tryMovePayment } from './transitions';
import type { DbLike, ServiceDeps } from './types';

/**
 * PayPal webhook events -> payment transitions (PLAN.md 7.6). The receiver already verified the signature and
 * stored the row once (event_id is unique). Processing is idempotent and order-tolerant:
 *  - every state change goes through tryMovePayment, which refuses a transition the machine does not allow from the
 *    CURRENT state, so a duplicate or late event can never regress a payment;
 *  - processed_at is set once the event has been applied;
 *  - unknown event types are stored and marked processed without any change;
 *  - an event for a payment we cannot find yet (it can overtake our own commit) is left unprocessed so the
 *    reconcile job re-enqueues it; after a day it is closed as unmatched.
 */

const ACTOR = 'system:webhook';
const UNMATCHED_GIVE_UP_MS = 24 * 3600_000;

type Resource = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown): Resource => (v && typeof v === 'object' ? (v as Resource) : {});
const cents = (a: unknown): number | undefined => {
  const v = str(obj(a).value);
  if (!v) return undefined;
  try {
    return parseUsd(v);
  } catch {
    return undefined;
  }
};

/** invoice_id = `${slotId}-${attempt}` (set on the order and on the capture). */
async function findPayment(
  h: DbLike,
  by: { authorizationId?: string; captureId?: string; batchId?: string; invoiceId?: string },
) {
  if (by.authorizationId) {
    const [p] = await h
      .select()
      .from(payments)
      .where(eq(payments.authorizationId, by.authorizationId));
    if (p) return p;
  }
  if (by.captureId) {
    const [p] = await h.select().from(payments).where(eq(payments.captureId, by.captureId));
    if (p) return p;
  }
  if (by.batchId) {
    const [p] = await h.select().from(payments).where(eq(payments.payoutBatchId, by.batchId));
    if (p) return p;
  }
  if (by.invoiceId) {
    const i = by.invoiceId.lastIndexOf('-');
    const attempt = Number(by.invoiceId.slice(i + 1));
    if (i > 0 && Number.isInteger(attempt)) {
      const [p] = await h
        .select()
        .from(payments)
        .where(and(eq(payments.slotId, by.invoiceId.slice(0, i)), eq(payments.attempt, attempt)));
      if (p) return p;
    }
  }
  return undefined;
}

export type EventOutcome = 'processed' | 'duplicate' | 'deferred' | 'not_found';

export async function processPaypalEvent(
  deps: ServiceDeps,
  eventId: string,
): Promise<EventOutcome> {
  const [ev] = await deps.db.select().from(paypalEvents).where(eq(paypalEvents.eventId, eventId));
  if (!ev) return 'not_found';
  if (ev.processedAt) return 'duplicate';
  const raw = obj(ev.rawJson);
  const resource = obj(raw.resource);
  const type = ev.eventType;

  const markProcessed = async () => {
    await deps.db
      .update(paypalEvents)
      .set({ processedAt: deps.now() })
      .where(and(eq(paypalEvents.id, ev.id), isNull(paypalEvents.processedAt)));
    return 'processed' as const;
  };
  const unmatched = async (): Promise<EventOutcome> =>
    deps.now().getTime() - ev.receivedAt.getTime() > UNMATCHED_GIVE_UP_MS
      ? markProcessed()
      : 'deferred';

  // ------------------------------------------------------------------ authorizations
  if (type === 'PAYMENT.AUTHORIZATION.CREATED' || type === 'PAYMENT.AUTHORIZATION.VOIDED') {
    const p = await findPayment(deps.db, {
      authorizationId: str(resource.id),
      invoiceId: str(resource.invoice_id),
    });
    if (!p) return unmatched();
    if (type === 'PAYMENT.AUTHORIZATION.VOIDED') {
      await deps.db.transaction(async (tx) => {
        const row = await tryMovePayment(
          tx,
          p.id,
          'VOIDED',
          { actor: ACTOR },
          { lastError: 'The hold was released at PayPal.' },
        );
        if (row)
          await tx.insert(ledgerEntries).values({
            paymentId: p.id,
            type: 'VOIDED',
            amountCents: row.authorizedCents,
            ref: row.authorizationId,
          });
      });
    }
    // CREATED: our authorize call is the source of truth (it verifies the amount); the event changes nothing.
    return markProcessed();
  }

  // ------------------------------------------------------------------ captures
  if (type.startsWith('PAYMENT.CAPTURE.')) {
    const captureId = str(resource.id);
    const p = await findPayment(deps.db, { captureId, invoiceId: str(resource.invoice_id) });
    if (!p) return unmatched();
    const fee = cents(obj(resource.seller_receivable_breakdown).paypal_fee) ?? 0;
    switch (type) {
      case 'PAYMENT.CAPTURE.COMPLETED':
        if (captureId)
          await completeCapture(deps, p, cents(resource.amount), fee, captureId, ACTOR);
        break;
      case 'PAYMENT.CAPTURE.DECLINED':
        await declineCapture(deps, p, ACTOR);
        break;
      case 'PAYMENT.CAPTURE.PENDING':
        await deps.db.transaction(async (tx) => {
          const cur = await latestPayment(tx, p.slotId);
          if (cur?.id === p.id && cur.status === 'AUTHORIZED')
            await patchPayment(
              tx,
              p.id,
              { actor: ACTOR, action: 'payment.capture_pending' },
              { captureId: captureId ?? null, lastError: 'capture_pending' },
            );
        });
        break;
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED': {
        const kind = type.endsWith('REFUNDED') ? 'REFUNDED' : 'REVERSED';
        await deps.db.transaction(async (tx) => {
          await tx.insert(ledgerEntries).values({
            paymentId: p.id,
            type: kind,
            amountCents: cents(resource.amount) ?? p.capturedCents,
            ref: eventId,
          });
          await patchPayment(
            tx,
            p.id,
            { actor: ACTOR, action: `payment.capture_${kind.toLowerCase()}` },
            {
              lastError:
                kind === 'REFUNDED' ? 'The charge was refunded.' : 'The charge was reversed.',
            },
          );
        });
        break;
      }
      default:
        break; // other capture events: stored, nothing to do
    }
    return markProcessed();
  }

  // ------------------------------------------------------------------ payouts
  if (type.startsWith('PAYMENT.PAYOUTSBATCH.')) {
    const batchId =
      str(obj(resource.batch_header).payout_batch_id) ?? str(resource.payout_batch_id);
    const p = await findPayment(deps.db, { batchId });
    if (!p) return unmatched();
    await syncPayout(deps, p.id, ACTOR); // batch events carry no item detail: read the batch
    return markProcessed();
  }
  if (type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
    const p = await findPayment(deps.db, { batchId: str(resource.payout_batch_id) });
    if (!p) return unmatched();
    const byType: Record<string, string> = {
      SUCCEEDED: 'SUCCESS',
      FAILED: 'FAILED',
      HELD: 'ONHOLD',
      BLOCKED: 'BLOCKED',
      UNCLAIMED: 'UNCLAIMED',
      RETURNED: 'RETURNED',
      REFUNDED: 'REFUNDED',
      CANCELED: 'RETURNED',
    };
    const status = str(resource.transaction_status) ?? byType[type.split('.').pop() ?? ''];
    if (status)
      await applyPayoutItem(
        deps,
        p.id,
        status,
        ACTOR,
        str(obj(resource.errors).name),
        cents(resource.payout_item_fee) ?? 0,
        str(resource.payout_item_id),
      );
    return markProcessed();
  }

  // CHECKOUT.ORDER.APPROVED (reconcile finishes an approved-but-unauthorized order) and anything unknown.
  return markProcessed();
}

/** Reconcile (a): events stored but never processed for more than `olderThanMs`. */
export async function reenqueueStaleEvents(deps: ServiceDeps, olderThanMs = 5 * 60_000) {
  const cutoff = new Date(deps.now().getTime() - olderThanMs);
  const stale = await deps.db
    .select({ eventId: paypalEvents.eventId, eventType: paypalEvents.eventType })
    .from(paypalEvents)
    .where(and(isNull(paypalEvents.processedAt), lt(paypalEvents.receivedAt, cutoff)))
    .orderBy(asc(paypalEvents.receivedAt))
    .limit(200);
  for (const e of stale) {
    try {
      // No singleton key: the original job may have been consumed and failed; processing is idempotent.
      await deps.enqueue('process_webhook', { eventId: e.eventId, eventType: e.eventType });
    } catch {
      console.error('[reconcile] could not re-enqueue a stored webhook event');
    }
  }
  return stale.length;
}
