import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { InviteWorkerResponse, WorkersResponse } from '../src/api/dto';
import { getWorkers, postInviteWorker, type ApiDeps } from '../src/api/handlers';
import { handle } from '../src/api/http';
import { createRateLimiter } from '../src/api/rate-limit';
import { createAuth } from '../src/auth';
import { provisionManager } from '../src/auth/provision';
import { notifications, workers } from '../src/db/schema';
import { listOutbox } from '../src/services/outbox';
import {
  availabilitySummary,
  inviteWorker,
  listWorkers,
  tierOf,
} from '../src/services/worker-directory';
import { createTestDb, hasTestDb } from './db';
import { makeOrg, makeWorker, testDeps } from './factories';

const BASE = 'https://app.example.test';
const PASSWORD = 'correct horse battery staple 42';
const NOW = new Date('2026-10-12T19:00:00Z');

describe('availability summary and tiers (pure)', () => {
  const day = (weekday: number, startMinute: number, endMinute: number) => ({
    weekday,
    startMinute,
    endMinute,
  });
  it('groups days with the same window and collapses runs', () => {
    expect(availabilitySummary([])).toBe('Not set');
    expect(availabilitySummary([0, 1, 2, 3, 4, 5, 6].map((d) => day(d, 0, 1440)))).toBe(
      'Every day, any time',
    );
    expect(availabilitySummary([1, 2, 3, 4, 5].map((d) => day(d, 360, 840)))).toBe(
      'Mon–Fri 6 AM–2 PM',
    );
    expect(availabilitySummary([day(1, 360, 840), day(3, 360, 840), day(6, 960, 1380)])).toBe(
      'Mon, Wed 6 AM–2 PM · Sat 4 PM–11 PM',
    );
    expect(availabilitySummary([day(5, 570, 1020)])).toBe('Fri 9:30 AM–5 PM');
  });
  it('reliability tiers: Reliable 90+, Good 75-89, Review under 75', () => {
    expect([0.95, 0.9, 0.89, 0.75, 0.74, 0.2].map(tierOf)).toEqual([
      'reliable',
      'reliable',
      'good',
      'good',
      'review',
      'review',
    ]);
  });
});

