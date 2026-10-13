import { and, eq, inArray } from 'drizzle-orm';
import { ledgerEntries, payments, shiftSlots, venues, workers } from '../db/schema';
import { MoneyError } from '../domain/errors';
import { computeSettlement, maxRateCents } from '../domain/money';
import type { PaymentState } from '../domain/states';
import {
  classifyAuthorizeError,
  classifyCaptureError,
  classifyPayoutError,
  payoutItemFailure,
  type PaypalOutcome,
} from '../paypal/errors';
import { PaypalError } from '../paypal/client';
import { senderBatchIdFor } from '../paypal/ids';
import { managersForVenue } from './managers';
import { stubSettle } from './payments-stub';
import { latestPayment } from './payment-queries';
import { moveSlot, patchPayment, movePayment, tryMovePayment } from './transitions';
import { ServiceError, type ServiceDeps, type Tx } from './types';
import { workerChannels } from './worker-profile';

/**
 * Real money (PLAN.md 4C/4D/4E, 7). Rules that hold throughout:
 *  - Network calls to PayPal happen OUTSIDE database transactions; every write carries a deterministic
 *    PayPal-Request-Id, so repeating a step after a crash or timeout cannot repeat the money movement.
 *  - State changes go only through the transition functions; ledger rows are appended in the same transaction.
 *  - Amounts are computed here from stored rates and hours. Nothing the client sends is an amount.
 *  - Raw PayPal bodies never leave this layer: errors are classified into fixed messages.
 */

export interface ManagerCtx {
  orgId: string;
  userId: string;
}

const invoiceIdFor = (slotId: string, attempt: number) => `${slotId}-${attempt}`;

const ledger = (
  tx: Tx,
  paymentId: string,
  type: (typeof ledgerEntries.$inferInsert)['type'],
  amountCents: number,
  ref?: string | null,
) => tx.insert(ledgerEntries).values({ paymentId, type, amountCents, ref: ref ?? null });

function failure(o: PaypalOutcome): ServiceError {
  if (o.kind === 'awaiting_approval') return new ServiceError('payment_not_authorized', o.message);
  if (
    o.kind === 'retryable' &&
    !['PAYER_ACTION_REQUIRED', 'INSTRUMENT_DECLINED'].includes(o.code)
  ) {
    return new ServiceError('unavailable', o.message);
  }
  return new ServiceError('payment_failed', o.message);
}

function requireGateway(deps: ServiceDeps) {
  if (!deps.payments) throw new ServiceError('unavailable', 'PayPal is not configured');
  return deps.payments;
}

async function loadOwned(deps: ServiceDeps, orgId: string, slotId: string) {
  const [row] = await deps.db
    .select({ slot: shiftSlots, venue: venues })
    .from(shiftSlots)
    .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
    .where(and(eq(shiftSlots.id, slotId), eq(venues.orgId, orgId)));
  if (!row) throw new ServiceError('not_found', 'gap not found');
  return row;
}

async function notifyManagers(
  deps: ServiceDeps,
  tx: Tx,
  venueId: string,
  kind: string,
  payload: Record<string, unknown>,
) {
  for (const m of await managersForVenue(tx, venueId)) {
    await deps.notifier(tx).send({
      recipient: `manager:${m.id}`,
      channels: ['in_app', 'email'],
      kind,
      payload,
    });
  }
}

// ---------------------------------------------------------------------------------------------- order + authorize
/**
 * Creates (once) the PayPal order for the current payment attempt: intent AUTHORIZE, one purchase unit for the max
 * hold. Safe to call again: it returns the stored order id, and PayPal-Request-Id makes a lost response harmless.
 */
