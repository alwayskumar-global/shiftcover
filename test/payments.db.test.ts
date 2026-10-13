import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { ledgerEntries, notifications, offers, payments, shiftSlots } from '../src/db/schema';
import { PaypalError } from '../src/paypal/client';
import { cancelGap, createGap } from '../src/services/gaps';
import { fillDeadline, sendWave } from '../src/services/offers';
import {
  approveAndPay,
  authorizePayment,
  continueSettlement,
  ensureOrder,
  reconcilePayments,
} from '../src/services/payments';
import { latestPayment } from '../src/services/payment-queries';
import { arrive, finish, managerConfirmTimes, markNoShow } from '../src/services/shift-day';
import { startOffering } from '../src/services/gaps';
import { createTestDb, hasTestDb } from './db';
import { FakeGateway, pp } from './fake-gateway';
import { makeOrg, makeWorker, testDeps } from './factories';

// Shift 07:00-15:00 Portland on 2026-10-14 (14:00-22:00Z); "now" is the end of the shift.
const startAt = new Date('2026-10-14T14:00:00Z');
const endAt = new Date('2026-10-14T22:00:00Z');
const END = new Date('2026-10-14T22:05:00Z');

describe.skipIf(!hasTestDb)(
  'M2 money: authorize, settle, void, reconcile (live Postgres, fake PayPal)',
  () => {
    const t = hasTestDb ? createTestDb() : undefined;
    afterAll(() => t?.close());
    const db = () => t!.db;

    async function world(now = END) {
      const o = await makeOrg(db());
      const worker = await makeWorker(db(), o.org.id, { name: 'Jordan', paypalEmail: true });
      const gw = new FakeGateway();
      const { deps, jobs } = testDeps(db(), { now: () => now });
      deps.payments = gw;
      const ctx = { orgId: o.org.id, userId: o.manager.id };
      return { o, worker, gw, deps, jobs, ctx };
    }

    async function gap(w: Awaited<ReturnType<typeof world>>) {
      const r = await createGap(w.deps, w.ctx, {
        venueId: w.o.venue.id,
        role: 'line_cook',
        startAt,
        endAt,
        baseRateCents: 2200,
        maxPremiumPct: 20,
      });
      return r;
    }

    /** Gap created, order made, approved and authorized. */
    async function authorized(w: Awaited<ReturnType<typeof world>>) {
      const r = await gap(w);
      const slotId = r.slot.id;
      const { orderId } = await ensureOrder(w.deps, w.ctx, slotId);
      await authorizePayment(w.deps, w.ctx, slotId, orderId);
      return { slotId, orderId, hold: r.hold };
    }

    /** A shift the worker has worked: CONFIRMED at $24.20/hr, then arrive and finish through the real services. */
    async function worked(w: Awaited<ReturnType<typeof world>>) {
      const a = await authorized(w);
      await db()
        .update(shiftSlots)
        .set({ status: 'CONFIRMED', workerId: w.worker.id, offeredRateCents: 2420 })
        .where(eq(shiftSlots.id, a.slotId));
      const early = new Date(startAt.getTime() - 10 * 60_000);
      const arriveDeps = { ...w.deps, now: () => early };
      await arrive(arriveDeps, w.worker.id, a.slotId);
      await finish({ ...w.deps, now: () => endAt }, w.worker.id, a.slotId);
      return a;
    }

    const ledgerOf = async (paymentId: string) =>
      (await db().select().from(ledgerEntries).where(eq(ledgerEntries.paymentId, paymentId))).map(
        (l) => `${l.type}:${l.amountCents}`,
      );

    // ------------------------------------------------------------------------------------------ order + authorize
    describe('order and authorization', () => {
      it('creating a gap creates the PayPal order for the max hold and stores its id', async () => {
        const w = await world();
        const r = await gap(w);
        const pay = await latestPayment(db(), r.slot.id);
        expect(pay!.status).toBe('AUTH_PENDING_APPROVAL');
        expect(pay!.paypalOrderId).toMatch(/^ORD/);
        expect(w.gw.orders.get(pay!.paypalOrderId!)!.cents).toBe(r.hold.authorizedCents);
        expect(r.hold.authorizedCents).toBe(22176); // 8 h x $26.40 = $211.20 + 5% fee $10.56
      });

      it('ensureOrder is idempotent and recovers when the first attempt failed', async () => {
        const w = await world();
        w.gw.failNext(
          'createOrder',
          new PaypalError('x', 'network', undefined, undefined, [], undefined),
        );
        const r = await gap(w); // order creation failed inside createGap: the gap still exists
        expect((await latestPayment(db(), r.slot.id))!.paypalOrderId).toBeNull();
        const a = await ensureOrder(w.deps, w.ctx, r.slot.id);
        const b = await ensureOrder(w.deps, w.ctx, r.slot.id);
        expect(a.orderId).toBe(b.orderId);
        expect(w.gw.orders.size).toBe(1);
      });

      it('authorizes once, records the authorization and a ledger row; repeating changes nothing', async () => {
        const w = await world();
        const { slotId, orderId } = await authorized(w);
        const pay = (await latestPayment(db(), slotId))!;
        expect(pay.status).toBe('AUTHORIZED');
        expect(pay.authorizationId).toMatch(/^AUTH/);
        expect(pay.authorizationExpiresAt).toBeInstanceOf(Date);
        await authorizePayment(w.deps, w.ctx, slotId, orderId); // idempotent
        await authorizePayment(w.deps, w.ctx, slotId, orderId);
        expect(w.gw.count('authorize')).toBe(1);
        expect(await ledgerOf(pay.id)).toEqual(['AUTHORIZED:22176']);
      });

      it('rejects an order id that is not this gap’s order', async () => {
        const w = await world();
        const r = await gap(w);
        await expect(
          authorizePayment(w.deps, w.ctx, r.slot.id, 'ORDSOMEONEELSE'),
        ).rejects.toMatchObject({
          code: 'invalid_input',
        });
        expect(w.gw.count('authorize')).toBe(0);
      });

      it('an order the buyer has not approved stays awaiting approval', async () => {
        const w = await world();
        const r = await gap(w);
        w.gw.approve = false;
        const orderId = (await latestPayment(db(), r.slot.id))!.paypalOrderId!;
        await expect(authorizePayment(w.deps, w.ctx, r.slot.id, orderId)).rejects.toMatchObject({
          code: 'payment_not_authorized',
        });
        expect((await latestPayment(db(), r.slot.id))!.status).toBe('AUTH_PENDING_APPROVAL');
      });

      it('a different authorized amount is refused and the stray hold is voided', async () => {
        const w = await world();
        const r = await gap(w);
        const orderId = (await latestPayment(db(), r.slot.id))!.paypalOrderId!;
        w.gw.orders.get(orderId)!.cents = 1000; // PayPal would hold $10, not $221.76
        await expect(authorizePayment(w.deps, w.ctx, r.slot.id, orderId)).rejects.toMatchObject({
          code: 'invalid_input',
        });
        expect((await latestPayment(db(), r.slot.id))!.status).toBe('AUTH_PENDING_APPROVAL');
        expect(w.gw.count('void')).toBe(1);
      });

      it('does not let startOffering run before the hold is authorized', async () => {
        const w = await world();
        const r = await gap(w);
        await expect(startOffering(w.deps, w.ctx, r.slot.id)).rejects.toMatchObject({
          code: 'payment_not_authorized',
        });
      });
    });

    // ------------------------------------------------------------------------------------------ settlement
    describe('approve and pay', () => {
      it('captures worker pay + fee (final capture), pays the worker, ledgers every movement, settles the slot', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        const r = await approveAndPay(w.deps, w.ctx, slotId, 8);
        // 8 h x $24.20 = $193.60 worker pay; 5% fee = $9.68; capture $203.28
        expect(r).toMatchObject({
          workerPayCents: 19360,
          platformFeeCents: 968,
          captureCents: 20328,
          paymentStatus: 'PAID',
          slotStatus: 'SETTLED',
        });
        const cap = w.gw.calls.find((c) => c.op === 'capture')!;
        expect(cap.args).toMatchObject({
          captureCents: 20328,
          invoiceId: expect.stringContaining(slotId),
        });
        expect(cap.requestId).toMatch(/^capture:/);
        const pay = (await latestPayment(db(), slotId))!;
        expect(pay.captureId).toMatch(/^CAP/);
        expect(pay.senderBatchId).toBe(`sc-${pay.id}`);
        expect(await ledgerOf(pay.id)).toEqual(
          expect.arrayContaining([
            'AUTHORIZED:22176',
            'CAPTURED:20328',
            'PLATFORM_FEE:968',
            'PAYPAL_CAPTURE_FEE:620',
            'PAYOUT_SENT:19360',
            'PAID:19360',
            'PAYPAL_PAYOUT_FEE:25',
          ]),
        );
        const payout = w.gw.calls.find((c) => c.op === 'createPayout')!;
        expect(payout.args).toMatchObject({
          amountCents: 19360,
          receiverEmail: expect.stringContaining('@'),
        });
        const slot = (await db().select().from(shiftSlots).where(eq(shiftSlots.id, slotId)))[0]!;
        expect(slot.approvedHours).toBe('8.00');
        expect(slot.actualHours).toBe('8.17'); // arrived 10 min early: 07:00-10 min .. 15:00
      });

      it('pays fewer approved hours proportionally and releases the rest of the hold', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        const r = await approveAndPay(w.deps, w.ctx, slotId, 6.5);
        expect(r.workerPayCents).toBe(15730); // 6.5 x 24.20
        expect(r.captureCents).toBe(15730 + 787);
        expect(r.captureCents).toBeLessThan(22176);
      });

      it('rejects approved hours above the scheduled hours (the cap) before any PayPal call', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        await expect(approveAndPay(w.deps, w.ctx, slotId, 8.5)).rejects.toMatchObject({
          code: 'invalid_input',
        });
        await expect(approveAndPay(w.deps, w.ctx, slotId, 0)).rejects.toMatchObject({
          code: 'invalid_input',
        });
        expect(w.gw.count('capture')).toBe(0);
        expect(
          (await db().select().from(shiftSlots).where(eq(shiftSlots.id, slotId)))[0]!.status,
        ).toBe('PENDING_APPROVAL');
      });

      it('rejects a capture above the authorization (acceptance 3) without calling PayPal', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        // the stored hold is smaller than what 8 hours would cost
        await db()
          .update(payments)
          .set({ authorizedCents: 20000 })
          .where(eq(payments.slotId, slotId));
        await expect(approveAndPay(w.deps, w.ctx, slotId, 8)).rejects.toMatchObject({
          code: 'invalid_input',
        });
        expect(w.gw.count('capture')).toBe(0);
        expect(w.gw.count('createPayout')).toBe(0);
      });

      it('a declined capture blocks the payout, is visible, and can be retried with a fresh request id', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        w.gw.nextCaptureStatus = 'DECLINED';
        const r1 = await approveAndPay(w.deps, w.ctx, slotId, 8);
        expect(r1.paymentStatus).toBe('CAPTURE_DECLINED');
        expect(w.gw.count('createPayout')).toBe(0);
        const pay = (await latestPayment(db(), slotId))!;
        expect(pay.lastError).toBe('PayPal declined the charge.');
        expect(await ledgerOf(pay.id)).toContain('CAPTURE_DECLINED:20328');
        w.gw.nextCaptureStatus = 'COMPLETED';
        const slot = (await db().select().from(shiftSlots).where(eq(shiftSlots.id, slotId)))[0]!;
        expect(slot.status).toBe('SETTLING');
        const r2 = await approveAndPay(w.deps, w.ctx, slotId, 8); // same hours: resume
        expect(r2.paymentStatus).toBe('PAID');
        const ids = w.gw.calls.filter((c) => c.op === 'capture').map((c) => c.requestId);
        expect(new Set(ids).size).toBe(2);
      });

      it('a pending capture stays AUTHORIZED, blocks the payout and converges through reconcile', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        w.gw.nextCaptureStatus = 'PENDING';
        const r = await approveAndPay(w.deps, w.ctx, slotId, 8);
        expect(r.paymentStatus).toBe('AUTHORIZED');
        expect(w.gw.count('createPayout')).toBe(0);
        const pay = (await latestPayment(db(), slotId))!;
        expect(pay.lastError).toBe('capture_pending');
        for (const c of w.gw.captures.values()) c.status = 'COMPLETED'; // PayPal completes it later
        await reconcilePayments(w.deps);
        expect((await latestPayment(db(), slotId))!.status).toBe('PAID');
      });

      it('INSUFFICIENT_FUNDS fails the payout with a clear reason; retry uses a new sender_batch_id', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        w.gw.failNext('createPayout', pp(422, 'INSUFFICIENT_FUNDS', 'validation'));
        const r1 = await approveAndPay(w.deps, w.ctx, slotId, 8);
        expect(r1.paymentStatus).toBe('PAYOUT_FAILED');
        const failed = (await latestPayment(db(), slotId))!;
        expect(failed.lastError).toMatch(/balance is too low/);
        expect(await ledgerOf(failed.id)).toContain('PAYOUT_FAILED:19360');
        const r2 = await approveAndPay(w.deps, w.ctx, slotId, 8); // the manager retries
        expect(r2.paymentStatus).toBe('PAID');
        const pay = (await latestPayment(db(), slotId))!;
        expect(pay.payoutAttempt).toBe(2);
        expect(pay.senderBatchId).toBe(`sc-${pay.id}-2`);
        expect(w.gw.count('capture')).toBe(1); // the charge is never repeated
      });

      it('a retried payout with the same sender_batch_id does not double-pay (acceptance 4)', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        // PayPal creates the batch but the response is lost (network error after the effect)
        w.gw.failNext(
          'createPayout',
          new PaypalError('x', 'network', undefined, undefined, [], undefined),
          1,
          true,
        );
        await expect(approveAndPay(w.deps, w.ctx, slotId, 8)).rejects.toMatchObject({
          code: 'unavailable',
        });
        let pay = (await latestPayment(db(), slotId))!;
        expect(pay.status).toBe('PAYOUT_PENDING');
        expect(pay.payoutBatchId).toBeNull();
        const r = await approveAndPay(w.deps, w.ctx, slotId, 8); // same call again
        expect(r.paymentStatus).toBe('PAID');
        pay = (await latestPayment(db(), slotId))!;
        const sent = w.gw.calls.filter((c) => c.op === 'createPayout');
        expect(new Set(sent.map((c) => c.requestId)).size).toBe(1);
        expect(w.gw.batches.size).toBe(1); // one batch exists at PayPal
        expect((await ledgerOf(pay.id)).filter((l) => l.startsWith('PAYOUT_SENT'))).toHaveLength(1);
        expect(w.gw.count('capture')).toBe(1);
      });

      it('a retry whose payout already exists at PayPal (same sender_batch_id) resolves to that batch and changes no money state', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        // PayPal created the batch, our answer was lost, and PayPal's request-id memory no longer helps
        w.gw.failNext(
          'createPayout',
          new PaypalError('x', 'network', undefined, undefined, [], undefined),
          1,
          true,
        );
        await expect(approveAndPay(w.deps, w.ctx, slotId, 8)).rejects.toMatchObject({
          code: 'unavailable',
        });
        w.gw.seen.clear();
        const before = (await latestPayment(db(), slotId))!;
        expect(before.payoutBatchId).toBeNull();
        const originalBatch = [...w.gw.batches.keys()][0]!;
        const r = await approveAndPay(w.deps, w.ctx, slotId, 8);
        const after = (await latestPayment(db(), slotId))!;
        expect(after.payoutBatchId).toBe(originalBatch); // recorded the original batch id
        expect(w.gw.batches.size).toBe(1); // never a second batch
        expect(r.paymentStatus).toBe('PAID');
        expect(after).toMatchObject({
          capturedCents: before.capturedCents,
          workerPayCents: before.workerPayCents,
          platformFeeCents: before.platformFeeCents,
          senderBatchId: before.senderBatchId,
          payoutAttempt: before.payoutAttempt,
        });
        expect(w.gw.count('capture')).toBe(1);
        expect((await ledgerOf(after.id)).filter((l) => l.startsWith('PAYOUT_SENT'))).toHaveLength(
          1,
        );
        expect((await ledgerOf(after.id)).filter((l) => l.startsWith('PAID'))).toHaveLength(1);
      });

      it('a duplicate sender_batch_id with no link keeps the payment in PAYOUT_PENDING for reconcile; no second batch, no failure', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        w.gw.failNext(
          'createPayout',
          new PaypalError('x', 'network', undefined, undefined, [], undefined),
          1,
          true,
        );
        await expect(approveAndPay(w.deps, w.ctx, slotId, 8)).rejects.toMatchObject({
          code: 'unavailable',
        });
        w.gw.seen.clear();
        w.gw.duplicateWithoutLink = true;
        await expect(approveAndPay(w.deps, w.ctx, slotId, 8)).rejects.toMatchObject({
          code: 'unavailable',
        });
        const pay = (await latestPayment(db(), slotId))!;
        expect(pay.status).toBe('PAYOUT_PENDING');
        expect(pay.payoutBatchId).toBeNull();
        expect(pay.lastError).toBeNull();
        expect(w.gw.batches.size).toBe(1);
        expect((await ledgerOf(pay.id)).some((l) => l.startsWith('PAYOUT_FAILED'))).toBe(false);
        await reconcilePayments(w.deps); // still unresolved, still not a failure and still no second batch
        expect((await latestPayment(db(), slotId))!.status).toBe('PAYOUT_PENDING');
        expect(w.gw.batches.size).toBe(1);
      });

      it('a payout item that PayPal leaves pending is picked up by reconcile; UNCLAIMED is visible', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        w.gw.nextPayoutItemStatus = 'UNCLAIMED';
        const r = await approveAndPay(w.deps, w.ctx, slotId, 8);
        expect(r.paymentStatus).toBe('PAYOUT_UNCLAIMED');
        const pay = (await latestPayment(db(), slotId))!;
        expect(pay.lastError).toMatch(/not claimed/);
        w.gw.setPayoutItem(pay.payoutBatchId!, 'SUCCESS');
        await reconcilePayments(w.deps);
        expect((await latestPayment(db(), slotId))!.status).toBe('PAID');
      });

      it('is resumable: a crash after capture continues with the payout, never a second capture', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        w.gw.failNext(
          'createPayout',
          new PaypalError('x', 'server', 500, undefined, [], undefined),
        );
        await expect(approveAndPay(w.deps, w.ctx, slotId, 8)).rejects.toMatchObject({
          code: 'unavailable',
        });
        expect((await latestPayment(db(), slotId))!.status).toBe('PAYOUT_PENDING');
        await reconcilePayments(w.deps); // no manager involved
        expect((await latestPayment(db(), slotId))!.status).toBe('PAID');
        expect(w.gw.count('capture')).toBe(1);
      });

      it('refuses a shift that is not waiting for approval, and different hours once the settlement started', async () => {
        const w = await world();
        const a = await authorized(w);
        await expect(approveAndPay(w.deps, w.ctx, a.slotId, 8)).rejects.toMatchObject({
          code: 'invalid_state',
        });
        const w2 = await world();
        const { slotId } = await worked(w2);
        w2.gw.nextCaptureStatus = 'DECLINED';
        await approveAndPay(w2.deps, w2.ctx, slotId, 8);
        await expect(approveAndPay(w2.deps, w2.ctx, slotId, 7)).rejects.toMatchObject({
          code: 'invalid_state',
        });
      });

      it('another organisation cannot settle this shift', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        const other = await makeOrg(db());
        await expect(
          approveAndPay(w.deps, { orgId: other.org.id, userId: other.manager.id }, slotId, 8),
        ).rejects.toMatchObject({ code: 'not_found' });
      });

      it('a fixed fee from config is added to the percentage and shown in the settlement', async () => {
        const w = await world();
        w.deps.config.platformFixedFeeCents = 100;
        const r = await gap(w);
        expect(r.hold.authorizedCents).toBe(22176 + 100);
      });
    });

    // ------------------------------------------------------------------------------------------ void paths
    describe('releasing the hold', () => {
      it('an unfilled slot voids the authorization and notifies the manager (acceptance 6)', async () => {
        const w = await world(new Date('2026-10-14T13:00:00Z'));
        const { slotId } = await authorized(w);
        await startOffering(w.deps, w.ctx, slotId);
        await db()
          .update(shiftSlots)
          .set({ fillBy: new Date('2026-10-14T13:30:00Z') })
          .where(eq(shiftSlots.id, slotId));
        const done = await fillDeadline(
          { ...w.deps, now: () => new Date('2026-10-14T13:31:00Z') },
          { slotId },
        );
        expect(done).toBe(true);
        const pay = (await latestPayment(db(), slotId))!;
        expect(pay.status).toBe('VOIDED');
        expect(w.gw.auths.get(pay.authorizationId!)!.status).toBe('VOIDED');
        expect(await ledgerOf(pay.id)).toContain('VOIDED:22176');
        const n = await db()
          .select()
          .from(notifications)
          .where(eq(notifications.recipient, `manager:${w.o.manager.id}`));
        expect(n.some((x) => (x.payload as { kind: string }).kind === 'gap_unfilled')).toBe(true);
      });

      it('a cancelled gap voids the authorization', async () => {
        const w = await world(new Date('2026-10-14T13:00:00Z'));
        const { slotId } = await authorized(w);
        await cancelGap(w.deps, w.ctx, slotId, 'changed plans');
        expect((await latestPayment(db(), slotId))!.status).toBe('VOIDED');
        expect(w.gw.count('void')).toBe(1);
      });

      it('a hold that was never approved just closes, with no PayPal void', async () => {
        const w = await world(new Date('2026-10-14T13:00:00Z'));
        const r = await gap(w);
        await cancelGap(w.deps, w.ctx, r.slot.id);
        expect((await latestPayment(db(), r.slot.id))!.status).toBe('VOIDED');
        expect(w.gw.count('void')).toBe(0);
      });

      it('if PayPal cannot be reached the hold stays AUTHORIZED and reconcile voids it later', async () => {
        const w = await world(new Date('2026-10-14T13:00:00Z'));
        const { slotId } = await authorized(w);
        w.gw.failNext('void', new PaypalError('x', 'server', 500, undefined, [], undefined));
        await cancelGap(w.deps, w.ctx, slotId);
        expect((await latestPayment(db(), slotId))!.status).toBe('AUTHORIZED');
        await reconcilePayments(w.deps);
        expect((await latestPayment(db(), slotId))!.status).toBe('VOIDED');
      });
    });

    // ------------------------------------------------------------------------------------------ no-show
    describe('no-show', () => {
      it('with time left: re-offers to other workers and KEEPS the authorization (decision: void only when UNFILLED or CANCELLED)', async () => {
        const w = await world(new Date('2026-10-14T14:30:00Z')); // 30 min into an 8 h shift
        const other = await makeWorker(db(), w.o.org.id, { name: 'Next' });
        const { slotId } = await authorized(w);
        await db()
          .update(shiftSlots)
          .set({ status: 'CONFIRMED', workerId: w.worker.id, offeredRateCents: 2420 })
          .where(eq(shiftSlots.id, slotId));
        await db().insert(offers).values({
          slotId,
          workerId: w.worker.id,
          wave: 1,
          rateCents: 2420,
          tokenHash: 'h',
          expiresAt: endAt,
          status: 'CLAIMED',
        });
        const r = await markNoShow(w.deps, w.ctx, slotId);
        expect(r.reoffered).toBe(true);
        const slot = (await db().select().from(shiftSlots).where(eq(shiftSlots.id, slotId)))[0]!;
        expect(slot.status).toBe('OFFERING');
        expect(slot.workerId).toBeNull();
        expect((await latestPayment(db(), slotId))!.status).toBe('AUTHORIZED');
        expect(w.gw.count('void')).toBe(0);
        expect(
          w.jobs.some((j) => j.name === 'send_wave' && (j.data as { reoffer?: boolean }).reoffer),
        ).toBe(true);
        await sendWave(w.deps, { slotId, wave: 3, reoffer: true });
        const sentTo = (await db().select().from(offers).where(eq(offers.slotId, slotId)))
          .filter((o) => o.status === 'SENT')
          .map((o) => o.workerId);
        expect(sentTo).toContain(other.id);
        expect(sentTo).not.toContain(w.worker.id); // the no-show is not offered the shift again
      });

      it('with too little time left: marks the no-show and voids the hold', async () => {
        const w = await world(new Date('2026-10-14T21:30:00Z')); // 30 min left
        const { slotId } = await authorized(w);
        await db()
          .update(shiftSlots)
          .set({ status: 'CONFIRMED', workerId: w.worker.id, offeredRateCents: 2420 })
          .where(eq(shiftSlots.id, slotId));
        const r = await markNoShow(w.deps, w.ctx, slotId);
        expect(r.reoffered).toBe(false);
        expect(
          (await db().select().from(shiftSlots).where(eq(shiftSlots.id, slotId)))[0]!.status,
        ).toBe('NO_SHOW');
        expect((await latestPayment(db(), slotId))!.status).toBe('VOIDED');
        expect(w.gw.count('void')).toBe(1);
      });

      it('cannot mark a no-show before the shift starts', async () => {
        const w = await world(new Date('2026-10-14T12:00:00Z'));
        const { slotId } = await authorized(w);
        await db()
          .update(shiftSlots)
          .set({ status: 'CONFIRMED', workerId: w.worker.id })
          .where(eq(shiftSlots.id, slotId));
        await expect(markNoShow(w.deps, w.ctx, slotId)).rejects.toMatchObject({
          code: 'invalid_state',
        });
      });
    });

    // ------------------------------------------------------------------------------------------ shift day
    describe('check-in and check-out', () => {
      it('only the booked worker can arrive and finish; times and hours are stored; nothing else', async () => {
        const w = await world();
        const a = await authorized(w);
        await db()
          .update(shiftSlots)
          .set({ status: 'CONFIRMED', workerId: w.worker.id, offeredRateCents: 2420 })
          .where(eq(shiftSlots.id, a.slotId));
        const stranger = await makeWorker(db(), w.o.org.id, { name: 'Stranger' });
        const at7 = { ...w.deps, now: () => startAt };
        await expect(arrive(at7, stranger.id, a.slotId)).rejects.toMatchObject({
          code: 'not_found',
        });
        await expect(
          arrive(
            { ...w.deps, now: () => new Date(startAt.getTime() - 2 * 3600_000) },
            w.worker.id,
            a.slotId,
          ),
        ).rejects.toMatchObject({ code: 'invalid_state' });
        await arrive(at7, w.worker.id, a.slotId);
        await arrive(at7, w.worker.id, a.slotId); // idempotent
        await expect(
          finish({ ...w.deps, now: () => endAt }, stranger.id, a.slotId),
        ).rejects.toMatchObject({ code: 'not_found' });
        await finish({ ...w.deps, now: () => endAt }, w.worker.id, a.slotId);
        const s = (await db().select().from(shiftSlots).where(eq(shiftSlots.id, a.slotId)))[0]!;
        expect(s.status).toBe('PENDING_APPROVAL');
        expect(s.checkInAt).toEqual(startAt);
        expect(s.checkOutAt).toEqual(endAt);
        expect(s.actualHours).toBe('8.00');
        expect(s.checkInBy).toBe('worker');
        const n = await db()
          .select()
          .from(notifications)
          .where(eq(notifications.recipient, `manager:${w.o.manager.id}`));
        expect(n.some((x) => (x.payload as { kind: string }).kind === 'hours_to_approve')).toBe(
          true,
        );
      });

      it('cannot finish without arriving', async () => {
        const w = await world();
        const a = await authorized(w);
        await db()
          .update(shiftSlots)
          .set({ status: 'CONFIRMED', workerId: w.worker.id })
          .where(eq(shiftSlots.id, a.slotId));
        await expect(finish(w.deps, w.worker.id, a.slotId)).rejects.toMatchObject({
          code: 'invalid_state',
        });
      });

      it('a manager can confirm the times when the worker could not tap', async () => {
        const w = await world();
        const a = await authorized(w);
        await db()
          .update(shiftSlots)
          .set({ status: 'CONFIRMED', workerId: w.worker.id, offeredRateCents: 2420 })
          .where(eq(shiftSlots.id, a.slotId));
        await managerConfirmTimes(w.deps, w.ctx, a.slotId, {
          checkInAt: startAt,
          checkOutAt: endAt,
        });
        const s = (await db().select().from(shiftSlots).where(eq(shiftSlots.id, a.slotId)))[0]!;
        expect(s.status).toBe('PENDING_APPROVAL');
        expect(s.checkInBy).toBe(`user:${w.o.manager.id}`);
        expect(s.actualHours).toBe('8.00');
        await expect(
          managerConfirmTimes(w.deps, w.ctx, a.slotId, { checkInAt: endAt, checkOutAt: startAt }),
        ).rejects.toBeTruthy();
      });
    });

    // ------------------------------------------------------------------------------------------ reconcile
    describe('reconciliation without webhooks (acceptance 8)', () => {
      it('finishes an approved-but-never-authorized order, and is idempotent', async () => {
        const w = await world();
        const r = await gap(w);
        const first = await reconcilePayments(w.deps);
        expect(first.advanced).toBeGreaterThanOrEqual(1);
        expect((await latestPayment(db(), r.slot.id))!.status).toBe('AUTHORIZED');
        const again = await reconcilePayments(w.deps);
        expect(again.advanced).toBe(0);
        expect(w.gw.count('authorize')).toBe(1);
      });

      it('does not authorize an order the buyer has not approved', async () => {
        const w = await world();
        const r = await gap(w);
        w.gw.approve = false;
        await reconcilePayments(w.deps);
        expect((await latestPayment(db(), r.slot.id))!.status).toBe('AUTH_PENDING_APPROVAL');
      });

      it('notices a hold PayPal released on its own', async () => {
        const w = await world();
        const { slotId } = await authorized(w);
        const pay = (await latestPayment(db(), slotId))!;
        w.gw.auths.get(pay.authorizationId!)!.status = 'VOIDED';
        await reconcilePayments(w.deps);
        expect((await latestPayment(db(), slotId))!.status).toBe('VOIDED');
      });

      it('continueSettlement on a finished payment changes nothing', async () => {
        const w = await world();
        const { slotId } = await worked(w);
        await approveAndPay(w.deps, w.ctx, slotId, 8);
        const before = w.gw.calls.length;
        const r = await continueSettlement(w.deps, slotId, 'system:test');
        expect(r.paymentStatus).toBe('PAID');
        expect(w.gw.calls.length).toBe(before);
      });
    });
  },
);