describe.skipIf(!hasTestDb)('workers directory and invites (live Postgres)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;

  it('lists this organisation’s workers with skills, cert expiry states, availability and reliability', async () => {
    const o = await makeOrg(db());
    await makeWorker(db(), o.org.id, {
      name: 'Jordan Reyes',
      skills: ['line_cook', 'prep_cook'],
      reliability: 0.94,
      certs: [
        { cert: 'food_handler', validUntil: '2027-03-01' },
        { cert: 'alcohol_service', validUntil: '2026-10-27' },
      ],
      availability: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        startMinute: 360,
        endMinute: 840,
      })),
    });
    await makeWorker(db(), o.org.id, {
      name: 'Sam Okafor',
      skills: ['server'],
      reliability: 0.6,
      certs: [{ cert: 'food_handler', validUntil: '2026-10-01' }],
      availability: [],
    });
    await makeWorker(db(), o.org.id, {
      name: 'No Expiry',
      certs: [{ cert: 'first_aid', validUntil: null }],
    });
    const other = await makeOrg(db());
    await makeWorker(db(), other.org.id, { name: 'Other Org Worker' });
    const { deps } = testDeps(db(), { now: () => NOW });
    const r = await listWorkers(deps, o.org.id);
    expect(r.items.map((w) => w.name)).toEqual(['Jordan Reyes', 'No Expiry', 'Sam Okafor']);
    const jordan = r.items.find((w) => w.name === 'Jordan Reyes')!;
    expect(jordan).toMatchObject({
      skills: ['line_cook', 'prep_cook'],
      availability: 'Mon–Fri 6 AM–2 PM',
      reliabilityPct: 94,
      tier: 'reliable',
    });
    expect(jordan.certs).toEqual([
      { cert: 'alcohol_service', validUntil: '2026-10-27', state: 'expiring', daysLeft: 15 },
      { cert: 'food_handler', validUntil: '2027-03-01', state: 'valid', daysLeft: 140 },
    ]);
    const sam = r.items.find((w) => w.name === 'Sam Okafor')!;
    expect(sam).toMatchObject({ availability: 'Not set', tier: 'review' });
    expect(sam.certs[0]).toMatchObject({ state: 'expired', daysLeft: -11 });
    expect(r.items.find((w) => w.name === 'No Expiry')!.certs[0]).toMatchObject({
      state: 'no_expiry',
      daysLeft: null,
    });
    expect(r.summary).toEqual({ total: 3, active: 3, invited: 0, certsNeedingAttention: 2 });
    expect(r.items.some((w) => w.name === 'Other Org Worker')).toBe(false);
  });

  it('an invite creates an invited worker and an email in the Outbox; a repeat sends nothing', async () => {
    const o = await makeOrg(db());
    const { deps } = testDeps(db(), { now: () => NOW });
    const ctx = { orgId: o.org.id, userId: o.manager.id };
    const a = await inviteWorker(deps, ctx, '  Tessa.Moore@Example.com ');
    expect(a).toMatchObject({ kind: 'sent', email: 'tessa.moore@example.com' });
    const [w] = await db()
      .select()
      .from(workers)
      .where(eq(workers.email, 'tessa.moore@example.com'));
    expect(w).toMatchObject({ status: 'invited', name: 'Tessa Moore', orgId: o.org.id });
    const sent = (await db().select().from(notifications)).filter(
      (n) => n.recipient === 'email:tessa.moore@example.com',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ kind: 'worker_invite', workerId: w!.id });
    expect((await listOutbox(db(), o.org.id)).some((i) => i.kind === 'worker_invite')).toBe(true);

    const again = await inviteWorker(deps, ctx, 'tessa.moore@example.com');
    expect(again).toMatchObject({ kind: 'exists', status: 'invited' });
    expect(
      (await db().select().from(notifications)).filter(
        (n) => n.recipient === 'email:tessa.moore@example.com',
      ),
    ).toHaveLength(1);

    const member = await makeWorker(db(), o.org.id, { name: 'On Team' });
    expect(await inviteWorker(deps, ctx, member.email)).toMatchObject({
      kind: 'exists',
      status: 'active',
      name: 'On Team',
    });
    await expect(inviteWorker(deps, ctx, 'not an email')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('GET /api/manager/workers and POST invite: 401, strict DTOs, 409 codes, 400/422 on bad input', async () => {
    const o = await makeOrg(db());
    await makeWorker(db(), o.org.id, { name: 'On Team' });
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
      paymentsMode: 'paypal',
      paypalEnv: 'sandbox',
      maxPremiumPctDefault: 20,
    };
    const get = (withCookie = true) =>
      handle(getWorkers)(
        api,
        new Request(
          `${BASE}/api/manager/workers`,
          withCookie ? { headers: { cookie } } : undefined,
        ),
      );
    const post = (body: unknown, opts: { cookie?: boolean; origin?: string } = {}) =>
      handle(postInviteWorker)(
        api,
        new Request(`${BASE}/api/manager/workers/invite`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: opts.origin ?? BASE,
            ...(opts.cookie === false ? {} : { cookie }),
          },
          body: JSON.stringify(body),
        }),
      );
    expect((await get(false)).status).toBe(401);
    expect((await post({ email: 'a@b.co' }, { cookie: false })).status).toBe(401);
    const list = WorkersResponse.parse(await (await get()).json());
    expect(list.items.map((w) => w.name)).toEqual(['On Team']);

    const sent = await post({ email: 'new.person@example.com' });
    expect(sent.status).toBe(200);
    expect(InviteWorkerResponse.parse(await sent.json())).toMatchObject({
      status: 'invited',
      email: 'new.person@example.com',
    });
    const dup = await post({ email: 'new.person@example.com' });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('already_invited');
    const member = (
      await db()
        .select()
        .from(workers)
        .where(and(eq(workers.orgId, o.org.id), eq(workers.name, 'On Team')))
    )[0]!;
    const mem = await post({ email: member.email });
    expect(mem.status).toBe(409);
    expect(((await mem.json()) as { error: { code: string } }).error.code).toBe('already_member');
    expect((await post({ email: 'nope' })).status).toBe(422);
    expect((await post({ email: 'a@b.co', extra: 1 })).status).toBe(400);
    expect(
      (await post({ email: 'x@y.co' }, { origin: 'https://evil.example' })).status,
    ).toBeGreaterThanOrEqual(400);
    const after = WorkersResponse.parse(await (await get()).json());
    expect(after.summary).toMatchObject({ total: 2, invited: 1, active: 1 });
  });
});
