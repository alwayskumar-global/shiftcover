import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { WorkerProfileResponse } from '../src/api/dto';
import {
  getWorkerProfile,
  patchWorkerProfile,
  postStartEmailChange,
  postVerifyEmailChange,
  type ApiDeps,
} from '../src/api/handlers';
import { handle } from '../src/api/http';
import { createRateLimiter } from '../src/api/rate-limit';
import { createWorkerSession, WORKER_COOKIE } from '../src/auth/worker-session';
import { auditLog, notifications, workerEmailChanges, workers } from '../src/db/schema';
import { listOutbox } from '../src/services/outbox';
import {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  startEmailChange,
  updateProfile,
  verifyEmailChange,
  workerChannels,
} from '../src/services/worker-profile';
import { createTestDb, hasTestDb } from './db';
import { makeOrg, makeWorker, testDeps } from './factories';

const BASE = 'https://app.example.test';
const SECRET = 'k'.repeat(40);

describe.skipIf(!hasTestDb)('worker profile and payout-email change (live Postgres)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;

  async function setup() {
    const o = await makeOrg(db());
    const w = await makeWorker(db(), o.org.id, { name: 'Jordan Reyes', paypalEmail: true });
    let now = new Date('2026-10-14T18:00:00Z');
    const { deps } = testDeps(db(), { now: () => now });
    const codeFor = async (workerId: string) => {
      const rows = await db().select().from(notifications);
      const mine = rows
        .filter((r) => (r.payload as { workerId?: string }).workerId === workerId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return (mine[0]!.payload as { code: string }).code;
    };
    return { o, w, deps, codeFor, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
  }

  it('skills, home area and notification choices save; at least one skill stays', async () => {
    const { w } = await setup();
    const p = await updateProfile(db(), w.id, {
      skills: ['server', 'bartender'],
      homeArea: '  Pearl District ',
      prefs: { offers_email: false },
    });
    expect(p.skills).toEqual(['server', 'bartender']);
    expect(p.homeArea).toBe('Pearl District');
    expect(p.prefs).toEqual({ offers_email: false, offers_push: true, pay_email: true });
    await expect(updateProfile(db(), w.id, { skills: [] })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(updateProfile(db(), w.id, { homeArea: 'x'.repeat(61) })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('notification choices decide the channels used for offers and pay; in-app is always on', async () => {
    const { w } = await setup();
    expect(await workerChannels(db(), w.id, 'offer')).toEqual(['in_app', 'email', 'push']);
    await updateProfile(db(), w.id, { prefs: { offers_email: false, pay_email: false } });
    expect(await workerChannels(db(), w.id, 'offer')).toEqual(['in_app', 'push']);
    expect(await workerChannels(db(), w.id, 'worker_paid')).toEqual(['in_app', 'push']);
    await updateProfile(db(), w.id, { prefs: { offers_push: false } });
    expect(await workerChannels(db(), w.id, 'offer')).toEqual(['in_app']);
  });

  it('the right code changes the payout email and writes a masked audit entry', async () => {
    const s = await setup();
    const r = await startEmailChange(s.deps, s.w.id, '  New.Person@Example.com ');
    expect(r).toEqual({ newEmail: 'new.person@example.com', expiresInSeconds: 600 });
    const code = await s.codeFor(s.w.id);
    expect(code).toMatch(/^\d{6}$/);
    // the code is stored only as a hash
    const [pending] = await db()
      .select()
      .from(workerEmailChanges)
      .where(eq(workerEmailChanges.workerId, s.w.id));
    expect(pending!.codeHash).not.toContain(code);
    expect(await verifyEmailChange(s.deps, s.w.id, code)).toEqual({
      ok: true,
      paypalEmail: 'new.person@example.com',
    });
    const [row] = await db().select().from(workers).where(eq(workers.id, s.w.id));
    expect(row!.paypalEmail).toBe('new.person@example.com');
    expect(
      await db().select().from(workerEmailChanges).where(eq(workerEmailChanges.workerId, s.w.id)),
    ).toHaveLength(0);
    const [audit] = await db().select().from(auditLog).where(eq(auditLog.entityId, s.w.id));
    expect(audit!.action).toBe('worker.payout_email_changed');
    expect(JSON.stringify(audit)).not.toContain('new.person@example.com');
    // the code works once
    expect(await verifyEmailChange(s.deps, s.w.id, code)).toMatchObject({
      ok: false,
      reason: 'none',
    });
  });

  it('a wrong code counts down and locks after five tries; a new code resets', async () => {
    const s = await setup();
    await startEmailChange(s.deps, s.w.id, 'a@example.com');
    const code = await s.codeFor(s.w.id);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++)
      expect(await verifyEmailChange(s.deps, s.w.id, wrong)).toEqual({
        ok: false,
        reason: 'wrong',
        attemptsLeft: MAX_CODE_ATTEMPTS - i,
      });
    expect(await verifyEmailChange(s.deps, s.w.id, wrong)).toMatchObject({
      ok: false,
      reason: 'locked',
    });
    // even the right code is refused once locked
    expect(await verifyEmailChange(s.deps, s.w.id, code)).toMatchObject({
      ok: false,
      reason: 'locked',
    });
    await startEmailChange(s.deps, s.w.id, 'a@example.com');
    expect(await verifyEmailChange(s.deps, s.w.id, await s.codeFor(s.w.id))).toMatchObject({
      ok: true,
    });
  });

  it('an expired code is refused and cleared', async () => {
    const s = await setup();
    await startEmailChange(s.deps, s.w.id, 'b@example.com');
    const code = await s.codeFor(s.w.id);
    s.advance(CODE_TTL_MS + 1000);
    expect(await verifyEmailChange(s.deps, s.w.id, code)).toMatchObject({
      ok: false,
      reason: 'expired',
    });
    expect(await verifyEmailChange(s.deps, s.w.id, code)).toMatchObject({
      ok: false,
      reason: 'none',
    });
  });

  it('rejects a bad address and the current payout email', async () => {
    const s = await setup();
    await expect(startEmailChange(s.deps, s.w.id, 'not-an-email')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const [cur] = await db().select().from(workers).where(eq(workers.id, s.w.id));
    await expect(
      startEmailChange(s.deps, s.w.id, cur!.paypalEmail!.toUpperCase()),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('the Outbox shows the code to the owning organisation only, and nothing logs it', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const s = await setup();
    const other = await setup();
    await startEmailChange(s.deps, s.w.id, 'c@example.com');
    const code = await s.codeFor(s.w.id);
    const mine = (await listOutbox(db(), s.o.org.id)).find((i) => i.kind === 'payout_email_code');
    expect(mine).toMatchObject({ code, channel: 'email' });
    expect(mine!.recipientLabel).toContain('Jordan Reyes');
    expect(
      (await listOutbox(db(), other.o.org.id)).some((i) => i.kind === 'payout_email_code'),
    ).toBe(false);
    for (const sp of spies) {
      expect(JSON.stringify(sp.mock.calls)).not.toContain(code);
      sp.mockRestore();
    }
  });

  it('HTTP: 401 without a session, strict DTOs, 422 / 410 / 429 mapping, code never in a response', async () => {
    const s = await setup();
    const limiter = createRateLimiter();
    const api: ApiDeps = {
      svc: s.deps,
      auth: undefined as never,
      limiter,
      sessionSecret: SECRET,
      production: false,
      paymentsMode: 'paypal',
      paypalEnv: 'sandbox',
      maxPremiumPctDefault: 20,
    };
    const cookie = `${WORKER_COOKIE}=${createWorkerSession(s.w.id, SECRET, s.deps.now())}`;
    const req = (path: string, method: string, body?: unknown, withCookie = true) =>
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          ...(withCookie ? { cookie } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          origin: BASE,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    expect(
      (await handle(getWorkerProfile)(api, req('/api/w/profile', 'GET', undefined, false))).status,
    ).toBe(401);
    const got = await handle(getWorkerProfile)(api, req('/api/w/profile', 'GET'));
    expect(got.status).toBe(200);
    expect(WorkerProfileResponse.parse(await got.json())).toMatchObject({ name: 'Jordan Reyes' });
    const patched = await handle(patchWorkerProfile)(
      api,
      req('/api/w/profile', 'PATCH', { skills: ['host'], notifications: { pay_email: false } }),
    );
    expect(WorkerProfileResponse.parse(await patched.json())).toMatchObject({
      skills: ['host'],
      notifications: { pay_email: false },
    });
    expect(
      (await handle(patchWorkerProfile)(api, req('/api/w/profile', 'PATCH', { email: 'x@y.co' })))
        .status,
    ).toBe(400);

    const bad = await handle(postStartEmailChange)(
      api,
      req('/api/w/profile/payout-email', 'POST', { email: 'nope' }),
    );
    expect(bad.status).toBe(422);
    const start = await handle(postStartEmailChange)(
      api,
      req('/api/w/profile/payout-email', 'POST', { email: 'd@example.com' }),
    );
    expect(start.status).toBe(200);
    const startText = await start.text();
    const code = await s.codeFor(s.w.id);
    expect(startText).not.toContain(code);
    expect(JSON.parse(startText)).toEqual({ new_email: 'd@example.com', expires_in_seconds: 600 });

    const wrong = code === '000000' ? '111111' : '000000';
    const w1 = await handle(postVerifyEmailChange)(
      api,
      req('/api/w/profile/payout-email/verify', 'POST', { code: wrong }),
    );
    expect(w1.status).toBe(422);
    expect(((await w1.json()) as { error: { code: string } }).error.code).toBe('code_wrong');
    s.advance(CODE_TTL_MS + 1000);
    const gone = await handle(postVerifyEmailChange)(
      api,
      req('/api/w/profile/payout-email/verify', 'POST', { code }),
    );
    expect(gone.status).toBe(410);
    expect(((await gone.json()) as { error: { code: string } }).error.code).toBe('code_expired');

    await startEmailChange(s.deps, s.w.id, 'e@example.com');
    const code2 = await s.codeFor(s.w.id);
    const w2 = code2 === '000000' ? '111111' : '000000';
    let last = 0;
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++)
      last = (
        await handle(postVerifyEmailChange)(
          api,
          req('/api/w/profile/payout-email/verify', 'POST', { code: w2 }),
        )
      ).status;
    expect(last).toBe(429);
    // cross-site POST is refused
    const cross = new Request(`${BASE}/api/w/profile/payout-email`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'f@example.com' }),
    });
    expect((await handle(postStartEmailChange)(api, cross)).status).toBeGreaterThanOrEqual(400);
  });
});