export async function ensureOrder(deps: ServiceDeps, ctx: ManagerCtx, slotId: string) {
  const gw = requireGateway(deps);
  await loadOwned(deps, ctx.orgId, slotId);
  const pay = await latestPayment(deps.db, slotId);
  if (!pay) throw new ServiceError('not_found', 'payment not found');
  if (pay.status !== 'AUTH_PENDING_APPROVAL')
    throw new ServiceError('invalid_state', 'this gap does not need an approval');
  if (pay.paypalOrderId) return { orderId: pay.paypalOrderId };
  let order: { orderId: string };
  try {
    order = await gw.createOrder({ slotId, attempt: pay.attempt, maxCents: pay.authorizedCents });
  } catch (e) {
    throw failure(classifyAuthorizeError(e));
  }
  await deps.db.transaction(async (tx) => {
    const cur = await latestPayment(tx, slotId);
    if (cur?.id === pay.id && !cur.paypalOrderId) {
      await patchPayment(
        tx,
        pay.id,
        { actor: `user:${ctx.userId}`, action: 'payment.order_created' },
        {
          paypalOrderId: order.orderId,
        },
      );
    }
  });
  const after = await latestPayment(deps.db, slotId);
  return { orderId: after?.paypalOrderId ?? order.orderId };
}

/**
 * The browser's onApprove lands here with the order id. The server authorizes the order, checks that PayPal
 * really holds exactly the amount we asked for, then records the authorization. Repeating the call is harmless.
 */
export async function authorizePayment(
  deps: ServiceDeps,
  ctx: ManagerCtx,
  slotId: string,
  orderId: string,
) {
  const gw = requireGateway(deps);
  await loadOwned(deps, ctx.orgId, slotId);
  const pay = await latestPayment(deps.db, slotId);
  if (!pay) throw new ServiceError('not_found', 'payment not found');
  if (!pay.paypalOrderId || pay.paypalOrderId !== orderId)
    throw new ServiceError('invalid_input', 'unknown order for this gap');
  if (pay.status === 'AUTHORIZED') return pay; // idempotent
  if (pay.status !== 'AUTH_PENDING_APPROVAL')
    throw new ServiceError('invalid_state', 'this gap is not waiting for an approval');
  return finishAuthorization(deps, pay, `user:${ctx.userId}`, async () => {
    try {
      return await gw.authorize({ orderId, slotId, attempt: pay.attempt });
    } catch (e) {
      throw failure(classifyAuthorizeError(e));
    }
  });
}

async function finishAuthorization(
  deps: ServiceDeps,
  pay: typeof payments.$inferSelect,
  actor: string,
  authorize: () => Promise<{
    status: string;
    authorizationId?: string;
    authorizationStatus?: string;
    authorizedCents?: number;
    expiresAt?: Date;
  }>,
) {
  const r = await authorize();
  if (!r.authorizationId || r.authorizationStatus !== 'CREATED')
    throw new ServiceError('payment_failed', 'PayPal did not place the hold');
  if (r.authorizedCents !== pay.authorizedCents) {
    // PayPal holds a different amount than we asked for: release it and refuse. We never trust a mismatch.
    try {
      await deps.payments?.void({ authorizationId: r.authorizationId, paymentId: pay.id });
    } catch {
      console.error('[payments] could not void a mismatched authorization; reconcile will retry');
    }
    throw new ServiceError('invalid_input', 'the authorized amount does not match the hold');
  }
  const authId = r.authorizationId;
  return deps.db.transaction(async (tx) => {
    const [cur] = await tx.select().from(payments).where(eq(payments.id, pay.id)).for('update');
    if (cur?.status === 'AUTHORIZED') return cur;
    const row = await movePayment(
      tx,
      pay.id,
      'AUTHORIZED',
      { actor },
      {
        authorizationId: authId,
        authorizationExpiresAt: r.expiresAt ?? null,
        lastError: null,
      },
    );
    await ledger(tx, pay.id, 'AUTHORIZED', row.authorizedCents, authId);
    return row;
  });
}

// ---------------------------------------------------------------------------------------------- release the hold
/**
 * Voids the authorization of a slot that ended UNFILLED or CANCELLED (or a no-show with no time left): the real
 * void endpoint, then state + ledger. A hold that was never approved just closes. If PayPal cannot be reached the
 * payment stays AUTHORIZED and reconciliation retries (it looks for AUTHORIZED payments on finished slots).
 */
