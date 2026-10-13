import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { ledgerEntries, paypalEvents, payments, shiftSlots } from '../src/db/schema';
import { createGap } from '../src/services/gaps';
import { approveAndPay, authorizePayment, ensureOrder } from '../src/services/payments';
import { latestPayment } from '../src/services/payment-queries';
import { processPaypalEvent, reenqueueStaleEvents } from '../src/services/paypal-events';
import { arrive, finish } from '../src/services/shift-day';
import { createTestDb, hasTestDb } from './db';
import { FakeGateway } from './fake-gateway';
import { makeOrg, makeWorker, testDeps } from './factories';

const startAt = new Date('2026-10-14T14:00:00Z');
const endAt = new Date('2026-10-14T22:00:00Z');

describe.skipIf(!hasTestDb)('PayPal webhook events (live Postgres, fake PayPal)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;

  async function worked(now = new Date('2026-10-14T22:05:00Z')) {
    const o = await makeOrg(db());
    const worker = await makeWorker(db(), o.org.id, { name: 'Jordan' });
    const gw = new FakeGateway();
    const { deps, jobs } = testDeps(db(), { now: () => now });
    deps.payments = gw;
    const ctx = { orgId: o.org.id, userId: o.manager.id };
    const r = await createGap(deps, ctx, {
      venueId: o.venue.id,
      role: 'line_cook',
      startAt,
      endAt,
      baseRateCents: 2200,
      maxPremiumPct: 20,
    });
    const slotId = r.slot.id;
    const { orderId } = await ensureOrder(deps, ctx, slotId);
    await authorizePayment(deps, ctx, slotId, orderId);
    await db()
      .update(shiftSlots)
      .set({ status: 'CONFIRMED', workerId: worker.id, offeredRateCents: 2420 })
      .where(eq(shiftSlots.id, slotId));
    await arrive({ ...deps, now: () => startAt }, worker.id, slotId);
    await finish({ ...deps, now: () => endAt }, worker.id, slotId);
    return { o, worker, gw, deps, jobs, ctx, slotId };
  }

  const addEvent = async (
    eventType: string,
    resource: unknown,
    extra: Partial<typeof paypalEvents.$inferInsert> = {},
  ) => {
    const eventId = `WH-${randomUUID()}`;
    await db()
      .insert(paypalEvents)
      .values({
        eventId,
        eventType,
        rawJson: { id: eventId, event_type: eventType, resource },
        verified: true,
        ...extra,
      });
    return eventId;
  };
  const ledgerOf = async (paymentId: string) =>
    (await db().select().from(ledgerEntries).where(eq(ledgerEntries.paymentId, paymentId))).map(
      (l) => l.type,
    );
  const processed = async (eventId: string) =>
    (await db().select().from(paypalEvents).where(eq(paypalEvents.eventId, eventId)))[0]!
      .processedAt;

  /** A capture PayPal accepted but reported PENDING: the payment waits at AUTHORIZED with a capture id. */
  async function pendingCapture() {
    const w = await worked();
    w.gw.nextCaptureStatus = 'PENDING';
    await approveAndPay(w.deps, w.ctx, w.slotId, 8);
    const pay = (await latestPayment(db(), w.slotId))!;
    return { ...w, pay };
  }

  it('the same webhook delivered 5 times (even at once) changes state once (acceptance 2)', async () => {
    const w = await pendingCapture();
    const eventId = await addEvent('PAYMENT.CAPTURE.COMPLETED', {
      id: w.pay.captureId,
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '203.28' },
      invoice_id: `${w.slotId}-1`,
      seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: '6.20' } },
    });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => processPaypalEvent(w.deps, eventId)),
    );
    expect(results).toContain('processed');
    expect(await processPaypalEvent(w.deps, eventId)).toBe('duplicate');
    const pay = (await latestPayment(db(), w.slotId))!;
    expect(pay.status).toBe('CAPTURED');
    expect(pay.capturedCents).toBe(20328);
    const ledger = await ledgerOf(pay.id);
    expect(ledger.filter((x) => x === 'CAPTURED')).toHaveLength(1);
    expect(ledger.filter((x) => x === 'PLATFORM_FEE')).toHaveLength(1);
    expect(await processed(eventId)).not.toBeNull();
    // and the same event stored twice is refused by the unique event id
    await expect(
      db().insert(paypalEvents).values({ eventId, eventType: 'X', rawJson: {} }),
    ).rejects.toBeTruthy();
  });

  it('late or out-of-order events never regress a finished payment', async () => {
    const w = await worked();
    await approveAndPay(w.deps, w.ctx, w.slotId, 8);
    const pay = (await latestPayment(db(), w.slotId))!;
    expect(pay.status).toBe('PAID');
    const before = await ledgerOf(pay.id);
    const late = [
      ['PAYMENT.AUTHORIZATION.CREATED', { id: pay.authorizationId, invoice_id: `${w.slotId}-1` }],
      ['PAYMENT.CAPTURE.PENDING', { id: pay.captureId }],
      [
        'PAYMENT.CAPTURE.COMPLETED',
        { id: pay.captureId, amount: { currency_code: 'USD', value: '203.28' } },
      ],
      ['PAYMENT.CAPTURE.DECLINED', { id: pay.captureId }],
      ['PAYMENT.AUTHORIZATION.VOIDED', { id: pay.authorizationId }],
      [
        'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
        { payout_batch_id: pay.payoutBatchId, transaction_status: 'UNCLAIMED' },
      ],
      [
        'PAYMENT.PAYOUTS-ITEM.FAILED',
        { payout_batch_id: pay.payoutBatchId, transaction_status: 'FAILED' },
      ],
      ['PAYMENT.PAYOUTSBATCH.PROCESSING', { batch_header: { payout_batch_id: pay.payoutBatchId } }],
    ] as const;
    for (const [type, resource] of late) {
      const id = await addEvent(type, resource);
      expect(await processPaypalEvent(w.deps, id)).toBe('processed');
    }
    const after = (await latestPayment(db(), w.slotId))!;
    expect(after.status).toBe('PAID');
    expect(await ledgerOf(pay.id)).toEqual(before);
    expect(
      (await db().select().from(shiftSlots).where(eq(shiftSlots.id, w.slotId)))[0]!.status,
    ).toBe('SETTLED');
  });

  it('events arriving in the wrong order land in the right state (payout success before the capture event)', async () => {
    const w = await pendingCapture();
    const { pay } = w;
    w.deps.now = () => new Date(); // the event was just received: not yet old enough to give up on
    const early = await addEvent('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', {
      payout_batch_id: 'PB-not-yet',
      transaction_status: 'SUCCESS',
    });
    expect(await processPaypalEvent(w.deps, early)).toBe('deferred'); // no such batch yet: left for reconcile
    expect(await processed(early)).toBeNull();
    const cap = await addEvent('PAYMENT.CAPTURE.COMPLETED', {
      id: pay.captureId,
      amount: { currency_code: 'USD', value: '203.28' },
    });
    await processPaypalEvent(w.deps, cap);
    expect((await latestPayment(db(), w.slotId))!.status).toBe('CAPTURED');
  });

  it('declined capture and payout events move the machine; refunds only add ledger rows', async () => {
    const w = await pendingCapture();
    const dec = await addEvent('PAYMENT.CAPTURE.DECLINED', { id: w.pay.captureId });
    await processPaypalEvent(w.deps, dec);
    expect((await latestPayment(db(), w.slotId))!.status).toBe('CAPTURE_DECLINED');

    const w2 = await worked();
    await approveAndPay(w2.deps, w2.ctx, w2.slotId, 8);
    const paid = (await latestPayment(db(), w2.slotId))!;
    const refund = await addEvent('PAYMENT.CAPTURE.REFUNDED', {
      id: paid.captureId,
      amount: { currency_code: 'USD', value: '203.28' },
    });
    await processPaypalEvent(w2.deps, refund);
    const after = (await latestPayment(db(), w2.slotId))!;
    expect(after.status).toBe('PAID');
    expect(await ledgerOf(paid.id)).toContain('REFUNDED');
    expect(after.lastError).toBe('The charge was refunded.');
  });

  it('payout item and batch events apply the payout result', async () => {
    const w = await worked();
    w.gw.nextPayoutItemStatus = 'PENDING';
    await approveAndPay(w.deps, w.ctx, w.slotId, 8);
    let pay = (await latestPayment(db(), w.slotId))!;
    expect(pay.status).toBe('PAYOUT_PENDING');
    const failed = await addEvent('PAYMENT.PAYOUTS-ITEM.FAILED', {
      payout_batch_id: pay.payoutBatchId,
      payout_item_id: 'IT9',
      transaction_status: 'FAILED',
      errors: { name: 'RECEIVER_UNREGISTERED' },
    });
    await processPaypalEvent(w.deps, failed);
    pay = (await latestPayment(db(), w.slotId))!;
    expect(pay.status).toBe('PAYOUT_FAILED');
    expect(pay.lastError).toBe('The payout failed (RECEIVER_UNREGISTERED).');

    const w2 = await worked();
    w2.gw.nextPayoutItemStatus = 'PENDING';
    await approveAndPay(w2.deps, w2.ctx, w2.slotId, 8);
    const p2 = (await latestPayment(db(), w2.slotId))!;
    w2.gw.setPayoutItem(p2.payoutBatchId!, 'SUCCESS');
    const batch = await addEvent('PAYMENT.PAYOUTSBATCH.SUCCESS', {
      batch_header: { payout_batch_id: p2.payoutBatchId },
    });
    await processPaypalEvent(w2.deps, batch); // batch events carry no item detail: the batch is read
    expect((await latestPayment(db(), w2.slotId))!.status).toBe('PAID');
    expect(
      (await db().select().from(shiftSlots).where(eq(shiftSlots.id, w2.slotId)))[0]!.status,
    ).toBe('SETTLED');
  });

  it('the voided-authorization event releases an AUTHORIZED hold once', async () => {
    const w = await worked();
    const pay = (await latestPayment(db(), w.slotId))!;
    const ev = await addEvent('PAYMENT.AUTHORIZATION.VOIDED', { id: pay.authorizationId });
    await processPaypalEvent(w.deps, ev);
    await processPaypalEvent(w.deps, ev);
    expect((await latestPayment(db(), w.slotId))!.status).toBe('VOIDED');
    expect((await ledgerOf(pay.id)).filter((x) => x === 'VOIDED')).toHaveLength(1);
  });

  it('unknown event types are stored and marked processed without any change', async () => {
    const w = await worked();
    const before = (await db().select().from(payments).where(eq(payments.slotId, w.slotId)))[0]!;
    const id = await addEvent('BILLING.SUBSCRIPTION.CREATED', { id: 'whatever' });
    expect(await processPaypalEvent(w.deps, id)).toBe('processed');
    const after = (await db().select().from(payments).where(eq(payments.slotId, w.slotId)))[0]!;
    expect(after).toEqual(before);
    expect(await processed(id)).not.toBeNull();
    expect(await processPaypalEvent(w.deps, 'WH-missing')).toBe('not_found');
  });

  it('reconcile re-enqueues stored events that were never processed (older than 5 minutes), and gives up on unmatched ones after a day', async () => {
    const w = await worked(new Date());
    const old = new Date(Date.now() - 10 * 60_000);
    const stale = await addEvent(
      'PAYMENT.CAPTURE.COMPLETED',
      { id: 'CAP-unknown' },
      { receivedAt: old },
    );
    const fresh = await addEvent('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-unknown-2' });
    w.jobs.length = 0;
    const n = await reenqueueStaleEvents(w.deps);
    expect(n).toBeGreaterThanOrEqual(1);
    const queued = w.jobs
      .filter((j) => j.name === 'process_webhook')
      .map((j) => (j.data as { eventId: string }).eventId);
    expect(queued).toContain(stale);
    expect(queued).not.toContain(fresh);
    expect(await processPaypalEvent(w.deps, stale)).toBe('deferred');
    const ancient = await addEvent(
      'PAYMENT.CAPTURE.COMPLETED',
      { id: 'CAP-unknown-3' },
      { receivedAt: new Date(Date.now() - 25 * 3600_000) },
    );
    expect(await processPaypalEvent(w.deps, ancient)).toBe('processed');
  });
});
