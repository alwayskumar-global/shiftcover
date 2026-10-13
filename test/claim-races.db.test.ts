import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { notifications, offers, payments, shiftSlots } from '../src/db/schema';
import { claimOffer } from '../src/services/claim';
import { createGap, startOffering } from '../src/services/gaps';
import { expireOffer, fillDeadline, sendWave } from '../src/services/offers';
import { stubAuthorize } from '../src/services/payments-stub';
import { moveSlot } from '../src/services/transitions';
import type { ServiceDeps } from '../src/services/types';
import { createTestDb, hasTestDb } from './db';
import { makeOrg, makeWorker, testDeps } from './factories';

const startAt = new Date('2026-10-14T14:00:00Z');
const endAt = new Date('2026-10-14T22:00:00Z');
const now = new Date('2026-10-14T13:40:00Z');

describe.skipIf(!hasTestDb)(
  'claim races: the final state a worker sees is accurate (live Postgres)',
  () => {
    const t = hasTestDb ? createTestDb(30) : undefined;
    afterAll(() => t?.close());
    const db = () => t!.db;

    async function offeringSlot(n = 2) {
      const o = await makeOrg(db());
      const ws = [];
      for (let i = 0; i < n; i++)
        ws.push(await makeWorker(db(), o.org.id, { name: `W${i}`, reliability: 0.9 - i * 0.01 }));
      const { deps } = testDeps(db(), { now: () => now });
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
      return { o, ws, deps, ctx, slotId: g.slot.id, tokens };
    }

    /** Deps whose transaction() first runs `hook`, i.e. exactly between the claim's pre-read and its guarded update. */
    function withHook(deps: ServiceDeps, hook: () => Promise<unknown>): ServiceDeps {
      const real = deps.db;
      const wrapped = new Proxy(real, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          if (prop === 'transaction') {
            return async (...a: unknown[]) => {
              await hook();
              return (v as (...x: unknown[]) => unknown).apply(target, a);
            };
          }
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }) as Db;
      return { ...deps, db: wrapped };
    }

    const slotRow = async (id: string) =>
      (await db().select().from(shiftSlots).where(eq(shiftSlots.id, id)))[0]!;
    const payRow = async (slotId: string) =>
      (await db().select().from(payments).where(eq(payments.slotId, slotId)))[0]!;

    it('fill deadline lands between pre-read and claim: worker is told "withdrawn", never "taken"', async () => {
      const s = await offeringSlot();
      const w = s.ws[0]!;
      const racing = withHook(s.deps, () => fillDeadline(s.deps, { slotId: s.slotId }));
      const r = await claimOffer(racing, s.tokens.get(w.id)!);
      expect(r.state).toBe('withdrawn');
      expect((await slotRow(s.slotId)).status).toBe('UNFILLED');
      expect((await slotRow(s.slotId)).workerId).toBeNull();
      expect((await payRow(s.slotId)).status).toBe('VOIDED');
    });

    it('manager cancellation between pre-read and claim: "withdrawn"', async () => {
      const s = await offeringSlot();
      const racing = withHook(s.deps, () =>
        db().transaction((tx) => moveSlot(tx, s.slotId, 'CANCELLED', { actor: 'user:test' })),
      );
      const r = await claimOffer(racing, s.tokens.get(s.ws[0]!.id)!);
      expect(r.state).toBe('withdrawn');
      expect((await slotRow(s.slotId)).status).toBe('CANCELLED');
    });

    it('another worker wins between pre-read and claim: "taken", and the winner keeps the slot', async () => {
      const s = await offeringSlot(2);
      const [a, b] = s.ws as [(typeof s.ws)[0], (typeof s.ws)[0]];
      const racing = withHook(s.deps, async () => {
        expect((await claimOffer(s.deps, s.tokens.get(b.id)!)).state).toBe('claimed');
      });
      const r = await claimOffer(racing, s.tokens.get(a.id)!);
      expect(r.state).toBe('taken');
      expect((await slotRow(s.slotId)).workerId).toBe(b.id);
    });

    it('the same worker double-submits: both calls report "claimed", one transition happens', async () => {
      const s = await offeringSlot(1);
      const w = s.ws[0]!;
      const racing = withHook(s.deps, async () => {
        expect((await claimOffer(s.deps, s.tokens.get(w.id)!)).state).toBe('claimed');
      });
      const r = await claimOffer(racing, s.tokens.get(w.id)!);
      expect(r.state).toBe('claimed');
      expect(r.slotId).toBe(s.slotId);
      const claimed = (await db().select().from(offers).where(eq(offers.slotId, s.slotId))).filter(
        (o) => o.status === 'CLAIMED',
      );
      expect(claimed).toHaveLength(1);
    });

    it('offer expires after the pre-read: "expired", slot untouched', async () => {
      const s = await offeringSlot(1);
      const w = s.ws[0]!;
      const later = testDeps(db(), { now: () => new Date(now.getTime() + 16 * 60_000) }).deps;
      const [o] = await db().select().from(offers).where(eq(offers.slotId, s.slotId));
      const racing = withHook(s.deps, async () => {
        await expireOffer(later, { offerId: o!.id });
      });
      const r = await claimOffer(racing, s.tokens.get(w.id)!);
      expect(r.state).toBe('expired');
      expect((await slotRow(s.slotId)).status).toBe('OFFERING');
    });

    it('claim vs fill deadline, truly concurrent, 25 rounds: exactly one outcome, always consistent', async () => {
      let claimedRounds = 0;
      let unfilledRounds = 0;
      for (let i = 0; i < 25; i++) {
        const s = await offeringSlot(1);
        const w = s.ws[0]!;
        const [claim, deadline] = await Promise.all([
          claimOffer(s.deps, s.tokens.get(w.id)!),
          fillDeadline(s.deps, { slotId: s.slotId }),
        ]);
        const slot = await slotRow(s.slotId);
        const pay = await payRow(s.slotId);
        if (claim.state === 'claimed') {
          claimedRounds++;
          expect(deadline).toBe(false);
          expect(slot.status).toBe('CONFIRMED');
          expect(slot.workerId).toBe(w.id);
          expect(pay.status).toBe('AUTHORIZED');
        } else {
          unfilledRounds++;
          expect(claim.state).toBe('withdrawn'); // never "taken": nobody else claimed
          expect(deadline).toBe(true);
          expect(slot.status).toBe('UNFILLED');
          expect(pay.status).toBe('VOIDED');
        }
      }
      expect(claimedRounds + unfilledRounds).toBe(25);
    });
  },
);
