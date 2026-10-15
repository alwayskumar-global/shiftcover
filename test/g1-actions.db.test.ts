import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { notifications, offers, payments, shiftSlots, venues, workers } from '../src/db/schema';
import { claimOffer, declineOffer, viewOffer } from '../src/services/claim';
import { cancelGap, createGap, startOffering, widenRadius } from '../src/services/gaps';
import { resendOfferLink } from '../src/services/offer-link';
import { fillDeadline, sendWave } from '../src/services/offers';
import { stubAuthorize } from '../src/services/payments-stub';
import { slotDto } from '../src/services/read-models';
import { createTestDb, hasTestDb } from './db';
import { makeOrg, makeWorker, testDeps } from './factories';

const startAt = new Date('2026-10-14T14:00:00Z');
const endAt = new Date('2026-10-14T22:00:00Z');
const now = new Date('2026-10-14T13:40:00Z');

describe.skipIf(!hasTestDb)(
  'Gate 1 actions: decline, resend, widen radius, cancel (live Postgres)',
  () => {
    const t = hasTestDb ? createTestDb() : undefined;
    afterAll(() => t?.close());
    const db = () => t!.db;

    async function offering(n = 2, farWorkers = 0) {
      const o = await makeOrg(db());
      const ws = [];
      for (let i = 0; i < n; i++)
        ws.push(await makeWorker(db(), o.org.id, { name: `W${i}`, reliability: 0.9 - i * 0.01 }));
      // ~13.7 miles north of the venue: outside the default 10 mile radius
      for (let i = 0; i < farWorkers; i++) {
        ws.push(
          await makeWorker(db(), o.org.id, {
            name: `Far${i}`,
            reliability: 0.5,
            lat: 45.72,
            lng: -122.6765,
          }),
        );
      }
      const { deps, jobs } = testDeps(db(), { now: () => now });
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
      const tokens = new Map<string, string>();
      for (const r of await db().select().from(notifications)) {
        const p = r.payload as { kind?: string; slotId?: string; link?: string };
        if (p.kind === 'offer' && p.slotId === g.slot.id && r.channel === 'email')
          tokens.set(r.recipient.replace('worker:', ''), p.link!.split('/c/')[1]!);
      }
      return { o, ws, deps, jobs, ctx, slotId: g.slot.id, tokens };
    }

    it('decline: records the skip with a timestamp, frees nothing, and the claim of others still works', async () => {
      const s = await offering(2);
      const [a, b] = s.ws as [(typeof s.ws)[0], (typeof s.ws)[0]];
      const r = await declineOffer(s.deps, s.tokens.get(a.id)!);
      expect(r.state).toBe('declined');
      const [o] = await db().select().from(offers).where(eq(offers.workerId, a.id));
      expect(o!.status).toBe('DECLINED');
      expect(o!.declinedAt).toBeInstanceOf(Date);
      expect((await viewOffer(s.deps, s.tokens.get(a.id)!)).state).toBe('declined');
      expect((await claimOffer(s.deps, s.tokens.get(a.id)!)).state).toBe('declined'); // cannot claim after passing
      expect((await claimOffer(s.deps, s.tokens.get(b.id)!)).state).toBe('claimed');
      // deciding twice changes nothing
      expect((await declineOffer(s.deps, s.tokens.get(b.id)!)).state).toBe('claimed');
    });

    it("decline refuses another worker's session", async () => {
      const s = await offering(2);
      const [a, b] = s.ws as [(typeof s.ws)[0], (typeof s.ws)[0]];
      expect(
        (await declineOffer(s.deps, s.tokens.get(a.id)!, { expectedWorkerId: b.id })).state,
      ).toBe('invalid');
    });

    it("view reports the rate the shift was first offered at and the viewer's other open offers", async () => {
      const s = await offering(3);
      await sendWave(s.deps, { slotId: s.slotId, wave: 2 });
      const wave2Worker = (await db().select().from(offers)).find(
        (o) => o.slotId === s.slotId && o.wave === 2,
      );
      expect(wave2Worker).toBeUndefined(); // only 3 workers and wave 1 took them all
      const v = await viewOffer(s.deps, s.tokens.get(s.ws[0]!.id)!);
      expect(v.offer!.firstOfferedRateCents).toBe(2200);
      expect(v.offer!.otherOpenOffersCount).toBe(0);
    });

    it('resend: identical outcome for unknown and known addresses; the old link stops and the new one is outboxed', async () => {
      const s = await offering(1);
      const w = s.ws[0]!;
      const [row] = await db().select().from(workers).where(eq(workers.id, w.id));
      const oldToken = s.tokens.get(w.id)!;
      const unknown = await resendOfferLink(s.deps, 'nobody@example.com');
      expect(unknown.sent).toBe(false);
      const known = await resendOfferLink(s.deps, row!.email.toUpperCase());
      expect(known.sent).toBe(true);
      expect((await viewOffer(s.deps, oldToken)).state).toBe('invalid');
      const msgs = (await db().select().from(notifications)).filter(
        (n) =>
          (n.payload as { kind?: string; slotId?: string }).kind === 'offer_link_resent' &&
          (n.payload as { slotId?: string }).slotId === s.slotId, // this test's slot: other files run in parallel
      );
      expect(msgs).toHaveLength(1);
      const fresh = (msgs[0]!.payload as { link: string }).link.split('/c/')[1]!;
      expect((await viewOffer(s.deps, fresh)).state).toBe('available');
      // a worker without an open offer: nothing is sent, still no error
      expect((await resendOfferLink(s.deps, row!.email)).sent).toBe(true);
      await db().update(offers).set({ status: 'EXPIRED' }).where(eq(offers.workerId, w.id));
      expect((await resendOfferLink(s.deps, row!.email)).sent).toBe(false);
    });

    it('hard radius filter: far workers are not offered at 10 mi, are after widening to 15', async () => {
      const s = await offering(1, 2);
      const farBefore = (await db().select().from(offers).where(eq(offers.slotId, s.slotId)))
        .length;
      expect(farBefore).toBe(1); // only the near worker
      await expect(widenRadius(s.deps, s.ctx, s.slotId, 10)).rejects.toMatchObject({
        code: 'invalid_input',
      }); // not wider
      await expect(widenRadius(s.deps, s.ctx, s.slotId, 99)).rejects.toMatchObject({
        code: 'invalid_input',
      }); // over the max
      const r = await widenRadius(s.deps, s.ctx, s.slotId, 15);
      expect(r.reopened).toBe(false);
      expect((await slotDto(db(), s.ctx.orgId, s.slotId)).search_radius_mi).toBe(15);
      expect(
        s.jobs.some((j) => j.name === 'send_wave' && j.options?.singletonKey?.endsWith(':r15')),
      ).toBe(true);
      await sendWave(s.deps, { slotId: s.slotId, wave: 1 });
      const after = await db().select().from(offers).where(eq(offers.slotId, s.slotId));
      expect(after.length).toBe(3);
    });

    it('widening an UNFILLED gap re-opens it with a fresh payment attempt that needs approval again', async () => {
      const s = await offering(1);
      await fillDeadline(s.deps, { slotId: s.slotId });
      const r = await widenRadius(s.deps, s.ctx, s.slotId, 20);
      expect(r.reopened).toBe(true);
      const [slot] = await db().select().from(shiftSlots).where(eq(shiftSlots.id, s.slotId));
      expect(slot!.status).toBe('OPEN');
      expect(slot!.searchRadiusMi).toBe(20);
      const pays = (await db().select().from(payments).where(eq(payments.slotId, s.slotId))).sort(
        (a, b) => a.attempt - b.attempt,
      );
      expect(pays.map((p) => [p.attempt, p.status])).toEqual([
        [1, 'VOIDED'],
        [2, 'AUTH_PENDING_APPROVAL'],
      ]);
      expect(pays[1]!.authorizedCents).toBe(pays[0]!.authorizedCents);
      // the new attempt can be authorized and offered again
      await stubAuthorize(db(), 'stub', s.slotId);
      await startOffering(s.deps, s.ctx, s.slotId);
      expect(
        (await db().select().from(shiftSlots).where(eq(shiftSlots.id, s.slotId)))[0]!.status,
      ).toBe('OFFERING');
    });

    it('widen refuses slots that are no longer unfilled', async () => {
      const s = await offering(1);
      await claimOffer(s.deps, s.tokens.get(s.ws[0]!.id)!);
      await expect(widenRadius(s.deps, s.ctx, s.slotId, 15)).rejects.toMatchObject({
        code: 'invalid_state',
      });
    });

    it('cancel: offering gap withdraws offers, voids the hold, stamps who/when; confirmed gap also tells the worker', async () => {
      const s = await offering(2);
      const c = await cancelGap(s.deps, s.ctx, s.slotId, 'Plans changed');
      expect(c.status).toBe('CANCELLED');
      expect(c.cancelledBy).toBe(`user:${s.ctx.userId}`);
      expect(c.cancelledAt).toBeInstanceOf(Date);
      const os = await db().select().from(offers).where(eq(offers.slotId, s.slotId));
      expect(os.every((o) => o.status === 'WITHDRAWN' && o.withdrawnAt)).toBe(true);
      expect(
        (await db().select().from(payments).where(eq(payments.slotId, s.slotId)))[0]!.status,
      ).toBe('VOIDED');
      await expect(cancelGap(s.deps, s.ctx, s.slotId)).rejects.toMatchObject({
        code: 'invalid_state',
      }); // not twice

      const s2 = await offering(1);
      const w = s2.ws[0]!;
      await claimOffer(s2.deps, s2.tokens.get(w.id)!);
      await cancelGap(s2.deps, s2.ctx, s2.slotId);
      const told = (await db().select().from(notifications)).filter(
        (n) =>
          n.recipient === `worker:${w.id}` &&
          (n.payload as { kind?: string }).kind === 'shift_cancelled',
      );
      expect(told.length).toBe(3);
    });

    it("cancel and widen are scoped to the manager's organisation", async () => {
      const a = await offering(1);
      const b = await offering(1);
      await expect(cancelGap(a.deps, a.ctx, b.slotId)).rejects.toMatchObject({ code: 'not_found' });
      await expect(widenRadius(a.deps, a.ctx, b.slotId, 15)).rejects.toMatchObject({
        code: 'not_found',
      });
      void venues;
    });
  },
);
