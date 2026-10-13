import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { LedgerResponse } from '../src/api/dto';
import { getLedger, type ApiDeps } from '../src/api/handlers';
import { handle } from '../src/api/http';
import { createRateLimiter } from '../src/api/rate-limit';
import { createAuth } from '../src/auth';
import { provisionManager } from '../src/auth/provision';
import { shiftSlots } from '../src/db/schema';
import { createGap } from '../src/services/gaps';
import { listLedger } from '../src/services/ledger';
import { approveAndPay, authorizePayment, ensureOrder } from '../src/services/payments';
import { arrive, finish } from '../src/services/shift-day';
import { createTestDb, hasTestDb } from './db';
import { FakeGateway } from './fake-gateway';
import { makeOrg, makeWorker, testDeps } from './factories';

const BASE = 'https://app.example.test';
const startAt = new Date('2026-10-14T14:00:00Z');
const endAt = new Date('2026-10-14T22:00:00Z');

describe.skipIf(!hasTestDb)('manager ledger (live Postgres, fake PayPal)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;

  async function shift(
    o: Awaited<ReturnType<typeof makeOrg>>,
    name: string,
    opts: { payout?: string } = {},
  ) {
    const worker = await makeWorker(db(), o.org.id, { name, paypalEmail: true });
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
    return { deps, ctx, gw, slotId: r.slot.id, worker };
  }

  it('lists a paid shift with the money columns, entries in order and a hold that was not fully used', async () => {
    const o = await makeOrg(db());
    const s = await shift(o, 'Jordan Reyes');
    await approveAndPay(s.deps, s.ctx, s.slotId, 8);
    const r = await listLedger(s.deps, o.org.id, {});
    expect(r.items).toHaveLength(1);
    const i = r.items[0]!;
    expect(i).toMatchObject({
      workerName: 'Jordan Reyes',
      group: 'paid',
      authorizedCents: 22176,
      workerPayCents: 19360,
      platformFeeCents: 968,
    });
    expect(i.capturedCents).toBe(i.workerPayCents + i.platformFeeCents);
    expect(i.releasedCents).toBe(i.authorizedCents - i.capturedCents);
    const types = i.entries.map((e) => e.type);
    expect(types).toContain('AUTHORIZED');
    expect(types.indexOf('CAPTURED')).toBeGreaterThan(types.indexOf('AUTHORIZED'));
    expect(types.indexOf('PAID')).toBeGreaterThan(types.indexOf('CAPTURED'));
    expect(r.totals).toEqual({
      authorizedCents: i.authorizedCents,
      capturedCents: i.capturedCents,
      workerPayCents: 19360,
      platformFeeCents: 968,
    });
  });

  it('a held shift is listed before approval; filters by group and range', async () => {
    const o = await makeOrg(db());
    const a = await shift(o, 'Held One');
    const b = await shift(o, 'Paid One');
    await approveAndPay(b.deps, b.ctx, b.slotId, 8);
    const all = await listLedger(a.deps, o.org.id, {});
    expect(all.items.map((i) => i.group).sort()).toEqual(['held', 'paid']);
    expect(
      (await listLedger(a.deps, o.org.id, { group: 'held' })).items.map((i) => i.workerName),
    ).toEqual(['Held One']);
    expect(
      (await listLedger(a.deps, o.org.id, { group: 'paid' })).items.map((i) => i.workerName),
    ).toEqual(['Paid One']);
    expect((await listLedger(a.deps, o.org.id, { group: 'failed' })).items).toHaveLength(0);
    // the shifts were on Oct 14 2026; "now" is endAt, so 7 days includes them and a later clock does not
    expect((await listLedger(a.deps, o.org.id, { range: '7d' })).items).toHaveLength(2);
    const later = { ...a.deps, now: () => new Date('2026-12-30T00:00:00Z') };
    expect((await listLedger(later, o.org.id, { range: '30d' })).items).toHaveLength(0);
    expect((await listLedger(later, o.org.id, { range: 'all' })).items).toHaveLength(2);
  });

  it('a failed payout is a failed row; retrying with the approved hours pays it', async () => {
    const o = await makeOrg(db());
    const s = await shift(o, 'Failed Payout', { payout: 'FAILED' });
    await approveAndPay(s.deps, s.ctx, s.slotId, 8);
    const failed = (await listLedger(s.deps, o.org.id, { group: 'failed' })).items;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      status: 'PAYOUT_FAILED',
      approvedHours: 8,
      workerPayCents: 19360,
    });
    s.gw.nextPayoutItemStatus = 'SUCCESS';
    await approveAndPay(s.deps, s.ctx, s.slotId, failed[0]!.approvedHours!);
    const after = await listLedger(s.deps, o.org.id, {});
    expect(after.items[0]!.group).toBe('paid');
  });

  it('GET /api/manager/ledger: 401 without a session, strict DTO, own organisation only, bad filter is 400', async () => {
    const o = await makeOrg(db());
    const s = await shift(o, 'Jordan Reyes');
    await approveAndPay(s.deps, s.ctx, s.slotId, 8);
    const other = await makeOrg(db());
    await shift(other, 'Other Org Worker');
    const auth = createAuth({
      db: db(),
      secret: 's'.repeat(40),
      baseURL: BASE,
      production: false,
      rateLimit: false,
    });
    const email = `dana-${crypto.randomUUID()}@example.com`;
    await provisionManager(db(), auth, {
      orgId: o.org.id,
      email,
      name: 'Dana',
      password: 'correct horse battery staple 42',
    });
    const signIn = await auth.api.signInEmail({
      body: { email, password: 'correct horse battery staple 42' },
      asResponse: true,
    });
    const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const api: ApiDeps = {
      svc: s.deps,
      auth,
      limiter: createRateLimiter(),
      sessionSecret: 'k'.repeat(40),
      production: false,
      paymentsMode: 'paypal',
      paypalEnv: 'sandbox',
      maxPremiumPctDefault: 20,
    };
    const get = (qs = '', withCookie = true) =>
      handle(getLedger)(
        api,
        new Request(
          `${BASE}/api/manager/ledger${qs}`,
          withCookie ? { headers: { cookie } } : undefined,
        ),
      );
    expect((await get('', false)).status).toBe(401);
    const res = await get('?range=all');
    expect(res.status).toBe(200);
    const body = LedgerResponse.parse(await res.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      worker_name: 'Jordan Reyes',
      status: 'paid',
      group: 'paid',
    });
    expect(JSON.stringify(body)).not.toContain('Other Org Worker');
    expect((await get('?group=bogus')).status).toBe(400);
    expect((await get('?extra=1')).status).toBe(400);
  });
});