export async function releaseHold(deps: ServiceDeps, slotId: string, actor: string) {
  const pay = await latestPayment(deps.db, slotId);
  if (!pay) return { released: false as const };
  if (pay.status === 'AUTH_PENDING_APPROVAL') {
    await deps.db.transaction(async (tx) => {
      await tryMovePayment(tx, pay.id, 'VOIDED', { actor, meta: { reason: 'never_approved' } });
    });
    return { released: true as const };
  }
  if (pay.status !== 'AUTHORIZED') return { released: false as const };
  const live = deps.payments && pay.authorizationId && !pay.authorizationId.startsWith('STUB-');
  if (live) {
    try {
      await deps.payments!.void({ authorizationId: pay.authorizationId!, paymentId: pay.id });
    } catch (e) {
      // Already voided/expired at PayPal is the state we want. Anything else: leave it for the next attempt.
      const gone =
        e instanceof PaypalError &&
        (e.status === 404 || /VOIDED|EXPIRED|ALREADY/.test(e.code ?? ''));
      if (!gone) {
        console.error('[payments] void failed; reconcile will retry');
        return { released: false as const };
      }
    }
  }
  await deps.db.transaction(async (tx) => {
    const row = await tryMovePayment(tx, pay.id, 'VOIDED', { actor, meta: { stub: !live } });
    if (row) await ledger(tx, pay.id, 'VOIDED', row.authorizedCents, row.authorizationId);
  });
  return { released: true as const };
}

// ---------------------------------------------------------------------------------------------- settlement (4D)
export interface SettleResult {
  slotStatus: string;
  paymentStatus: PaymentState;
  captureCents: number;
  workerPayCents: number;
  platformFeeCents: number;
}

/**
 * Approve and pay: hours the manager approved -> worker pay (rate x hours, never above the hold) + fee ->
 * capture (final_capture) -> payout to the worker. Resumable: calling it again continues from the stored state.
 */
export async function approveAndPay(
  deps: ServiceDeps,
  ctx: ManagerCtx,
  slotId: string,
  approvedHours: number,
): Promise<SettleResult> {
  const actor = `user:${ctx.userId}`;
  const { venue } = await loadOwned(deps, ctx.orgId, slotId);
  if (!(approvedHours > 0) || Math.round(approvedHours * 100) / 100 !== approvedHours)
    throw new ServiceError(
      'invalid_input',
      'approved hours must be a positive number with at most 2 decimals',
    );
  const minutes = Math.round(approvedHours * 60);
  // Hours whose pay + fee exceed the hold are rejected below by computeSettlement, before any PayPal call.

  // 1. validate, compute and record the settlement; slot PENDING_APPROVAL -> SETTLING.
  await deps.db.transaction(async (tx) => {
    const [s] = await tx.select().from(shiftSlots).where(eq(shiftSlots.id, slotId)).for('update');
    const pay = await latestPayment(tx, slotId);
    if (!s || !pay) throw new ServiceError('not_found', 'shift not found');
    if (s.status === 'PENDING_APPROVAL') {
      if (!['AUTHORIZED', 'CAPTURE_DECLINED'].includes(pay.status))
        throw new ServiceError('invalid_state', 'there is no hold to charge');
      if (s.offeredRateCents === null)
        throw new ServiceError('invalid_state', 'the shift has no agreed rate');
      let settlement;
      try {
        settlement = computeSettlement({
          rateCents: s.offeredRateCents,
          maxRateCents: maxRateCents(s.baseRateCents, s.maxPremiumPct),
          actualMinutes: minutes,
          feeBps: deps.config.platformFeeBps,
          fixedFeeCents: deps.config.platformFixedFeeCents,
          authorizedCents: pay.authorizedCents,
        });
      } catch (e) {
        if (e instanceof MoneyError) throw new ServiceError('invalid_input', e.message);
        throw e;
      }
      await patchPayment(
        tx,
        pay.id,
        { actor, action: 'payment.settlement_computed', meta: { approvedHours } },
        {
          workerPayCents: settlement.workerPayCents,
          platformFeeCents: settlement.platformFeeCents,
          lastError: null,
        },
      );
      await moveSlot(
        tx,
        slotId,
        'SETTLING',
        { actor, meta: { approvedHours } },
        {
          approvedHours: approvedHours.toFixed(2),
          approvedAt: deps.now(),
          approvedBy: actor,
        },
      );
    } else if (s.status === 'SETTLING') {
      if (s.approvedHours === null || Number(s.approvedHours) !== approvedHours)
        throw new ServiceError('invalid_state', 'this shift was approved for different hours');
    } else {
      throw new ServiceError('invalid_state', 'this shift is not waiting for approval');
    }
  });

  return continueSettlement(deps, slotId, actor, venue.id);
}

