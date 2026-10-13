import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createAuth } from '../src/auth';
import { requireManager } from '../src/auth/guards';
import { provisionManager } from '../src/auth/provision';
import { notifications, users } from '../src/db/schema';
import { createTestDb, hasTestDb } from './db';
import { makeOrg } from './factories';

const BASE = 'https://app.example.test';
const PASSWORD = 'correct horse battery staple 42';

describe.skipIf(!hasTestDb)('manager auth (Better Auth on live Postgres)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;
  const mk = () =>
    createAuth({
      db: db(),
      secret: 's'.repeat(40),
      baseURL: BASE,
      production: false,
      rateLimit: false,
    });

  async function manager(email = `dana-${crypto.randomUUID()}@example.com`) {
    const o = await makeOrg(db());
    const auth = mk();
    await db().delete(users).where(eq(users.id, o.manager.id)); // use a freshly provisioned one
    const m = await provisionManager(db(), auth, {
      orgId: o.org.id,
      email,
      name: 'Dana',
      password: PASSWORD,
    });
    return { auth, o, email, m };
  }

  const cookiesFrom = (res: Response) =>
    (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

  it('password sign-in works; session resolves to our users row with org and role', async () => {
    const { auth, o, email, m } = await manager();
    const res = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    expect(res.status).toBe(200);
    const ctx = await requireManager(auth, db(), new Headers({ cookie: cookiesFrom(res) }));
    expect(ctx).toMatchObject({ userId: m.userId, orgId: o.org.id, role: 'manager', email });
  });

  it('cookies are httpOnly and SameSite=Lax', async () => {
    const { auth, email } = await manager();
    const res = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    const raw = (res.headers.getSetCookie?.() ?? []).join('\n');
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
  });

  it('wrong password and unknown email fail; no session', async () => {
    const { auth, email } = await manager();
    const bad = await auth.api.signInEmail({
      body: { email, password: 'wrong password 123456' },
      asResponse: true,
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const none = await auth.api.signInEmail({
      body: { email: 'nobody@example.com', password: PASSWORD },
      asResponse: true,
    });
    expect(none.status).toBeGreaterThanOrEqual(400);
    await expect(requireManager(auth, db(), new Headers())).rejects.toMatchObject({ status: 401 });
  });

  it('self sign-up is disabled', async () => {
    const auth = mk();
    const res = await auth.api.signUpEmail({
      body: { email: `x-${crypto.randomUUID()}@example.com`, password: PASSWORD, name: 'X' },
      asResponse: true,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('magic link: link goes through the Notifier (Outbox), signs the manager in, and is single-use', async () => {
    const { auth, email } = await manager();
    await auth.api.signInMagicLink({ body: { email }, headers: new Headers(), asResponse: true });
    const rows = (await db().select().from(notifications)).filter(
      (n) => n.recipient === `email:${email}`,
    );
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as { kind: string; url: string };
    expect(payload.kind).toBe('sign_in_link');
    const token = new URL(payload.url).searchParams.get('token')!;
    const ok = await auth.api.magicLinkVerify({
      query: { token },
      headers: new Headers(),
      asResponse: true,
    });
    expect([200, 302]).toContain(ok.status);
    const ctx = await requireManager(auth, db(), new Headers({ cookie: cookiesFrom(ok) }));
    expect(ctx.email).toBe(email);
    const again = await auth.api.magicLinkVerify({
      query: { token },
      headers: new Headers(),
      asResponse: true,
    });
    expect(cookiesFrom(again)).not.toMatch(/session_token/);
  });

  it('magic link for an unprovisioned email sends nothing and creates no account', async () => {
    const auth = mk();
    const email = `ghost-${crypto.randomUUID()}@example.com`;
    await auth.api.signInMagicLink({ body: { email }, headers: new Headers(), asResponse: true });
    const rows = (await db().select().from(notifications)).filter(
      (n) => n.recipient === `email:${email}`,
    );
    expect(rows).toHaveLength(0);
  });

  it('an authenticated identity without a provisioned manager row is forbidden', async () => {
    const { auth, email } = await manager();
    const res = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    await db().update(users).set({ authSubject: null }).where(eq(users.email, email));
    await expect(
      requireManager(auth, db(), new Headers({ cookie: cookiesFrom(res) })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rate limiting is enabled on sign-in', async () => {
    const o = await makeOrg(db());
    const auth = createAuth({
      db: db(),
      secret: 's'.repeat(40),
      baseURL: BASE,
      production: false,
      rateLimit: true,
    });
    const email = `rl-${crypto.randomUUID()}@example.com`;
    await provisionManager(db(), auth, { orgId: o.org.id, email, name: 'RL', password: PASSWORD });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await auth.handler(
        new Request(`${BASE}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: BASE,
            'x-forwarded-for': '203.0.113.9',
          },
          body: JSON.stringify({ email, password: 'wrong password 123456' }),
        }),
      );
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
  });
});
