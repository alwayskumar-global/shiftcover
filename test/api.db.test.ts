import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  ClaimResponse,
  CreateGapResponse,
  GapDetailResponse,
  ParseResultDto,
  RosterResponse,
  WorkerOfferDto,
  WorkerShiftsResponse,
} from '../src/api/dto';
import {
  getGap,
  getOffer,
  getRoster,
  getWorkerShifts,
  postClaim,
  postCreateGap,
  postParseGap,
  postStartOffering,
  postStubAuthorize,
  type ApiDeps,
} from '../src/api/handlers';
import { handle } from '../src/api/http';
import { createRateLimiter } from '../src/api/rate-limit';
import { createAuth } from '../src/auth';
import { provisionManager } from '../src/auth/provision';
import { shiftSlots, workers } from '../src/db/schema';
import { sendWave } from '../src/services/offers';
import { createTestDb, hasTestDb } from './db';
import { makeOrg, makeWorker, testDeps } from './factories';

const BASE = 'https://app.example.test';
const PASSWORD = 'correct horse battery staple 42';
// "now" = Wed 2026-10-14 06:40 Pacific
const NOW = new Date('2026-10-14T13:40:00Z');

describe.skipIf(!hasTestDb)('M1 HTTP API (handlers on live Postgres)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;

  async function world(paymentsMode: 'paypal' | 'stub' = 'stub') {
    const o = await makeOrg(db());
    const { deps } = testDeps(db(), { now: () => NOW });
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
      sessionSecret: 'k'.repeat(40),
      production: false,
      paymentsMode,
      maxPremiumPctDefault: 20,
    };
    const jobs: Array<{ name: string; data: Record<string, unknown> }> = [];
    api.svc.enqueue = async (name, data) => {
      jobs.push({ name, data: data as Record<string, unknown> });
    };
    const req = (path: string, init: RequestInit & { auth?: boolean; origin?: boolean } = {}) => {
      const headers = new Headers(init.headers);
      if (init.auth !== false)
        headers.set('cookie', [headers.get('cookie'), cookie].filter(Boolean).join('; '));
      if (init.method === 'POST') {
        if (init.origin !== false) headers.set('origin', BASE);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
      return new Request(`${BASE}${path}`, { ...init, headers });
    };
    return { o, api, req, cookie, jobs };
  }

  async function seedMaria(w: Awaited<ReturnType<typeof world>>) {
    const maria = await makeWorker(db(), w.o.org.id, {
      name: 'Maria Alvarez',
      skills: ['line_cook'],
    });
    const [slot] = await db()
      .insert(shiftSlots)
      .values({
        venueId: w.o.venue.id,
        role: 'line_cook',
        startAt: new Date('2026-10-14T14:00:00Z'),
        endAt: new Date('2026-10-14T22:00:00Z'),
        workerId: maria.id,
        status: 'CONFIRMED',
        baseRateCents: 2200,
        maxPremiumPct: 0,
      })
      .returning();
    return { maria, slot: slot! };
  }

  it('auth: every manager endpoint answers 401 without a session', async () => {
    const w = await world();
    const calls: Array<Promise<Response>> = [
      handle(getRoster)(w.api, w.req('/api/manager/roster', { auth: false })),
      handle(postParseGap)(
        w.api,
        w.req('/api/manager/gaps/parse', { method: 'POST', auth: false, body: '{"text":"abc"}' }),
      ),
      handle(postCreateGap)(
        w.api,
        w.req('/api/manager/gaps', { method: 'POST', auth: false, body: '{}' }),
      ),
      handle(getGap)(w.api, w.req('/api/manager/gaps/x', { auth: false }), crypto.randomUUID()),
      handle(postStartOffering)(
        w.api,
        w.req('/x', { method: 'POST', auth: false }),
        crypto.randomUUID(),
      ),
    ];
    for (const r of await Promise.all(calls)) expect(r.status).toBe(401);
  });

  it('CSRF: manager POSTs without our Origin or without JSON are refused', async () => {
    const w = await world();
    const noOrigin = await handle(postParseGap)(
      w.api,
      w.req('/api/manager/gaps/parse', {
        method: 'POST',
        origin: false,
        body: '{"text":"cook 7 to 3"}',
      }),
    );
    expect(noOrigin.status).toBe(403);
    const evil = await handle(postParseGap)(
      w.api,
      w.req('/api/manager/gaps/parse', {
        method: 'POST',
        origin: false,
        headers: { origin: 'https://evil.test' },
        body: '{"text":"cook 7 to 3"}',
      }),
    );
    expect(evil.status).toBe(403);
    const form = await handle(postParseGap)(
      w.api,
      w.req('/api/manager/gaps/parse', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'text=cook',
      }),
    );
    expect(form.status).toBe(415);
  });

  it('parse: the headline phrase yields a complete card with the replaced shift, its rate and the hold', async () => {
    const w = await world();
    const { slot } = await seedMaria(w);
    const res = await handle(postParseGap)(
      w.api,
      w.req('/api/manager/gaps/parse', {
        method: 'POST',
        body: JSON.stringify({ text: 'Maria called in sick, need a line cook 7 to 3 today' }),
      }),
    );
    expect(res.status).toBe(200);
    const card = ParseResultDto.parse(await res.json());
    expect(card).toMatchObject({
      source: 'rules',
      role: 'line_cook',
      date: '2026-10-14',
      start: '07:00',
      end: '15:00',
      called_out_name: 'Maria',
      replaces_slot_id: slot.id,
      base_rate_cents: 2200, // borrowed from the replaced shift
      max_premium_pct: 20, // org default
      missing: [],
      worker_pay_at_cap_cents: 21_120, // 8h x $26.40 (22.00 + 20%)
      platform_fee_cents: 1056, // 5%
      total_hold_cents: 22_176,
      start_at: '2026-10-14T14:00:00.000Z',
      end_at: '2026-10-14T22:00:00.000Z',
    });
  });

  it('parse: incomplete text reports what is missing instead of guessing', async () => {
    const w = await world();
    const res = await handle(postParseGap)(
      w.api,
      w.req('/api/manager/gaps/parse', {
        method: 'POST',
        body: JSON.stringify({ text: 'we need someone tomorrow' }),
      }),
    );
    const card = ParseResultDto.parse(await res.json());
    expect(card.missing).toEqual(['role', 'time', 'base_rate']);
    expect([card.worker_pay_at_cap_cents, card.platform_fee_cents, card.total_hold_cents]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('END TO END: create gap -> authorize (stub) -> offer -> worker views -> claims -> manager sees CONFIRMED', async () => {
    const w = await world();
    const { slot: original } = await seedMaria(w);
    const others = [];
    for (let i = 0; i < 4; i++)
      others.push(
        await makeWorker(db(), w.o.org.id, { name: `Cook ${i}`, reliability: 0.9 - i * 0.01 }),
      );

    // roster before
    const r0 = RosterResponse.parse(
      await (await handle(getRoster)(w.api, w.req('/api/manager/roster'))).json(),
    );
    expect(r0.date).toBe('2026-10-14');
    expect(r0.summary).toEqual({ open_gaps: 0, offering: 0, shifts_today: 1 });
    expect(r0.resources.map((r) => r.name)).toContain('Maria Alvarez');
    expect(r0.events[0]).toMatchObject({
      status: 'confirmed',
      worker: { name: 'Maria Alvarez', role: 'line_cook' },
    });

    // create the gap (replacing Maria's shift)
    const created = await handle(postCreateGap)(
      w.api,
      w.req('/api/manager/gaps', {
        method: 'POST',
        body: JSON.stringify({
          venue_id: w.o.venue.id,
          role: 'line_cook',
          start_at: '2026-10-14T14:00:00.000Z',
          end_at: '2026-10-14T22:00:00.000Z',
          base_rate_cents: 2200,
          max_premium_pct: 20,
          replaces_slot_id: original.id,
        }),
      }),
    );
    expect(created.status).toBe(201);
    const c = CreateGapResponse.parse(await created.json());
    expect(c.slot.status).toBe('open');
    expect(c.payment.status).toBe('awaiting_approval');
    expect(c.hold.total_hold_cents).toBe(22_176);

    // cannot offer before the payment is authorized
    const early = await handle(postStartOffering)(
      w.api,
      w.req('/x', { method: 'POST', body: '{}' }),
      c.slot.id,
    );
    expect(early.status).toBe(409);

    // stub authorize, then offer
    const auth = await handle(postStubAuthorize)(
      w.api,
      w.req('/x', { method: 'POST', body: '{}' }),
      c.slot.id,
    );
    expect(auth.status).toBe(200);
    const started = await handle(postStartOffering)(
      w.api,
      w.req('/x', { method: 'POST', body: '{}' }),
      c.slot.id,
    );
    expect(started.status).toBe(200);
    expect(w.jobs.map((j) => j.name)).toEqual(
      expect.arrayContaining(['send_wave', 'fill_deadline']),
    );

    // the worker job runs wave 1 (4 eligible cooks + Maria is cancelled-out? she is still active: she gets an offer too)
    await sendWave(w.api.svc, { slotId: c.slot.id, wave: 1 });
    const detail1 = GapDetailResponse.parse(
      await (await handle(getGap)(w.api, w.req('/x'), c.slot.id)).json(),
    );
    expect(detail1.slot.status).toBe('offering');
    expect(detail1.offers).toHaveLength(3);
    expect(detail1.offers.map((o) => o.worker.name)).not.toContain('Maria Alvarez'); // she called out
    expect(detail1.waves).toEqual([
      expect.objectContaining({ wave: 1, audience_count: 3, rate_cents: 2200, capped: false }),
    ]);
    expect(detail1.payment).toMatchObject({ status: 'authorized', authorized_cents: 22_176 });
    expect(detail1.payment!.paypal_references.authorization).toMatch(/^STUB-AUTH-/);

    // fetch the raw link from the Outbox like the future email would carry it
    const { notifications } = await import('../src/db/schema');
    const rows = (await db().select().from(notifications)).filter(
      (n) => n.channel === 'email' && (n.payload as { slotId?: string }).slotId === c.slot.id,
    );
    const links = new Map(
      rows.map((n) => [
        n.recipient.replace('worker:', ''),
        (n.payload as { link: string }).link.split('/c/')[1]!,
      ]),
    );
    const [winnerId, loserId] = [...links.keys()] as [string, string];

    // worker opens link: GET works, sets cookie, token not consumed, security headers present
    const view = await handle(getOffer)(
      w.api,
      new Request(`${BASE}/api/c/${links.get(winnerId)}`),
      links.get(winnerId)!,
    );
    expect(view.status).toBe(200);
    expect(view.headers.get('referrer-policy')).toBe('no-referrer');
    expect(view.headers.get('x-robots-tag')).toMatch(/noindex/);
    const setCookie = view.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const viewDto = WorkerOfferDto.parse(await view.json());
    expect(viewDto.state).toBe('available');
    expect(viewDto).toEqual({
      role: 'line_cook',
      venue_name: 'Test Venue',
      venue_area: '',
      start_at: '2026-10-14T14:00:00.000Z',
      end_at: '2026-10-14T22:00:00.000Z',
      hours: 8,
      distance_mi: expect.any(Number),
      rate_cents: 2200,
      pay_total_cents: 17_600,
      expires_at: '2026-10-14T13:55:00.000Z', // 15 min after "now"
      state: 'available',
    });
    expect(viewDto.pay_total_cents).toBe(17_600); // 8h x $22.00
    expect(viewDto.hours).toBe(8);
    expect(viewDto.venue_area).toBe('');
    expect(JSON.stringify(viewDto)).not.toMatch(/worker_?id/i);
    const winnerCookie = setCookie.split(';')[0]!;

    // claim without our Origin is blocked (CSRF); with it, it works
    const csrf = await handle(postClaim)(
      w.api,
      new Request(`${BASE}/api/c/${links.get(winnerId)}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: winnerCookie },
        body: '{}',
      }),
      links.get(winnerId)!,
    );
    expect(csrf.status).toBe(403);
    const claim = await handle(postClaim)(
      w.api,
      new Request(`${BASE}/api/c/${links.get(winnerId)}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE, cookie: winnerCookie },
        body: '{}',
      }),
      links.get(winnerId)!,
    );
    expect(claim.status).toBe(200);
    expect(ClaimResponse.parse(await claim.json()).state).toBe('claimed');

    // the other worker sees "taken", with a clean 200
    const lateView = await handle(getOffer)(
      w.api,
      new Request(`${BASE}/api/c/${links.get(loserId)}`),
      links.get(loserId)!,
    );
    expect(WorkerOfferDto.parse(await lateView.json()).state).toBe('taken');

    // my shifts (cookie) shows only my own offer
    const mine = WorkerShiftsResponse.parse(
      await (
        await handle(getWorkerShifts)(
          w.api,
          new Request(`${BASE}/api/w/shifts`, { headers: { cookie: winnerCookie } }),
        )
      ).json(),
    );
    expect(mine.shifts).toHaveLength(1);
    expect(mine.shifts[0]).toMatchObject({
      is_mine: true,
      slot_status: 'confirmed',
      offer_status: 'claimed',
    });
    expect((await handle(getWorkerShifts)(w.api, new Request(`${BASE}/api/w/shifts`))).status).toBe(
      401,
    );

    // manager sees the result
    const detail2 = GapDetailResponse.parse(
      await (await handle(getGap)(w.api, w.req('/x'), c.slot.id)).json(),
    );
    expect(detail2.slot).toMatchObject({ status: 'confirmed' });
    expect(detail2.slot.worker!.id).toBe(winnerId);
    expect(detail2.offers.filter((o) => o.status === 'claimed')).toHaveLength(1);
    expect(detail2.offers.filter((o) => o.status === 'withdrawn')).toHaveLength(2);
    const r1 = RosterResponse.parse(
      await (await handle(getRoster)(w.api, w.req('/api/manager/roster?date=2026-10-14'))).json(),
    );
    expect(r1.summary.shifts_today).toBe(1); // Maria's cancelled shift is gone; the new one is confirmed
    expect(r1.events.find((e) => e.id === c.slot.id)).toMatchObject({
      status: 'confirmed',
      worker: { id: winnerId },
    });
    void others;
  });

  it("worker cookie from worker A cannot claim worker B's link", async () => {
    const w = await world();
    for (let i = 0; i < 2; i++) await makeWorker(db(), w.o.org.id, { name: `W${i}` });
    const created = CreateGapResponse.parse(
      await (
        await handle(postCreateGap)(
          w.api,
          w.req('/api/manager/gaps', {
            method: 'POST',
            body: JSON.stringify({
              venue_id: w.o.venue.id,
              role: 'line_cook',
              start_at: '2026-10-14T14:00:00.000Z',
              end_at: '2026-10-14T22:00:00.000Z',
              base_rate_cents: 2200,
              max_premium_pct: 20,
            }),
          }),
        )
      ).json(),
    );
    await handle(postStubAuthorize)(
      w.api,
      w.req('/x', { method: 'POST', body: '{}' }),
      created.slot.id,
    );
    await handle(postStartOffering)(
      w.api,
      w.req('/x', { method: 'POST', body: '{}' }),
      created.slot.id,
    );
    await sendWave(w.api.svc, { slotId: created.slot.id, wave: 1 });
    const { notifications } = await import('../src/db/schema');
    const rows = (await db().select().from(notifications)).filter(
      (n) => n.channel === 'email' && (n.payload as { slotId?: string }).slotId === created.slot.id,
    );
    const [a, b] = rows.map((n) => (n.payload as { link: string }).link.split('/c/')[1]!) as [
      string,
      string,
    ];
    const viewA = await handle(getOffer)(w.api, new Request(`${BASE}/api/c/${a}`), a);
    const cookieA = viewA.headers.get('set-cookie')!.split(';')[0]!;
    const steal = await handle(postClaim)(
      w.api,
      new Request(`${BASE}/api/c/${b}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE, cookie: cookieA },
        body: '{}',
      }),
      b,
    );
    expect(steal.status).toBe(404);
    expect(WorkerOfferDto.parse(await steal.json()).state).toBe('invalid');
  });

  it('unknown or garbage tokens answer 404 invalid, never 500', async () => {
    const w = await world();
    for (const tok of ['nope', 'x'.repeat(200), '../../etc/passwd']) {
      const r = await handle(getOffer)(
        w.api,
        new Request(`${BASE}/api/c/${encodeURIComponent(tok)}`),
        tok,
      );
      expect(r.status).toBe(404);
      expect((await r.json()).state).toBe('invalid');
    }
  });

  it('claim endpoint is rate limited per IP', async () => {
    const w = await world();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const r = await handle(postClaim)(
        w.api,
        new Request(`${BASE}/api/c/abc/claim`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: BASE,
            'x-forwarded-for': '198.51.100.7',
          },
          body: '{}',
        }),
        'abc',
      );
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
  });

  it('stub authorize is a 404 unless PAYMENTS_MODE=stub; and 404 in production even if misconfigured', async () => {
    const w = await world('paypal');
    const r = await handle(postStubAuthorize)(
      w.api,
      w.req('/x', { method: 'POST', body: '{}' }),
      crypto.randomUUID(),
    );
    expect(r.status).toBe(404);
    const prod = await world('stub');
    prod.api.production = true;
    const r2 = await handle(postStubAuthorize)(
      prod.api,
      prod.req('/x', { method: 'POST', body: '{}' }),
      crypto.randomUUID(),
    );
    expect(r2.status).toBe(404);
  });

  it("manager A cannot see or act on org B's gaps", async () => {
    const a = await world();
    const b = await world();
    const created = CreateGapResponse.parse(
      await (
        await handle(postCreateGap)(
          b.api,
          b.req('/api/manager/gaps', {
            method: 'POST',
            body: JSON.stringify({
              venue_id: b.o.venue.id,
              role: 'line_cook',
              start_at: '2026-10-14T14:00:00.000Z',
              end_at: '2026-10-14T22:00:00.000Z',
              base_rate_cents: 2200,
              max_premium_pct: 20,
            }),
          }),
        )
      ).json(),
    );
    expect((await handle(getGap)(a.api, a.req('/x'), created.slot.id)).status).toBe(404);
    expect(
      (
        await handle(postStartOffering)(
          a.api,
          a.req('/x', { method: 'POST', body: '{}' }),
          created.slot.id,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handle(postStubAuthorize)(
          a.api,
          a.req('/x', { method: 'POST', body: '{}' }),
          created.slot.id,
        )
      ).status,
    ).toBe(404);
    const cross = await handle(postCreateGap)(
      a.api,
      a.req('/api/manager/gaps', {
        method: 'POST',
        body: JSON.stringify({
          venue_id: b.o.venue.id,
          role: 'line_cook',
          start_at: '2026-10-14T14:00:00.000Z',
          end_at: '2026-10-14T22:00:00.000Z',
          base_rate_cents: 2200,
          max_premium_pct: 20,
        }),
      }),
    );
    expect(cross.status).toBe(404);
    void workers;
    void eq;
  });

  it('validation errors are 4xx with a safe body', async () => {
    const w = await world();
    const bad = await handle(postCreateGap)(
      w.api,
      w.req('/api/manager/gaps', {
        method: 'POST',
        body: JSON.stringify({ venue_id: 'nope', role: 'astronaut' }),
      }),
    );
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
  });
});
