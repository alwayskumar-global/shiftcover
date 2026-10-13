import { afterAll, describe, expect, it, vi } from 'vitest';
import { OutboxResponse } from '../src/api/dto';
import { getOutbox, type ApiDeps } from '../src/api/handlers';
import { handle } from '../src/api/http';
import { createRateLimiter } from '../src/api/rate-limit';
import { createAuth } from '../src/auth';
import { provisionManager } from '../src/auth/provision';
import { notifications } from '../src/db/schema';
import { createTestDb, hasTestDb } from './db';
import { makeOrg, makeWorker, testDeps } from './factories';

const BASE = 'https://app.example.test';
const PASSWORD = 'correct horse battery staple 42';

describe.skipIf(!hasTestDb)('sandbox Outbox API (live Postgres)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;

  async function world(paypalEnv = 'sandbox') {
    const o = await makeOrg(db());
    const { deps } = testDeps(db());
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
      paymentsMode: 'stub',
      paypalEnv,
      maxPremiumPctDefault: 20,
    };
    const req = (withSession: boolean) =>
      new Request(`${BASE}/api/manager/outbox`, { headers: withSession ? { cookie } : {} });
    return { o, api, req, email };
  }
  const get = (w: Awaited<ReturnType<typeof world>>, session = true) =>
    handle(getOutbox)(w.api, w.req(session));

  it('401 without a manager session', async () => {
    const w = await world();
    expect((await get(w, false)).status).toBe(401);
  });

  it('404 when PAYPAL_ENV is not sandbox, with or without a session (it does not reveal itself)', async () => {
    const w = await world('live');
    expect((await get(w, true)).status).toBe(404);
    expect((await get(w, false)).status).toBe(404);
  });

  it('a worker session cannot read it', async () => {
    const w = await world();
    const res = await handle(getOutbox)(
      w.api,
      new Request(`${BASE}/api/manager/outbox`, { headers: { cookie: 'sc_worker=whatever' } }),
    );
    expect(res.status).toBe(401);
  });

  it('lists this organisation’s notifications with channel, recipient, time and the offer link; nothing from other orgs; no sign-in links', async () => {
    const w = await world();
    const worker = await makeWorker(db(), w.o.org.id, { name: 'Jordan' });
    const other = await makeOrg(db());
    const otherWorker = await makeWorker(db(), other.org.id, { name: 'Stranger' });
    await db()
      .insert(notifications)
      .values([
        {
          recipient: `worker:${worker.id}`,
          channel: 'email',
          payload: { kind: 'offer', link: `${BASE}/c/TOKEN-ONE` },
          status: 'pending',
        },
        {
          recipient: `worker:${worker.id}`,
          channel: 'in_app',
          payload: { kind: 'offer', link: `${BASE}/c/TOKEN-ONE` },
          status: 'pending',
        },
        {
          recipient: `manager:${w.o.manager.id}`,
          channel: 'in_app',
          payload: { kind: 'claim_manager' },
          status: 'pending',
        },
        {
          recipient: `email:${w.email}`,
          channel: 'email',
          payload: { kind: 'sign_in_link', link: `${BASE}/magic?token=SECRET` },
          status: 'pending',
        },
        {
          recipient: `worker:${otherWorker.id}`,
          channel: 'email',
          payload: { kind: 'offer', link: `${BASE}/c/TOKEN-OTHER` },
          status: 'pending',
        },
      ]);
    const res = await get(w);
    expect(res.status).toBe(200);
    const body = OutboxResponse.parse(await res.json());
    expect(body.items).toHaveLength(3);
    const offer = body.items.find((i) => i.channel === 'email')!;
    expect(offer).toMatchObject({
      recipient: `worker:${worker.id}`,
      recipient_label: 'Jordan',
      kind: 'offer',
      link: `${BASE}/c/TOKEN-ONE`,
    });
    expect(new Date(offer.created_at).getTime()).toBeGreaterThan(0);
    const all = JSON.stringify(body);
    expect(all).not.toContain('TOKEN-OTHER');
    expect(all).not.toContain('SECRET');
  });

  it('never logs links', async () => {
    const w = await world();
    const worker = await makeWorker(db(), w.o.org.id, { name: 'Jordan' });
    await db()
      .insert(notifications)
      .values({
        recipient: `worker:${worker.id}`,
        channel: 'email',
        payload: { kind: 'offer', link: `${BASE}/c/LOGTEST-TOKEN` },
        status: 'pending',
      });
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await get(w);
    const logged = spies
      .flatMap((s) => s.mock.calls)
      .flat()
      .map(String)
      .join(' ');
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toContain('LOGTEST-TOKEN');
  });
});
