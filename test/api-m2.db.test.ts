import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ApproveAndPayResponse,
  AuthorizeResponse,
  ConfirmTimesResponse,
  CreateGapResponse,
  NoShowResponse,
  OrderResponse,
  ShiftDayResponse,
} from '../src/api/dto';
import {
  postApproveAndPay,
  postArrive,
  postAuthorize,
  postConfirmTimes,
  postCreateGap,
  postFinish,
  postNoShow,
  postOrder,
  type ApiDeps,
} from '../src/api/handlers';
import { handle } from '../src/api/http';
import { createRateLimiter } from '../src/api/rate-limit';
import { createAuth } from '../src/auth';
import { provisionManager } from '../src/auth/provision';
import { createWorkerSession } from '../src/auth/worker-session';
import { shiftSlots } from '../src/db/schema';
import { createTestDb, hasTestDb } from './db';
import { FakeGateway } from './fake-gateway';
import { makeOrg, makeWorker, testDeps } from './factories';

const BASE = 'https://app.example.test';
const PASSWORD = 'correct horse battery staple 42';
const WORKER_SECRET = 'k'.repeat(40);
const NOW = new Date('2026-10-14T22:05:00Z');

describe.skipIf(!hasTestDb)(
  'M2 HTTP API: money and shift-day endpoints (handlers on live Postgres)',
  () => {
    const t = hasTestDb ? createTestDb() : undefined;
    afterAll(() => t?.close());
    const db = () => t!.db;

    async function world(now = NOW) {
      const o = await makeOrg(db());
      const { deps } = testDeps(db(), { now: () => now });
      const gw = new FakeGateway();
      deps.payments = gw;
      deps.enqueue = async () => undefined;
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
        password: PASSWORD,
      });
      const signIn = await auth.api.signInEmail({
        body: { email, password: PASSWORD },
        asResponse: true,
      });
      const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      const api: ApiDeps = {
        svc: deps,
        auth,
        limiter: createRateLimiter(),
        sessionSecret: WORKER_SECRET,
        production: false,
        paymentsMode: 'paypal',
        paypalEnv: 'sandbox',
        maxPremiumPctDefault: 20,
      };
      const req = (
        path: string,
        body: unknown = {},
        opts: { auth?: boolean; origin?: boolean; headers?: Record<string, string> } = {},
      ) => {
        const h = new Headers(opts.headers);
        if (opts.auth !== false)
          h.set('cookie', [h.get('cookie'), cookie].filter(Boolean).join('; '));
        if (opts.origin !== false) h.set('origin', BASE);
        h.set('content-type', 'application/json');
        return new Request(`${BASE}${path}`, {
          method: 'POST',
          headers: h,
          body: JSON.stringify(body),
        });
      };
      const worker = await makeWorker(db(), o.org.id, { name: 'Jordan', paypalEmail: true });
      const workerReq = (path: string, workerId = worker.id) =>
        new Request(`${BASE}${path}`, {
          method: 'POST',
          headers: {
            origin: BASE,
            'content-type': 'application/json',
            cookie: `sc_worker=${createWorkerSession(workerId, WORKER_SECRET, NOW)}`,
          },
          body: '{}',
        });
      return { o, api, gw, req, worker, workerReq };
    }
    type W = Awaited<ReturnType<typeof world>>;

    async function createdGap(w: W) {
      const res = await handle(postCreateGap)(
        w.api,
        w.req('/api/manager/gaps', {
          venue_id: w.o.venue.id,
          role: 'line_cook',
          start_at: '2026-10-14T14:00:00.000Z',
          end_at: '2026-10-14T22:00:00.000Z',
          base_rate_cents: 2200,
          max_premium_pct: 20,
        }),
      );
      expect(res.status).toBe(201);
      return CreateGapResponse.parse(await res.json());
    }
    const call = (
      fn: (d: ApiDeps, r: Request, id: string) => Promise<Response>,
      w: W,
      id: string,
      r: Request,
    ) => handle(fn)(w.api, r, id);

    it("order -> authorize: the order id comes from the server; the response is the strict DTO; amounts are the server's", async () => {
      const w = await world();
      const gap = await createdGap(w);
      const id = gap.slot.id;
      const o = OrderResponse.parse(await (await call(postOrder, w, id, w.req(`/x`))).json());
      expect(o.order_id).toMatch(/^ORD/);
      const res = await call(postAuthorize, w, id, w.req('/x', { order_id: o.order_id }));
      expect(res.status).toBe(200);
      const body = AuthorizeResponse.parse(await res.json());
      expect(body.payment.status).toBe('authorized');
      expect(body.payment.authorized_cents).toBe(gap.hold.total_hold_cents);
      // a client-supplied amount is not accepted at all
      const bad = await call(
        postAuthorize,
        w,
        id,
        w.req('/x', { order_id: o.order_id, amount_cents: 1 }),
      );
      expect(bad.status).toBe(400);
    });

    it('rejects a wrong order id, no session, and a missing Origin (CSRF)', async () => {
      const w = await world();
      const gap = await createdGap(w);
      const id = gap.slot.id;
      expect((await call(postAuthorize, w, id, w.req('/x', { order_id: 'ORDWRONG' }))).status).toBe(
        422,
      );
      expect((await call(postOrder, w, id, w.req('/x', {}, { auth: false }))).status).toBe(401);
      expect((await call(postOrder, w, id, w.req('/x', {}, { origin: false }))).status).toBe(403);
    });

    it('answers 503 (not a crash) when PayPal is not configured', async () => {
      const w = await world();
      const gap = await createdGap(w);
      w.api.svc.payments = undefined;
      const res = await call(postOrder, w, gap.slot.id, w.req('/x'));
      expect(res.status).toBe(503);
      expect(JSON.stringify(await res.json())).not.toMatch(/paypal.com|secret|token/i);
    });

    async function worked(w: W) {
      const gap = await createdGap(w);
      const id = gap.slot.id;
      const o = OrderResponse.parse(await (await call(postOrder, w, id, w.req('/x'))).json());
      await call(postAuthorize, w, id, w.req('/x', { order_id: o.order_id }));
      await db()
        .update(shiftSlots)
        .set({ status: 'CONFIRMED', workerId: w.worker.id, offeredRateCents: 2420 })
        .where(eq(shiftSlots.id, id));
      return id;
    }

    it('worker session only: arrive then finish store the times; another worker is refused; no location in the response', async () => {
      const w = await world(new Date('2026-10-14T14:00:00Z'));
      const id = await worked(w);
      const other = await makeWorker(db(), w.o.org.id, { name: 'Other' });
      expect((await call(postArrive, w, id, w.workerReq('/x', other.id))).status).toBe(404);
      expect(
        (
          await call(
            postArrive,
            w,
            id,
            new Request(`${BASE}/x`, {
              method: 'POST',
              headers: { origin: BASE, 'content-type': 'application/json' },
              body: '{}',
            }),
          )
        ).status,
      ).toBe(401);
      const a = await call(postArrive, w, id, w.workerReq('/x'));
      expect(a.status).toBe(200);
      const arrived = ShiftDayResponse.parse(await a.json());
      expect(arrived).toMatchObject({ status: 'in_progress', check_out_at: null });
      expect(Object.keys(arrived).sort()).toEqual([
        'actual_hours',
        'check_in_at',
        'check_out_at',
        'slot_id',
        'status',
      ]);
      w.api.svc.now = () => new Date('2026-10-14T22:00:00Z');
      const f = ShiftDayResponse.parse(
        await (await call(postFinish, w, id, w.workerReq('/x'))).json(),
      );
      expect(f).toMatchObject({ status: 'pending_approval', actual_hours: 8 });
    });

    it('approve-and-pay: server-computed amounts, strict DTO, rejects hours above the cap and unknown fields', async () => {
      const w = await world(new Date('2026-10-14T14:00:00Z'));
      const id = await worked(w);
      await call(postArrive, w, id, w.workerReq('/x'));
      w.api.svc.now = () => new Date('2026-10-14T22:00:00Z');
      await call(postFinish, w, id, w.workerReq('/x'));
      expect(
        (await call(postApproveAndPay, w, id, w.req('/x', { approved_hours: 9 }))).status,
      ).toBe(422);
      expect(
        (await call(postApproveAndPay, w, id, w.req('/x', { approved_hours: 8, capture_cents: 1 })))
          .status,
      ).toBe(400);
      expect(
        (await call(postApproveAndPay, w, id, w.req('/x', { approved_hours: 8 }, { auth: false })))
          .status,
      ).toBe(401);
      const res = await call(postApproveAndPay, w, id, w.req('/x', { approved_hours: 8 }));
      expect(res.status).toBe(200);
      const r = ApproveAndPayResponse.parse(await res.json());
      expect(r).toMatchObject({
        worker_pay_cents: 19360,
        platform_fee_cents: 968,
        capture_cents: 20328,
      });
      expect(r.payment.status).toBe('paid');
      expect(r.slot.status).toBe('settled');
    });

    it('confirm-times (manager fallback) and no-show are manager-only and org-scoped', async () => {
      const w = await world(new Date('2026-10-14T22:05:00Z'));
      const id = await worked(w);
      const stranger = await world();
      expect(
        (
          await call(
            postConfirmTimes,
            stranger,
            id,
            stranger.req('/x', { check_in_at: '2026-10-14T14:00:00.000Z' }),
          )
        ).status,
      ).toBe(404);
      const ok = await call(
        postConfirmTimes,
        w,
        id,
        w.req('/x', {
          check_in_at: '2026-10-14T14:00:00.000Z',
          check_out_at: '2026-10-14T22:00:00.000Z',
        }),
      );
      expect(ConfirmTimesResponse.parse(await ok.json()).slot.status).toBe('pending_approval');
      const id2 = await worked(w);
      w.api.svc.now = () => new Date('2026-10-14T21:30:00Z'); // 30 minutes left: the hold is released
      const ns = NoShowResponse.parse(await (await call(postNoShow, w, id2, w.req('/x'))).json());
      expect(ns.reoffered).toBe(false);
      expect(ns.slot.status).toBe('no_show');
    });
  },
);
