import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { offers, shiftSlots } from '../src/db/schema';
import { createGap, startOffering } from '../src/services/gaps';
import { expireOffer, recoverDispatch, sendWave } from '../src/services/offers';
import { stubAuthorize } from '../src/services/payments-stub';
import type { ServiceDeps } from '../src/services/types';
import { createTestDb, hasTestDb } from './db';
import { makeOrg, makeWorker, testDeps, type RecordedJob } from './factories';

const startAt = new Date('2026-10-14T14:00:00Z');
const endAt = new Date('2026-10-14T22:00:00Z');
const now = new Date('2026-10-14T13:40:00Z');
const later = (seconds: number) => () => new Date(now.getTime() + seconds * 1000);

describe.skipIf(!hasTestDb)('recoverable dispatch (live Postgres)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;

  async function authorizedGap(nWorkers = 4) {
    const o = await makeOrg(db());
    for (let i = 0; i < nWorkers; i++)
      await makeWorker(db(), o.org.id, { name: `W${i}`, reliability: 0.9 - i * 0.01 });
    const base = testDeps(db(), { now: () => now });
    const ctx = { orgId: o.org.id, userId: o.manager.id };
    const g = await createGap(base.deps, ctx, {
      venueId: o.venue.id,
      role: 'line_cook',
      startAt,
      endAt,
      baseRateCents: 2200,
      maxPremiumPct: 20,
    });
    await stubAuthorize(db(), 'stub', g.slot.id);
    return { o, ctx, slotId: g.slot.id, base };
  }

  /** deps whose enqueue always fails: the queue is down, or the process died before dispatch. */
  const failing = (deps: ServiceDeps): ServiceDeps => ({
    ...deps,
    enqueue: async () => {
      throw new Error('queue unavailable');
    },
  });

  /** The database stamps real wall-clock time; pin it to the test clock so grace/interval maths is deterministic. */
  const alignClock = async (slotId: string) => {
    await db().update(shiftSlots).set({ updatedAt: now }).where(eq(shiftSlots.id, slotId));
    await db().update(offers).set({ createdAt: now }).where(eq(offers.slotId, slotId));
  };

  const keys = (jobs: RecordedJob[]) =>
    jobs.map((j) => `${j.name}|${j.options?.singletonKey}`).sort();

  it('startOffering commits OFFERING and does not fail when dispatch fails; the recovery job then dispatches', async () => {
    const s = await authorizedGap();
    const err = console.error;
    console.error = () => undefined;
    try {
      const slot = await startOffering(failing(s.base.deps), s.ctx, s.slotId);
      expect(slot.status).toBe('OFFERING'); // no throw, no 500
    } finally {
      console.error = err;
    }
    await alignClock(s.slotId);
    expect(s.base.jobs).toHaveLength(0); // nothing was dispatched
    expect(await db().select().from(offers).where(eq(offers.slotId, s.slotId))).toHaveLength(0);

    // inside the grace window the normal path is not raced
    const early = testDeps(db(), { now: later(10) });
    await recoverDispatch(early.deps);
    // (the shared test database holds other tests' slots too, so look at this slot only)
    expect(
      early.jobs.filter((j) => (j.data as { slotId?: string }).slotId === s.slotId),
    ).toHaveLength(0);

    // the recovery job (any minute after the grace window) re-dispatches with the normal singleton keys
    const rec = testDeps(db(), { now: later(90) });
    const r = await recoverDispatch(rec.deps);
    expect(r.slots).toBeGreaterThanOrEqual(1);
    const mine = rec.jobs.filter((j) => (j.data as { slotId?: string }).slotId === s.slotId);
    expect(keys(mine)).toEqual(
      [`fill_deadline|deadline:${s.slotId}`, `send_wave|wave:${s.slotId}:1`].sort(),
    );
    expect(mine.find((j) => j.name === 'send_wave')!.data).toEqual({ slotId: s.slotId, wave: 1 });

    // running the recovered job produces the offers, exactly as the normal path would
    const sent = await sendWave(rec.deps, { slotId: s.slotId, wave: 1 });
    expect(sent.sent).toBe(3);
    expect(await db().select().from(offers).where(eq(offers.slotId, s.slotId))).toHaveLength(3);
  });

  it('is idempotent: repeated recovery enqueues the same keys and a re-run wave sends nothing new', async () => {
    const s = await authorizedGap();
    const err = console.error;
    console.error = () => undefined;
    await startOffering(failing(s.base.deps), s.ctx, s.slotId);
    console.error = err;
    await alignClock(s.slotId);
    const a = testDeps(db(), { now: later(90) });
    const b = testDeps(db(), { now: later(150) });
    await recoverDispatch(a.deps);
    await recoverDispatch(b.deps);
    const mineA = a.jobs.filter((j) => (j.data as { slotId?: string }).slotId === s.slotId);
    const mineB = b.jobs.filter((j) => (j.data as { slotId?: string }).slotId === s.slotId);
    expect(keys(mineA)).toEqual(keys(mineB)); // same singleton keys: pg-boss collapses them
    await sendWave(a.deps, { slotId: s.slotId, wave: 1 });
    const again = await sendWave(b.deps, { slotId: s.slotId, wave: 1 });
    expect(again.sent).toBe(0);
  });

  it('recovers a lost follow-up: wave 1 was sent but wave 2 was never enqueued', async () => {
    const s = await authorizedGap(6);
    await startOffering(s.base.deps, s.ctx, s.slotId);
    await sendWave(failing(s.base.deps), { slotId: s.slotId, wave: 1 }).catch(() => undefined); // follow-ups fail
    await alignClock(s.slotId);
    expect(
      (await db().select().from(offers).where(eq(offers.slotId, s.slotId))).length,
    ).toBeGreaterThan(0);
    // before the wave interval has elapsed: only the deadline is re-asserted
    const soon = testDeps(db(), { now: later(100) });
    await recoverDispatch(soon.deps);
    expect(
      soon.jobs.filter(
        (j) => j.name === 'send_wave' && (j.data as { slotId?: string }).slotId === s.slotId,
      ),
    ).toHaveLength(0);
    // after interval (300s) + grace: wave 2 is enqueued
    const due = testDeps(db(), { now: later(400) });
    await recoverDispatch(due.deps);
    const w2 = due.jobs.filter(
      (j) => j.name === 'send_wave' && (j.data as { slotId?: string }).slotId === s.slotId,
    );
    expect(w2.map((j) => j.data)).toEqual([{ slotId: s.slotId, wave: 2 }]);
    expect(w2[0]!.options?.singletonKey).toBe(`wave:${s.slotId}:2`);
  });

  it('recovers a lost fill deadline immediately once fill_by has passed, and a lost expiry', async () => {
    const s = await authorizedGap(1);
    await startOffering(s.base.deps, s.ctx, s.slotId);
    await sendWave(s.base.deps, { slotId: s.slotId, wave: 1 });
    await alignClock(s.slotId);
    const [slot] = await db().select().from(shiftSlots).where(eq(shiftSlots.id, s.slotId));
    const afterDeadline = testDeps(db(), {
      now: () => new Date(slot!.fillBy!.getTime() + 20 * 60_000),
    });
    await recoverDispatch(afterDeadline.deps);
    const mine = afterDeadline.jobs.filter(
      (j) =>
        ((j.data as { slotId?: string; offerId?: string }).slotId ?? '') === s.slotId ||
        j.name === 'expire_offer',
    );
    const deadline = mine.find(
      (j) => j.name === 'fill_deadline' && (j.data as { slotId?: string }).slotId === s.slotId,
    )!;
    expect(deadline.options?.startAfter).toBe(0);
    const [o] = await db().select().from(offers).where(eq(offers.slotId, s.slotId));
    expect(
      afterDeadline.jobs.some(
        (j) => j.name === 'expire_offer' && (j.data as { offerId?: string }).offerId === o!.id,
      ),
    ).toBe(true);
    expect(await expireOffer(afterDeadline.deps, { offerId: o!.id })).toBe(true);
  });

  it('ignores slots that are not OFFERING', async () => {
    const s = await authorizedGap(1); // OPEN, authorized, never started
    const rec = testDeps(db(), { now: later(600) });
    await recoverDispatch(rec.deps);
    expect(
      rec.jobs.filter((j) => (j.data as { slotId?: string }).slotId === s.slotId),
    ).toHaveLength(0);
  });
});
