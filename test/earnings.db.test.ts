import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { WorkerEarningsResponse } from '../src/api/dto';
import { getWorkerEarnings, type ApiDeps } from '../src/api/handlers';
import { handle } from '../src/api/http';
import { createRateLimiter } from '../src/api/rate-limit';
import { createWorkerSession, WORKER_COOKIE } from '../src/auth/worker-session';
import { shiftSlots } from '../src/db/schema';
import { createGap } from '../src/services/gaps';
import { approveAndPay, authorizePayment, ensureOrder } from '../src/services/payments';
import { arrive, finish } from '../src/services/shift-day';
import { workerEarnings } from '../src/services/worker-earnings';
import { createTestDb, hasTestDb } from './db';
import { FakeGateway } from './fake-gateway';
import { makeOrg, makeWorker, testDeps } from './factories';

const BASE = 'https://app.example.test';
const SECRET = 'k'.repeat(40);
const startAt = new Date('2026-10-14T14:00:00Z');
const endAt = new Date('2026-10-14T22:00:00Z');

describe.skipIf(!hasTestDb)('worker earnings (live Postgres, fake PayPal)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;

  async function settled(opts: { payout?: string } = {}) {
    const o = await makeOrg(db());
    const worker = await makeWorker(db(), o.org.id, { name: 'Jordan Reyes', paypalEmail: true });
    const gw = new FakeGateway();
    if (opts.payout) gw.nextPayoutItemStatus = opts.payout;
    const { deps } = testDeps(db(), { now: () => endAt });
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
    const { orderId } = await ensureOrder(deps, ctx, r.slot.id);
    await authorizePayment(deps, ctx, r.slot.id, orderId);
    await db()
      .update(shiftSlots)
      .set({ status: 'CONFIRMED', workerId: worker.id, offeredRateCents: 2420 })
      .where(eq(shiftSlots.id, r.slot.id));
    await arrive({ ...deps, now: () => startAt }, worker.id, r.slot.id);
    await finish({ ...deps, now: () => endAt }, worker.id, r.slot.id);
    return { o, worker, deps, ctx, gw, slotId: r.slot.id };
  }

  it('a paid shift shows the worker pay and the payout reference, in this week and month', async () => {
    const w = await settled();
    await approveAndPay(w.deps, w.ctx, w.slotId, 8);
    const e = await workerEarnings(db(), w.worker.id, endAt);
    expect(e.items).toHaveLength(1);
    expect(e.items[0]).toMatchObject({
      slotId: w.slotId,
      status: 'paid',
      workerPayCents: 19360,
      approvedHours: 8,
      rateCents: 2420,
    });
    expect(e.items[0]!.reference).toBeTruthy();
    expect(e.week).toEqual({ totalCents: 19360, paidCents: 19360, onTheWayCents: 0 });
    expect(e.month.totalCents).toBe(19360);
    // a different week and month do not include it
    const later = await workerEarnings(db(), w.worker.id, new Date('2026-12-01T12:00:00Z'));
    expect(later.week.totalCents).toBe(0);
    expect(later.month.totalCents).toBe(0);
    expect(later.items).toHaveLength(1);
  });

  it('a failed payout is listed with its action but left out of the totals', async () => {
    const w = await settled({ payout: 'FAILED' });
    await approveAndPay(w.deps, w.ctx, w.slotId, 8);
    const e = await workerEarnings(db(), w.worker.id, endAt);
    expect(e.items[0]).toMatchObject({ status: 'failed', workerPayCents: 19360 });
    expect(e.failedCents).toBe(19360);
    expect(e.week.totalCents).toBe(0);
    expect(e.month.totalCents).toBe(0);
  });

  it('a shift that is not approved yet is not listed, and nobody sees another worker’s pay', async () => {
    const w = await settled();
    expect((await workerEarnings(db(), w.worker.id, endAt)).items).toHaveLength(0);
    await approveAndPay(w.deps, w.ctx, w.slotId, 8);
    const other = await makeWorker(db(), w.o.org.id, { name: 'Sam', paypalEmail: true });
    expect((await workerEarnings(db(), other.id, endAt)).items).toHaveLength(0);
  });

  it('GET /api/w/earnings: 401 without a session; the body holds worker pay only', async () => {
    const w = await settled();
    await approveAndPay(w.deps, w.ctx, w.slotId, 8);
    const api: ApiDeps = {
      svc: w.deps,
      auth: undefined as never,
      limiter: createRateLimiter(),
      sessionSecret: SECRET,
      production: false,
      paymentsMode: 'paypal',
      paypalEnv: 'sandbox',
      maxPremiumPctDefault: 20,
    };
    const get = (cookie?: string) =>
      handle(getWorkerEarnings)(
        api,
        new Request(`${BASE}/api/w/earnings`, cookie ? { headers: { cookie } } : undefined),
      );
    expect((await get()).status).toBe(401);
    const cookie = `${WORKER_COOKIE}=${createWorkerSession(w.worker.id, SECRET, endAt)}`;
    const res = await get(cookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = WorkerEarningsResponse.parse(JSON.parse(text));
    expect(body.items[0]).toMatchObject({ status: 'paid', worker_pay_cents: 19360 });
    // the employer's side never appears: no authorization, capture or fee fields or amounts
    expect(text).not.toMatch(/authorized|captured|platform_fee|fee_cents/);
    expect(text).not.toContain('20328'); // pay + fee captured from the employer
    expect(text).not.toContain('22176'); // the hold
  });
});