/** Capture, then payout, from whatever state the payment is in. Also what reconciliation calls to resume. */
export async function continueSettlement(
  deps: ServiceDeps,
  slotId: string,
  actor: string,
  venueId?: string,
): Promise<SettleResult> {
  if (!deps.payments && deps.config.paymentsMode === 'stub') {
    // Local run without PayPal: settle in state and ledger only (see stubSettle).
    const done = await stubSettle(deps.db, 'stub', slotId, actor);
    const [s2] = await deps.db
      .select({ status: shiftSlots.status })
      .from(shiftSlots)
      .where(eq(shiftSlots.id, slotId));
    return {
      slotStatus: s2!.status,
      paymentStatus: done.status,
      captureCents: done.capturedCents,
      workerPayCents: done.workerPayCents,
      platformFeeCents: done.platformFeeCents,
    };
  }
  const gw = requireGateway(deps);
  let pay = (await latestPayment(deps.db, slotId))!;
  const [slot] = await deps.db.select().from(shiftSlots).where(eq(shiftSlots.id, slotId));
  const vId = venueId ?? slot!.venueId;

  // capture
  if (pay.status === 'AUTHORIZED' || pay.status === 'CAPTURE_DECLINED') {
    const retryAfterDecline = pay.status === 'CAPTURE_DECLINED';
    const attempt = retryAfterDecline ? pay.captureAttempt + 1 : pay.captureAttempt;
    if (retryAfterDecline) {
      await deps.db.transaction(async (tx) => {
        await patchPayment(
          tx,
          pay.id,
          { actor, action: 'payment.capture_retry' },
          { captureAttempt: attempt },
        );
      });
    }
    if (!pay.authorizationId)
      throw new ServiceError('invalid_state', 'no authorization to capture');
    const captureCents = pay.workerPayCents + pay.platformFeeCents;
    try {
      const c = await gw.capture({
        authorizationId: pay.authorizationId,
        paymentId: pay.id,
        captureAttempt: attempt,
        captureCents,
        invoiceId: invoiceIdFor(slotId, pay.attempt),
      });
      await deps.db.transaction(async (tx) => {
        if (c.status === 'COMPLETED') {
          const row = await tryMovePayment(
            tx,
            pay.id,
            'CAPTURED',
            { actor },
            {
              captureId: c.captureId,
              capturedCents: c.capturedCents,
              paypalCaptureFeeCents: c.paypalFeeCents,
              lastError: null,
            },
          );
          if (row) await recordCapture(tx, row, c.captureId, c.paypalFeeCents);
        } else if (c.status === 'PENDING') {
          await patchPayment(
            tx,
            pay.id,
            { actor, action: 'payment.capture_pending' },
            {
              captureId: c.captureId,
              lastError: 'capture_pending',
            },
          );
        } else {
          const row = await tryMovePayment(
            tx,
            pay.id,
            'CAPTURE_DECLINED',
            { actor },
            {
              lastError: 'PayPal declined the charge.',
            },
          );
          if (row) {
            await ledger(tx, pay.id, 'CAPTURE_DECLINED', captureCents, c.captureId);
            await notifyManagers(deps, tx, vId, 'payment_attention', {
              slotId,
              reason: 'capture_declined',
            });
          }
        }
      });
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      const o = classifyCaptureError(e);
      if (o.kind === 'declined') {
        await deps.db.transaction(async (tx) => {
          const row = await tryMovePayment(
            tx,
            pay.id,
            'CAPTURE_DECLINED',
            { actor },
            { lastError: o.message },
          );
          if (row) {
            await ledger(tx, pay.id, 'CAPTURE_DECLINED', captureCents, null);
            await notifyManagers(deps, tx, vId, 'payment_attention', {
              slotId,
              reason: 'capture_declined',
            });
          }
        });
      } else if (o.kind === 'authorization_gone') {
        await deps.db.transaction(async (tx) => {
          await patchPayment(
            tx,
            pay.id,
            { actor, action: 'payment.authorization_gone' },
            { lastError: o.message },
          );
          await notifyManagers(deps, tx, vId, 'payment_attention', {
            slotId,
            reason: 'authorization_gone',
          });
        });
      } else {
        throw failure(o);
      }
    }
    pay = (await latestPayment(deps.db, slotId))!;
  }

  // payout
  if (
    pay.status === 'CAPTURED' ||
    pay.status === 'PAYOUT_FAILED' ||
    (pay.status === 'PAYOUT_PENDING' && !pay.payoutBatchId)
  ) {
    pay = await startPayout(deps, gw, pay, slotId, actor, vId);
  }
  if (pay.status === 'PAYOUT_PENDING' || pay.status === 'PAYOUT_UNCLAIMED') {
    await syncPayout(deps, pay.id, actor);
    pay = (await latestPayment(deps.db, slotId))!;
  }
  const [s2] = await deps.db
    .select({ status: shiftSlots.status })
    .from(shiftSlots)
    .where(eq(shiftSlots.id, slotId));
  return {
    slotStatus: s2!.status,
    paymentStatus: pay.status,
    captureCents: pay.capturedCents || pay.workerPayCents + pay.platformFeeCents,
    workerPayCents: pay.workerPayCents,
    platformFeeCents: pay.platformFeeCents,
  };
}

