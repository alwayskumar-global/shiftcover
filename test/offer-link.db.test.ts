import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { GapDetailResponse } from '../src/api/dto';
import { getGap, type ApiDeps } from '../src/api/handlers';
import { handle } from '../src/api/http';
import { createRateLimiter } from '../src/api/rate-limit';
import { createAuth } from '../src/auth';
import { provisionManager } from '../src/auth/provision';
import { notifications, offers } from '../src/db/schema';
import { createGap, startOffering } from '../src/services/gaps';
import { resendOfferLink } from '../src/services/offer-link';
import { sendWave } from '../src/services/offers';
import { stubAuthorize } from '../src/services/payments-stub';
import { createTestDb, hasTestDb } from './db';
import { makeOrg, makeWorker, testDeps } from './factories';

const BASE = 'https://app.example.test';
const PASSWORD = 'correct horse battery staple 42';
const startAt = new Date('2026-10-14T14:00:00Z');
const endAt = new Date('2026-10-14T22:00:00Z');

describe.skipIf(!hasTestDb)('GET /api/manager/gaps/[id]: offer_link (live Postgres)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;

  async function manager(orgId: string) {
    const auth = createAuth({
      db: db(),
      secret: 's'.repeat(40),
      baseURL: BASE,
      production: false,
      rateLimit: false,
    });
    const email = `dana-${crypto.randomUUID()}@example.com`;
    await provisionManager(db(), auth, { orgId, email, name: 'Dana', password: PASSWORD });
    const signIn = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    return { auth, cookie };
  }

  async function world() {
    const o = await makeOrg(db());
    const ws = [];
    for (let i = 0; i < 4; i++) ws.push(await makeWorker(db(), o.org.id, { name: `Cook ${i}` }));
    const { deps } = testDeps(db(), { now: () => new Date('2026-10-13T17:00:00Z') });
    deps.config.paymentsMode = 'stub';
    const ctx = { orgId: o.org.id, userId: o.manager.id };
    const g = await createGap(deps, ctx, {
      venueId: o.venue.id,
      role: 'line_cook',
      startAt,
      endAt,
      baseRateCents: 2200,
      maxPremiumPct: 20,
    });
    await stubAuthorize(db(), 'stub', g.slot.id);
    await startOffering(deps, ctx, g.slot.id);
    await sendWave(deps, { slotId: g.slot.id, wave: 1 });
    const m = await manager(o.org.id);
    const api = (paypalEnv: string): ApiDeps => ({
      svc: deps,
      auth: m.auth,
      limiter: createRateLimiter(),
      sessionSecret: 'k'.repeat(40),
      production: false,
      paymentsMode: 'stub',
      paypalEnv,
      maxPremiumPctDefault: 20,
    });
    const get = (a: ApiDeps, slotId = g.slot.id, cookie = m.cookie) =>
      handle(getGap)(
        a,
        new Request(`${BASE}/api/manager/gaps/${slotId}`, { headers: { cookie } }),
        slotId,
      );
    return { o, ws, deps, ctx, g, m, api, get };
  }
  const storedLink = async (offerId: string) => {
    const rows = await db().select().from(notifications);
    return rows
      .filter(
        (r) => (r.payload as { offerId?: string }).offerId === offerId && r.channel === 'email',
      )
      .map((r) => (r.payload as { link: string }).link);
  };

  it('sandbox: each live offer carries the link the Outbox holds; nothing is minted', async () => {
    const w = await world();
    const hashesBefore = (await db().select({ h: offers.tokenHash }).from(offers)).length;
    const notesBefore = (await db().select().from(notifications)).length;
    const res = await w.get(w.api('sandbox'));
    expect(res.status).toBe(200);
    const body = GapDetailResponse.parse(await res.json());
    expect(body.offers.length).toBeGreaterThan(0);
    for (const o of body.offers) {
      const stored = await storedLink(o.id);
      expect(stored).toHaveLength(1);
      expect(o.offer_link).toBe(stored[0]); // the exact stored link
    }
    // reading adds no token and no notification
    expect((await db().select({ h: offers.tokenHash }).from(offers)).length).toBe(hashesBefore);
    expect((await db().select().from(notifications)).length).toBe(notesBefore);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('outside the sandbox the field is omitted entirely', async () => {
    const w = await world();
    for (const env of ['production', 'live', '']) {
      const text = await (await w.get(w.api(env))).text();
      expect(text).not.toContain('offer_link');
      expect(text).not.toMatch(/\/c\/[A-Za-z0-9_-]{20,}/); // no token-bearing path anywhere in the body
    }
  });

  it('withdrawn, declined and expired offers get no link; sent, opened and claimed do', async () => {
    const w = await world();
    await sendWave(w.deps, { slotId: w.g.slot.id, wave: 2 }); // a fourth offer
    const all = await db().select().from(offers).where(eq(offers.slotId, w.g.slot.id));
    const [a, b, c, d] = all;
    await db().update(offers).set({ status: 'WITHDRAWN' }).where(eq(offers.id, a!.id));
    await db().update(offers).set({ status: 'DECLINED' }).where(eq(offers.id, b!.id));
    await db().update(offers).set({ status: 'EXPIRED' }).where(eq(offers.id, c!.id));
    await db().update(offers).set({ status: 'OPENED' }).where(eq(offers.id, d!.id));
    const body = GapDetailResponse.parse(await (await w.get(w.api('sandbox'))).json());
    const by = new Map(body.offers.map((o) => [o.id, o]));
    for (const x of [a, b, c]) expect('offer_link' in by.get(x!.id)!).toBe(false);
    expect(by.get(d!.id)!.offer_link).toBeTruthy();
  });

  it('after a resend the newest stored link is the one returned', async () => {
    const w = await world();
    const before = GapDetailResponse.parse(await (await w.get(w.api('sandbox'))).json());
    const target = (await db().select().from(offers).where(eq(offers.slotId, w.g.slot.id)))[0]!;
    const worker = w.ws.find((x) => x.id === target.workerId)!;
    await resendOfferLink(w.deps, worker.email);
    const after = GapDetailResponse.parse(await (await w.get(w.api('sandbox'))).json());
    const was = before.offers.find((o) => o.id === target.id)!.offer_link;
    const now = after.offers.find((o) => o.id === target.id)!.offer_link;
    expect(now).toBeTruthy();
    expect(now).not.toBe(was); // the token was replaced, so the old link no longer works
    const resent = (await db().select().from(notifications)).find(
      (r) =>
        (r.payload as { kind?: string; offerId?: string }).kind === 'offer_link_resent' &&
        (r.payload as { offerId?: string }).offerId === target.id,
    );
    expect(now).toBe((resent!.payload as { link: string }).link);
  });

  it('scoped to the manager’s organisation: another org cannot read the gap or its links', async () => {
    const w = await world();
    const other = await makeOrg(db());
    const om = await manager(other.org.id);
    const res = await handle(getGap)(
      { ...w.api('sandbox'), auth: om.auth },
      new Request(`${BASE}/api/manager/gaps/${w.g.slot.id}`, { headers: { cookie: om.cookie } }),
      w.g.slot.id,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('offer_link');
    // and no session at all
    expect((await w.get(w.api('sandbox'), w.g.slot.id, '')).status).toBe(401);
  });
});
