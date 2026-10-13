import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { ApprovalsResponse } from '../src/api/dto';
import { getApprovals, type ApiDeps } from '../src/api/handlers';
import { handle } from '../src/api/http';
import { createRateLimiter } from '../src/api/rate-limit';
import { createAuth } from '../src/auth';
import { provisionManager } from '../src/auth/provision';
import { shiftSlots } from '../src/db/schema';
import { maxApprovableHours } from '../src/domain/money';
import { createGap } from '../src/services/gaps';
import { stubAuthorize } from '../src/services/payments-stub';
import { approveAndPay, authorizePayment, ensureOrder } from '../src/services/payments';
import { latestPayment } from '../src/services/payment-queries';
import { arrive, finish } from '../src/services/shift-day';
import { listApprovals } from '../src/services/approvals';
import { createTestDb, hasTestDb } from './db';
import { FakeGateway } from './fake-gateway';
import { makeOrg, makeWorker, testDeps } from './factories';

const BASE = 'https://app.example.test';
const PASSWORD = 'correct horse battery staple 42';
const startAt = new Date('2026-10-14T14:00:00Z');
const endAt = new Date('2026-10-14T22:00:00Z');

describe.skipIf(!hasTestDb)('approvals list and the hold cap (live Postgres, fake PayPal)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;

  async function world() {
    const o = await makeOrg(db());
    const worker = await makeWorker(db(), o.org.id, { name: 'Jordan Reyes', paypalEmail: true });
    const gw = new FakeGateway();
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
    const slotId = r.slot.id;
    const { orderId } = await ensureOrder(deps, ctx, slotId);
    await authorizePayment(deps, ctx, slotId, orderId);
    await db()
      .update(shiftSlots)
      .set({ status: 'CONFIRMED', workerId: worker.id, offeredRateCents: 2420 })
      .where(eq(shiftSlots.id, slotId));
    await arrive({ ...deps, now: () => startAt }, worker.id, slotId);
    await finish({ ...deps, now: () => endAt }, worker.id, slotId);
    return { o, worker, gw, deps, ctx, slotId };
  }

  it('lists a finished shift with hours, rate, hold and the server-computed maximum', async () => {
    const w = await world();
    const r = await listApprovals(w.deps, w.o.org.id);
    expect(r).toMatchObject({ feeBps: 500, fixedFeeCents: 0 });
    expect(r.items).toHaveLength(1);
    const i = r.items[0]!;
    expect(i).toMatchObject({
      slotId: w.slotId,
      workerName: 'Jordan Reyes',
      scheduledHours: 8,
      actualHours: 8,
      rateCents: 2420,
      authorizedCents: 22176,
    });
    expect(i.maxHours).toBe(
      maxApprovableHours({ rateCents: 2420, authorizedCents: 22176, feeBps: 500 }),
    );
    expect(i.maxHours).toBeGreaterThan(8); // the hold covers a little more than the scheduled hours at $24.20
    expect(i.maxHours).toBeLessThan(9);
  });

  it('an approval above the authorized maximum is rejected before any PayPal call; the maximum itself is accepted', async () => {
    const w = await world();
    const max = (await listApprovals(w.deps, w.o.org.id)).items[0]!.maxHours;
    await expect(
      approveAndPay(w.deps, w.ctx, w.slotId, Math.round((max + 0.01) * 100) / 100),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(w.gw.count('capture')).toBe(0);
    const ok = await approveAndPay(w.deps, w.ctx, w.slotId, max);
    expect(ok.captureCents).toBeLessThanOrEqual(22176);
    expect(ok.paymentStatus).toBe('PAID');
    expect((await latestPayment(db(), w.slotId))!.capturedCents).toBeLessThanOrEqual(22176);
  });

  it('a settled shift leaves the list; a declined charge stays on it for a retry', async () => {
    const w = await world();
    w.gw.nextCaptureStatus = 'DECLINED';
    await approveAndPay(w.deps, w.ctx, w.slotId, 8);
    const declined = (await listApprovals(w.deps, w.o.org.id)).items[0]!;
    expect(declined).toMatchObject({
      slotStatus: 'SETTLING',
      paymentStatus: 'capture_declined',
      approvedHours: 8,
    });
    w.gw.nextCaptureStatus = 'COMPLETED';
    await approveAndPay(w.deps, w.ctx, w.slotId, 8);
    expect((await listApprovals(w.deps, w.o.org.id)).items).toHaveLength(0);
  });

  it('GET /api/manager/approvals: 401 without a session, strict DTO, this organisation only', async () => {
    const w = await world();
    const auth = createAuth({
      db: db(),
      secret: 's'.repeat(40),
      baseURL: BASE,
      production: false,
      rateLimit: false,
    });
    const email = `dana-${crypto.randomUUID()}@example.com`;
    await provisionManager(db(), auth, {
      orgId: w.o.org.id,
      email,
      name: 'Dana',
      password: PASSWORD,
    });
    const signIn = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const api: ApiDeps = {
      svc: w.deps,
      auth,
      limiter: createRateLimiter(),
      sessionSecret: 'k'.repeat(40),
      production: false,
      paymentsMode: 'paypal',
      paypalEnv: 'sandbox',
      maxPremiumPctDefault: 20,
    };
    expect(
      (await handle(getApprovals)(api, new Request(`${BASE}/api/manager/approvals`))).status,
    ).toBe(401);
    const res = await handle(getApprovals)(
      api,
      new Request(`${BASE}/api/manager/approvals`, { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = ApprovalsResponse.parse(await res.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      slot_status: 'pending_approval',
      max_hours: expect.any(Number),
    });
    const other = await world();
    expect(
      (await listApprovals(other.deps, other.o.org.id)).items.every((x) => x.slotId !== w.slotId),
    ).toBe(true);
  });
});

describe.skipIf(!hasTestDb)('stub-mode settlement (local runs only, no PayPal)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;

  it('approve-and-pay settles in state and ledger with STUB ids when PAYMENTS_MODE=stub, and never when it is not', async () => {
    const o = await makeOrg(db());
    const worker = await makeWorker(db(), o.org.id, { name: 'Jordan Reyes', paypalEmail: true });
    const { deps } = testDeps(db(), { now: () => endAt });
    deps.config.paymentsMode = 'stub';
    const ctx = { orgId: o.org.id, userId: o.manager.id };
    const r = await createGap(deps, ctx, {
      venueId: o.venue.id,
      role: 'line_cook',
      startAt,
      endAt,
      baseRateCents: 2200,
      maxPremiumPct: 20,
    });
    await stubAuthorize(db(), 'stub', r.slot.id);
    await db()
      .update(shiftSlots)
      .set({ status: 'CONFIRMED', workerId: worker.id, offeredRateCents: 2420 })
      .where(eq(shiftSlots.id, r.slot.id));
    await arrive({ ...deps, now: () => startAt }, worker.id, r.slot.id);
    await finish({ ...deps, now: () => endAt }, worker.id, r.slot.id);
    const out = await approveAndPay(deps, ctx, r.slot.id, 8);
    expect(out).toMatchObject({
      paymentStatus: 'PAID',
      slotStatus: 'SETTLED',
      workerPayCents: 19360,
      platformFeeCents: 968,
      captureCents: 20328,
    });
    const pay = (await latestPayment(db(), r.slot.id))!;
    expect(pay.captureId).toMatch(/^STUB-CAPTURE-/);
    expect(pay.payoutBatchId).toMatch(/^STUB-PAYOUT-/);

    // paypal mode without a gateway never falls back to a fake settlement
    const o2 = await makeOrg(db());
    const w2 = await makeWorker(db(), o2.org.id, { name: 'Sam', paypalEmail: true });
    const { deps: d2 } = testDeps(db(), { now: () => endAt });
    d2.config.paymentsMode = 'paypal';
    const ctx2 = { orgId: o2.org.id, userId: o2.manager.id };
    const g2 = await createGap(d2, ctx2, {
      venueId: o2.venue.id,
      role: 'line_cook',
      startAt,
      endAt,
      baseRateCents: 2200,
      maxPremiumPct: 20,
    });
    await stubAuthorize(db(), 'stub', g2.slot.id);
    await db()
      .update(shiftSlots)
      .set({ status: 'CONFIRMED', workerId: w2.id, offeredRateCents: 2420 })
      .where(eq(shiftSlots.id, g2.slot.id));
    await arrive({ ...d2, now: () => startAt }, w2.id, g2.slot.id);
    await finish({ ...d2, now: () => endAt }, w2.id, g2.slot.id);
    await expect(approveAndPay(d2, ctx2, g2.slot.id, 8)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