async function recordCapture(
  tx: Tx,
  p: typeof payments.$inferSelect,
  captureId: string,
  paypalFee: number,
) {
  await ledger(tx, p.id, 'CAPTURED', p.capturedCents, captureId);
  if (p.platformFeeCents > 0) await ledger(tx, p.id, 'PLATFORM_FEE', p.platformFeeCents, captureId);
  if (paypalFee > 0) await ledger(tx, p.id, 'PAYPAL_CAPTURE_FEE', paypalFee, captureId);
}

async function startPayout(
  deps: ServiceDeps,
  gw: NonNullable<ServiceDeps['payments']>,
  pay: typeof payments.$inferSelect,
  slotId: string,
  actor: string,
  venueId: string,
) {
  const [slot] = await deps.db.select().from(shiftSlots).where(eq(shiftSlots.id, slotId));
  const [w] = slot?.workerId
    ? await deps.db.select().from(workers).where(eq(workers.id, slot.workerId))
    : [];
  // PAYOUT_FAILED -> PAYOUT_PENDING is the retry: a failed batch used its sender_batch_id, so the retry gets a new one.
  const retry = pay.status === 'PAYOUT_FAILED';
  const attempt = retry ? pay.payoutAttempt + 1 : pay.payoutAttempt;
  if (pay.status === 'CAPTURED' || retry) {
    pay = await deps.db.transaction((tx) =>
      movePayment(
        tx,
        pay.id,
        'PAYOUT_PENDING',
        { actor },
        {
          payoutAttempt: attempt,
          senderBatchId: senderBatchIdFor(pay.id, attempt),
          lastError: null,
          payoutStatus: null,
        },
      ),
    );
  }
  const fail = async (message: string) => {
    await deps.db.transaction(async (tx) => {
      const row = await tryMovePayment(
        tx,
        pay.id,
        'PAYOUT_FAILED',
        { actor },
        { lastError: message },
      );
      if (row) {
        await ledger(tx, pay.id, 'PAYOUT_FAILED', pay.workerPayCents, null);
        await notifyManagers(deps, tx, venueId, 'payment_attention', {
          slotId,
          reason: 'payout_failed',
        });
      }
    });
    return (await latestPayment(deps.db, slotId))!;
  };
  if (!w?.paypalEmail) return fail('The worker has no PayPal email on file.');
  try {
    const r = await gw.createPayout({
      paymentId: pay.id,
      slotId,
      payoutAttempt: pay.payoutAttempt,
      receiverEmail: w.paypalEmail,
      amountCents: pay.workerPayCents,
      note: 'ShiftCover Pay shift payment',
    });
    await deps.db.transaction(async (tx) => {
      await patchPayment(
        tx,
        pay.id,
        { actor, action: 'payment.payout_created' },
        { payoutBatchId: r.batchId, payoutStatus: r.batchStatus },
      );
      await ledger(tx, pay.id, 'PAYOUT_SENT', pay.workerPayCents, r.batchId);
    });
  } catch (e) {
    const o = classifyPayoutError(e);
    if (o.kind === 'payout_failed') return fail(o.message);
    if (e instanceof Error && e.name === 'SelfPayError')
      return fail('The worker account is the platform account.');
    throw failure(o); // retryable: stays PAYOUT_PENDING with no batch id; the same call/reconcile repeats it safely
  }
  return (await latestPayment(deps.db, slotId))!;
}

