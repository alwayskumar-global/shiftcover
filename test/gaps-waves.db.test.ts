import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { auditLog, notifications, offers, payments, shiftSlots } from '../src/db/schema';
import { maxAuthorization } from '../src/domain/money';
import { createGap, startOffering } from '../src/services/gaps';
import { expireOffer, fillDeadline, sendWave, waveRateCents } from '../src/services/offers';
import { stubAuthorize } from '../src/services/payments-stub';
import { ServiceError } from '../src/services/types';
import { createTestDb, hasTestDb } from './db';
import { makeOrg, makeWorker, testDeps } from './factories';

describe.skipIf(!hasTestDb)('gap creation, offering and waves (live Postgres)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;

  // Wed 2026-10-14 07:00-15:00 Pacific; "now" is 06:40 Pacific.
  const startAt = new Date('2026-10-14T14:00:00Z');
  const endAt = new Date('2026-10-14T22:00:00Z');
  const now = new Date('2026-10-14T13:40:00Z');

  async function setup(nWorkers: number, maxPremiumPct = 20) {
    const o = await makeOrg(db());
    const workers = [];
    for (let i = 0; i < nWorkers; i++) {
      workers.push(
        await makeWorker(db(), o.org.id, { name: `W${i}`, reliability: 0.9 - i * 0.01 }),
      );
    }
    const { deps, jobs } = testDeps(db(), { now: () => now });
    const ctx = { orgId: o.org.id, userId: o.manager.id };
    const gap = await createGap(deps, ctx, {
      venueId: o.venue.id,
      role: 'line_cook',
      startAt,
      endAt,
      baseRateCents: 2200,
      maxPremiumPct,
    });
    return { o, workers, deps, jobs, ctx, gap };
  }

  it('createGap: OPEN slot, computed hold, AUTH_PENDING payment, audited transitions', async () => {
    const { gap } = await setup(0);
    expect(gap.slot.status).toBe('OPEN');
    expect(gap.slot.version).toBe(1);
    const expected = maxAuthorization({
      baseRateCents: 2200,
      maxPremiumPct: 20,
      minutes: 480,
      feeBps: 500,
    });
    expect(gap.hold).toEqual(expected);
    expect(gap.payment.status).toBe('AUTH_PENDING_APPROVAL');
    expect(gap.payment.authorizedCents).toBe(expected.authorizedCents);
    // fill_by: start-30m (06:30) is already past at 06:40 -> pushed to now+10m
    expect(gap.slot.fillBy!.toISOString()).toBe('2026-10-14T13:50:00.000Z');
    const audits = await db().select().from(auditLog).where(eq(auditLog.entityId, gap.slot.id));
    expect(audits.map((a) => a.action)).toEqual(['shift_slot.PLANNED->OPEN']);
    const payAudits = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, gap.payment.id));
    expect(payAudits.map((a) => a.action)).toEqual(['payment.NONE->AUTH_PENDING_APPROVAL']);
  });

  it('createGap validates input and org scoping', async () => {
    const a = await setup(0);
    const b = await makeOrg(db());
    const bad = (over: object) =>
      createGap(a.deps, a.ctx, {
        venueId: a.o.venue.id,
        role: 'line_cook',
        startAt,
        endAt,
        baseRateCents: 2200,
        maxPremiumPct: 10,
        ...over,
      });
    await expect(bad({ role: 'astronaut' })).rejects.toThrow(ServiceError);
    await expect(bad({ endAt: startAt })).rejects.toThrow(ServiceError);
    await expect(bad({ baseRateCents: 0 })).rejects.toThrow(ServiceError);
    await expect(bad({ maxPremiumPct: 101 })).rejects.toThrow(ServiceError);
    await expect(bad({ venueId: b.venue.id })).rejects.toThrow(/venue not found/);
  });

  it('startOffering needs an AUTHORIZED payment, then moves to OFFERING and enqueues idempotently', async () => {
    const s = await setup(2);
    await expect(startOffering(s.deps, s.ctx, s.gap.slot.id)).rejects.toMatchObject({
      code: 'payment_not_authorized',
    });
    await stubAuthorize(db(), 'stub', s.gap.slot.id);
    const slot = await startOffering(s.deps, s.ctx, s.gap.slot.id);
    expect(slot.status).toBe('OFFERING');
    await startOffering(s.deps, s.ctx, s.gap.slot.id); // safe to repeat
    const names = s.jobs.map((j) => `${j.name}:${j.options?.singletonKey}`);
    expect(names).toContain(`send_wave:wave:${slot.id}:1`);
    expect(names).toContain(`fill_deadline:deadline:${slot.id}`);
    const [pay] = await db().select().from(payments).where(eq(payments.slotId, slot.id));
    expect(pay!.status).toBe('AUTHORIZED');
    expect(pay!.authorizationId).toMatch(/^STUB-AUTH-/);
  });

  it('the payment stub refuses to run outside stub mode', async () => {
    const s = await setup(0);
    await expect(stubAuthorize(db(), 'paypal', s.gap.slot.id)).rejects.toMatchObject({
      code: 'stub_disabled',
    });
  });

  it('wave audiences: 3 at base, next 5 at +10%, rest at +20%, clamped to the cap, no repeats', async () => {
    const s = await setup(12, 20);
    await stubAuthorize(db(), 'stub', s.gap.slot.id);
    await startOffering(s.deps, s.ctx, s.gap.slot.id);
    const id = s.gap.slot.id;
    const w1 = await sendWave(s.deps, { slotId: id, wave: 1 });
    const w2 = await sendWave(s.deps, { slotId: id, wave: 2 });
    const w3 = await sendWave(s.deps, { slotId: id, wave: 3 });
    expect([w1.sent, w2.sent, w3.sent]).toEqual([3, 5, 4]);
    const all = await db().select().from(offers).where(eq(offers.slotId, id));
    expect(new Set(all.map((o) => o.workerId)).size).toBe(12); // nobody offered twice
    const rate = (w: number) => all.find((o) => o.wave === w)!.rateCents;
    expect(rate(1)).toBe(2200);
    expect(rate(2)).toBe(2420);
    expect(rate(3)).toBe(2640);
    // wave 1 is the three best-ranked workers (reliability 0.90, 0.89, 0.88)
    const names = new Map(s.workers.map((w) => [w.id, w.name]));
    expect(
      all
        .filter((o) => o.wave === 1)
        .map((o) => names.get(o.workerId))
        .sort(),
    ).toEqual(['W0', 'W1', 'W2']);
  });

  it('never offers above max_premium_pct, whatever the wave', async () => {
    for (const cap of [0, 5, 10, 15]) {
      const s = await setup(10, cap);
      await stubAuthorize(db(), 'stub', s.gap.slot.id);
      await startOffering(s.deps, s.ctx, s.gap.slot.id);
      for (const wave of [1, 2, 3]) await sendWave(s.deps, { slotId: s.gap.slot.id, wave });
      const all = await db().select().from(offers).where(eq(offers.slotId, s.gap.slot.id));
      const ceiling = waveRateCents(2200, cap, cap);
      expect(all.length).toBeGreaterThan(0);
      for (const o of all) expect(o.rateCents).toBeLessThanOrEqual(ceiling);
    }
  });

  it('send_wave twice sends once: no duplicate offers, tokens, messages or follow-up jobs', async () => {
    const s = await setup(4);
    await stubAuthorize(db(), 'stub', s.gap.slot.id);
    await startOffering(s.deps, s.ctx, s.gap.slot.id);
    const id = s.gap.slot.id;
    const first = await sendWave(s.deps, { slotId: id, wave: 1 });
    const jobsAfterFirst = s.jobs.length;
    const second = await sendWave(s.deps, { slotId: id, wave: 1 });
    expect(first.sent).toBe(3);
    expect(second.sent).toBe(0);
    const rows = await db().select().from(offers).where(eq(offers.slotId, id));
    expect(rows).toHaveLength(3);
    const msgs = await db().select().from(notifications);
    const offerMsgs = msgs.filter(
      (m) =>
        (m.payload as { kind?: string; slotId?: string }).kind === 'offer' &&
        (m.payload as { slotId?: string }).slotId === id,
    );
    expect(offerMsgs).toHaveLength(9); // 3 workers x 3 channels
    // the second run still re-enqueues follow-ups, but with the SAME singleton keys (pg-boss dedupes)
    const keys = s.jobs.slice(jobsAfterFirst).map((j) => j.options?.singletonKey);
    for (const k of keys)
      expect(s.jobs.slice(0, jobsAfterFirst).map((j) => j.options?.singletonKey)).toContain(k);
  });

  it('offer links carry a raw token that is never stored; only its hash is', async () => {
    const s = await setup(1);
    await stubAuthorize(db(), 'stub', s.gap.slot.id);
    await startOffering(s.deps, s.ctx, s.gap.slot.id);
    await sendWave(s.deps, { slotId: s.gap.slot.id, wave: 1 });
    const [m] = (await db().select().from(notifications)).filter(
      (x) => x.channel === 'email' && (x.payload as { slotId?: string }).slotId === s.gap.slot.id,
    );
    const link = (m!.payload as { link: string }).link;
    expect(link).toMatch(/^https:\/\/app\.example\.test\/c\/[A-Za-z0-9_-]{43}$/);
    const token = link.split('/c/')[1]!;
    const [o] = await db().select().from(offers).where(eq(offers.slotId, s.gap.slot.id));
    expect(o!.tokenHash).not.toContain(token);
    expect(o!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('send_wave does nothing unless the slot is OFFERING', async () => {
    const s = await setup(3);
    const r = await sendWave(s.deps, { slotId: s.gap.slot.id, wave: 1 });
    expect(r).toEqual({ sent: 0, reason: 'slot_not_offering' });
  });

  it('expire_offer expires only past-due open offers; re-running is a no-op', async () => {
    const s = await setup(1);
    await stubAuthorize(db(), 'stub', s.gap.slot.id);
    await startOffering(s.deps, s.ctx, s.gap.slot.id);
    await sendWave(s.deps, { slotId: s.gap.slot.id, wave: 1 });
    const [o] = await db().select().from(offers).where(eq(offers.slotId, s.gap.slot.id));
    expect(await expireOffer(s.deps, { offerId: o!.id })).toBe(false); // not yet due
    const later = testDeps(db(), { now: () => new Date(now.getTime() + 16 * 60_000) }).deps;
    expect(await expireOffer(later, { offerId: o!.id })).toBe(true);
    expect(await expireOffer(later, { offerId: o!.id })).toBe(false);
    const [after] = await db().select().from(offers).where(eq(offers.id, o!.id));
    expect(after!.status).toBe('EXPIRED');
  });

  it('fill_deadline: UNFILLED, offers withdrawn, authorization voided (stub), manager notified, idempotent', async () => {
    const s = await setup(3);
    await stubAuthorize(db(), 'stub', s.gap.slot.id);
    await startOffering(s.deps, s.ctx, s.gap.slot.id);
    await sendWave(s.deps, { slotId: s.gap.slot.id, wave: 1 });
    expect(await fillDeadline(s.deps, { slotId: s.gap.slot.id })).toBe(true);
    expect(await fillDeadline(s.deps, { slotId: s.gap.slot.id })).toBe(false);
    const [slot] = await db().select().from(shiftSlots).where(eq(shiftSlots.id, s.gap.slot.id));
    expect(slot!.status).toBe('UNFILLED');
    const os = await db().select().from(offers).where(eq(offers.slotId, slot!.id));
    expect(os.every((o) => o.status === 'WITHDRAWN')).toBe(true);
    const [pay] = await db().select().from(payments).where(eq(payments.slotId, slot!.id));
    expect(pay!.status).toBe('VOIDED');
    const msgs = (await db().select().from(notifications)).filter(
      (m) =>
        m.recipient === `manager:${s.o.manager.id}` &&
        (m.payload as { kind?: string }).kind === 'gap_unfilled',
    );
    expect(msgs.length).toBe(2); // in_app + email, once
  });

  it('fill_deadline ignores a slot that was already claimed', async () => {
    const s = await setup(1);
    await stubAuthorize(db(), 'stub', s.gap.slot.id);
    await startOffering(s.deps, s.ctx, s.gap.slot.id);
    await db()
      .update(shiftSlots)
      .set({ status: 'CONFIRMED' })
      .where(eq(shiftSlots.id, s.gap.slot.id));
    expect(await fillDeadline(s.deps, { slotId: s.gap.slot.id })).toBe(false);
  });
});
