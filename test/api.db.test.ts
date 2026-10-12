import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  ClaimResponse,
  CreateGapResponse,
  GapDetailResponse,
  OfferViewResponse,
  ParsedCardDto,
  RosterResponse,
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
    const card = ParsedCardDto.parse(await res.json());
    expect(card).toMatchObject({
      source: 'rules',
      role: 'line_cook',
      calledOutName: 'Maria',
      replacesSlotId: slot.id,
      baseRateCents: 2200,
      baseRateSource: 'replaced_shift',
      maxPremiumPct: 20,
      maxPremiumSource: 'default',
      missing: [],
    });
    expect(card.startAt).toBe('2026-10-14T14:00:00.000Z');
    expect(card.endAt).toBe('2026-10-14T22:00:00.000Z');
    expect(card.hold).toMatchObject({
      currency: 'USD',
      maxRateCents: 2640,
      authorizedCents: 22_176,
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
    const card = ParsedCardDto.parse(await res.json());
    expect(card.missing).toEqual(['role', 'time', 'baseRate']);
    expect(card.hold).toBeNull();
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
    expect(r0.summary).toEqual({ openGaps: 0, offering: 0, shiftsToday: 1 });
    expect(r0.resources.map((r) => r.name)).toContain('Maria Alvarez');
    expect(r0.events[0]).toMatchObject({
      status: 'CONFIRMED',
      isGap: false,
      workerName: 'Maria Alvarez',
    });

    // create the gap (replacing Maria's shift)
    const created = await handle(postCreateGap)(
      w.api,
      w.req('/api/manager/gaps', {
        method: 'POST',
        body: JSON.stringify({
          venueId: w.o.venue.id,
          role: 'line_cook',
          startAt: '2026-10-14T14:00:00.000Z',
          endAt: '2026-10-14T22:00:00.000Z',
          baseRateCents: 2200,
          maxPremiumPct: 20,
          replacesSlotId: original.id,
        }),
      }),
    );
    expect(created.status).toBe(201);
    const c = CreateGapResponse.parse(await created.json());
    expect(c.slot.status).toBe('OPEN');
    expect(c.payment.status).toBe('AUTH_PENDING_APPROVAL');
    expect(c.hold.authorizedCents).toBe(22_176);

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
    expect(detail1.slot.status).toBe('OFFERING');
    expect(detail1.offers).toHaveLength(3);
    expect(detail1.waves).toEqual([
      expect.objectContaining({ wave: 1, sent: 3, rateCents: 2200, claimed: 0 }),
    ]);
    expect(detail1.payment).toMatchObject({ status: 'AUTHORIZED', authorizedCents: 22_176 });

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
    const viewDto = OfferViewResponse.parse(await view.json());
    expect(viewDto.state).toBe('available');
    expect(viewDto.offer!.estimatedPayCents).toBe(17_600); // 8h x $22.00
    expect(JSON.stringify(viewDto)).not.toContain('workerId');
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
    expect(OfferViewResponse.parse(await lateView.json()).state).toBe('taken');

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
      isMine: true,
      slotStatus: 'CONFIRMED',
      offerStatus: 'CLAIMED',
    });
    expect((await handle(getWorkerShifts)(w.api, new Request(`${BASE}/api/w/shifts`))).status).toBe(
      401,
    );

    // manager sees the result
    const detail2 = GapDetailResponse.parse(
      await (await handle(getGap)(w.api, w.req('/x'), c.slot.id)).json(),
    );
    expect(detail2.slot).toMatchObject({ status: 'CONFIRMED' });
    expect(detail2.slot.worker!.id).toBe(winnerId);
    expect(detail2.waves[0]).toMatchObject({ claimed: 1 });
    const r1 = RosterResponse.parse(
      await (await handle(getRoster)(w.api, w.req('/api/manager/roster?date=2026-10-14'))).json(),
    );
    expect(r1.summary.shiftsToday).toBe(1); // Maria's cancelled shift is gone; the new one is confirmed
    expect(r1.events.find((e) => e.id === c.slot.id)).toMatchObject({
      isGap: false,
      resourceId: winnerId,
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
              venueId: w.o.venue.id,
              role: 'line_cook',
              startAt: '2026-10-14T14:00:00.000Z',
              endAt: '2026-10-14T22:00:00.000Z',
              baseRateCents: 2200,
              maxPremiumPct: 20,
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
    expect(OfferViewResponse.parse({ ...(await steal.json()), offer: null }).state).toBe('invalid');
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
              venueId: b.o.venue.id,
              role: 'line_cook',
              startAt: '2026-10-14T14:00:00.000Z',
              endAt: '2026-10-14T22:00:00.000Z',
              baseRateCents: 2200,
              maxPremiumPct: 20,
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
          venueId: b.o.venue.id,
          role: 'line_cook',
          startAt: '2026-10-14T14:00:00.000Z',
          endAt: '2026-10-14T22:00:00.000Z',
          baseRateCents: 2200,
          maxPremiumPct: 20,
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
        body: JSON.stringify({ venueId: 'nope', role: 'astronaut' }),
      }),
    );
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
  });
});