// ---------------------------------------------------------------------------------------------- payout status sync
type ItemStatus = string;

/** Reads the batch from PayPal and applies the item status. Used after creation, by webhooks and by reconcile. */
export async function syncPayout(deps: ServiceDeps, paymentId: string, actor: string) {
  const gw = requireGateway(deps);
  const [pay] = await deps.db.select().from(payments).where(eq(payments.id, paymentId));
  if (!pay?.payoutBatchId) return;
  let batch;
  try {
    batch = await gw.getPayoutBatch(pay.payoutBatchId);
  } catch {
    return; // not reachable now: the next reconcile run tries again
  }
  const item = batch.items[0];
  if (!item) {
    if (batch.batchStatus === 'DENIED')
      await applyPayoutItem(deps, paymentId, 'FAILED', actor, 'DENIED', 0);
    return;
  }
  await applyPayoutItem(
    deps,
    paymentId,
    item.status,
    actor,
    item.errorName,
    item.feeCents,
    item.itemId,
  );
}

/** One place that turns a payout item status into a payment transition (never regresses: machine-guarded). */
export async function applyPayoutItem(
  deps: ServiceDeps,
  paymentId: string,
  status: ItemStatus,
  actor: string,
  errorName?: string,
  feeCents = 0,
  itemId?: string,
) {
  await deps.db.transaction(async (tx) => {
    const [pay] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
    if (!pay) return;
    const [slot] = await tx.select().from(shiftSlots).where(eq(shiftSlots.id, pay.slotId));
    const base = { payoutStatus: status, ...(itemId ? { payoutItemId: itemId } : {}) };
    switch (status) {
      case 'SUCCESS': {
        const row = await tryMovePayment(
          tx,
          paymentId,
          'PAID',
          { actor },
          {
            ...base,
            paypalPayoutFeeCents: feeCents,
            lastError: null,
          },
        );
        if (row) {
          await ledger(tx, paymentId, 'PAID', row.workerPayCents, row.payoutBatchId);
          if (feeCents > 0)
            await ledger(tx, paymentId, 'PAYPAL_PAYOUT_FEE', feeCents, row.payoutBatchId);
          if (slot?.status === 'SETTLING') await moveSlot(tx, slot.id, 'SETTLED', { actor });
          if (slot?.workerId)
            await deps.notifier(tx).send({
              recipient: `worker:${slot.workerId}`,
              channels: await workerChannels(tx, slot.workerId, 'worker_paid'),
              kind: 'worker_paid',
              payload: {
                slotId: slot.id,
                payoutCents: row.workerPayCents,
                reference: row.payoutBatchId,
              },
            });
        }
        return;
      }
      case 'UNCLAIMED': {
        const row = await tryMovePayment(
          tx,
          paymentId,
          'PAYOUT_UNCLAIMED',
          { actor },
          {
            ...base,
            lastError: payoutItemFailure(status, errorName),
          },
        );
        if (row)
          await ledger(tx, paymentId, 'PAYOUT_UNCLAIMED', row.workerPayCents, row.payoutBatchId);
        return;
      }
      case 'RETURNED': {
        // PAYOUT_PENDING -> PAYOUT_UNCLAIMED -> RETURNED keeps every step legal in the machine.
        await tryMovePayment(tx, paymentId, 'PAYOUT_UNCLAIMED', { actor }, base);
        const row = await tryMovePayment(
          tx,
          paymentId,
          'RETURNED',
          { actor },
          {
            ...base,
            lastError: payoutItemFailure(status, errorName),
          },
        );
        if (row) {
          await ledger(tx, paymentId, 'RETURNED', row.workerPayCents, row.payoutBatchId);
          if (slot)
            await notifyManagers(deps, tx, slot.venueId, 'payment_attention', {
              slotId: slot.id,
              reason: 'payout_returned',
            });
        }
        return;
      }
      case 'FAILED':
      case 'BLOCKED': {
        const row = await tryMovePayment(
          tx,
          paymentId,
          'PAYOUT_FAILED',
          { actor },
          {
            ...base,
            lastError: payoutItemFailure(status, errorName),
          },
        );
        if (row) {
          await ledger(tx, paymentId, 'PAYOUT_FAILED', row.workerPayCents, row.payoutBatchId);
          if (slot)
            await notifyManagers(deps, tx, slot.venueId, 'payment_attention', {
              slotId: slot.id,
              reason: 'payout_failed',
            });
        }
        return;
      }
      case 'ONHOLD':
        await patchPayment(
          tx,
          paymentId,
          { actor, action: 'payment.payout_on_hold' },
          {
            ...base,
            lastError: payoutItemFailure(status, errorName),
          },
        );
        return;
      case 'REFUNDED':
      case 'REVERSED':
        await ledger(tx, paymentId, status, pay.workerPayCents, pay.payoutBatchId);
        await patchPayment(
          tx,
          paymentId,
          { actor, action: `payment.payout_${status.toLowerCase()}` },
          {
            ...base,
            lastError: payoutItemFailure(status, errorName),
          },
        );
        return;
      default: // PENDING and anything unknown: record it, change no state
        if (pay.payoutStatus !== status)
          await patchPayment(tx, paymentId, { actor, action: 'payment.payout_status' }, base);
    }
  });
}

// ---------------------------------------------------------------------------------------------- reconciliation
/**
 * Safety net (PLAN.md 7.7): advances every non-terminal payment from PayPal's own records, so the system converges
 * even if no webhook ever arrives. Idempotent; each payment is handled independently.
 */
export async function reconcilePayments(deps: ServiceDeps, opts: { slotIds?: string[] } = {}) {
  const actor = 'system:reconcile';
  const gw = deps.payments;
  const open = await deps.db
    .select()
    .from(payments)
    .where(
      and(
        opts.slotIds ? inArray(payments.slotId, opts.slotIds) : undefined, // tests narrow it; the job never does
        inArray(payments.status, [
          'AUTH_PENDING_APPROVAL',
          'AUTHORIZED',
          'CAPTURE_DECLINED',
          'CAPTURED',
          'PAYOUT_PENDING',
          'PAYOUT_FAILED',
          'PAYOUT_UNCLAIMED',
        ]),
      ),
    );
  let advanced = 0;
  for (const p of open) {
    try {
      if (await reconcileOne(deps, gw, p, actor)) advanced++;
    } catch {
      console.error('[reconcile] one payment failed; continuing');
    }
  }
  return { checked: open.length, advanced };
}

async function reconcileOne(
  deps: ServiceDeps,
  gw: ServiceDeps['payments'],
  p: typeof payments.$inferSelect,
  actor: string,
): Promise<boolean> {
  const [slot] = await deps.db.select().from(shiftSlots).where(eq(shiftSlots.id, p.slotId));
  if (!slot) return false;
  const before = p.status;
  const changed = async () => (await latestPayment(deps.db, p.slotId))?.status !== before;

  if (p.status === 'AUTH_PENDING_APPROVAL') {
    if (!gw || !p.paypalOrderId) return false;
    if (['CANCELLED', 'UNFILLED'].includes(slot.status)) {
      await releaseHold(deps, p.slotId, actor);
      return changed();
    }
    // The buyer approved in PayPal but the browser never reached /authorize: finish it here.
    const o = await gw.getOrder(p.paypalOrderId);
    if (o.status === 'APPROVED' || (o.status === 'COMPLETED' && o.authorizationId)) {
      await finishAuthorization(deps, p, actor, async () =>
        o.status === 'COMPLETED' && o.authorizationId
          ? {
              status: o.status,
              authorizationId: o.authorizationId,
              authorizationStatus: o.authorizationStatus,
              authorizedCents: o.authorizedCents,
            }
          : gw.authorize({ orderId: p.paypalOrderId!, slotId: p.slotId, attempt: p.attempt }),
      ).catch(() => undefined);
    }
    return changed();
  }

  if (p.status === 'AUTHORIZED') {
    if (['CANCELLED', 'UNFILLED', 'NO_SHOW'].includes(slot.status)) {
      await releaseHold(deps, p.slotId, actor);
      return changed();
    }
    if (slot.status === 'SETTLING') {
      if (p.captureId && p.lastError === 'capture_pending' && gw) {
        const c = await gw.getCapture(p.captureId);
        if (c.status === 'COMPLETED') {
          await completeCapture(deps, p, c.amountCents, c.paypalFeeCents, p.captureId, actor);
          await continueSettlement(deps, p.slotId, actor).catch(() => undefined); // straight on to the payout
        } else if (c.status === 'DECLINED' || c.status === 'FAILED')
          await declineCapture(deps, p, actor);
        return changed();
      }
      if (gw) await continueSettlement(deps, p.slotId, actor).catch(() => undefined); // approved but never captured
      return changed();
    }
    if (gw && p.authorizationId && !p.authorizationId.startsWith('STUB-')) {
      const a = await gw.getAuthorization(p.authorizationId);
      if (a.status === 'VOIDED') {
        await deps.db.transaction(async (tx) => {
          const row = await tryMovePayment(
            tx,
            p.id,
            'VOIDED',
            { actor },
            { lastError: 'The hold was released at PayPal.' },
          );
          if (row) await ledger(tx, p.id, 'VOIDED', row.authorizedCents, row.authorizationId);
        });
      }
    }
    return changed();
  }

  if (p.status === 'CAPTURED') {
    if (gw && slot.status === 'SETTLING')
      await continueSettlement(deps, p.slotId, actor).catch(() => undefined);
    return changed();
  }
  if (p.status === 'PAYOUT_PENDING' || p.status === 'PAYOUT_UNCLAIMED') {
    if (!gw) return false;
    if (!p.payoutBatchId) await continueSettlement(deps, p.slotId, actor).catch(() => undefined);
    else await syncPayout(deps, p.id, actor);
    return changed();
  }
  return false; // CAPTURE_DECLINED and PAYOUT_FAILED wait for the manager (retry)
}

async function completeCapture(
  deps: ServiceDeps,
  p: typeof payments.$inferSelect,
  amountCents: number | undefined,
  paypalFeeCents: number,
  captureId: string,
  actor: string,
) {
  await deps.db.transaction(async (tx) => {
    const row = await tryMovePayment(
      tx,
      p.id,
      'CAPTURED',
      { actor },
      {
        captureId,
        capturedCents: amountCents ?? p.workerPayCents + p.platformFeeCents,
        paypalCaptureFeeCents: paypalFeeCents,
        lastError: null,
      },
    );
    if (row) await recordCapture(tx, row, captureId, paypalFeeCents);
  });
}

async function declineCapture(deps: ServiceDeps, p: typeof payments.$inferSelect, actor: string) {
  await deps.db.transaction(async (tx) => {
    const row = await tryMovePayment(
      tx,
      p.id,
      'CAPTURE_DECLINED',
      { actor },
      { lastError: 'PayPal declined the charge.' },
    );
    if (row)
      await ledger(
        tx,
        p.id,
        'CAPTURE_DECLINED',
        p.workerPayCents + p.platformFeeCents,
        p.captureId,
      );
  });
}

// used by the webhook processor
export { completeCapture, declineCapture };
