import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { auditLog, notifications, offers, shiftSlots } from '../src/db/schema';
import { hashToken } from '../src/lib/tokens';
import { claimOffer, viewOffer } from '../src/services/claim';
import { createGap, startOffering } from '../src/services/gaps';
import { sendWave } from '../src/services/offers';
import { stubAuthorize } from '../src/services/payments-stub';
import { workerShifts } from '../src/services/worker-data';
import { createTestDb, hasTestDb } from './db';
import { makeOrg, makeWorker, PEPPER, testDeps } from './factories';

describe.skipIf(!hasTestDb)('worker claim (live Postgres)', () => {
  const t = hasTestDb ? createTestDb(30) : undefined;
  afterAll(() => t?.close());
  const db = () => t!.db;

  const startAt = new Date('2026-10-14T14:00:00Z');
  const endAt = new Date('2026-10-14T22:00:00Z');
  const now = new Date('2026-10-14T13:40:00Z');

  /** An OFFERING slot with `n` workers who each hold a wave-3-style offer + raw token. */
  async function offeringSlot(n: number, nowFn = () => now) {
    const o = await makeOrg(db());
    const ws = [];
    for (let i = 0; i < n; i++)
      ws.push(await makeWorker(db(), o.org.id, { name: `W${i}`, reliability: 0.9 - i * 0.001 }));
    const { deps, jobs } = testDeps(db(), { now: nowFn });
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
    for (const wave of [1, 2, 3]) await sendWave(deps, { slotId: g.slot.id, wave });
    const rows = await db().select().from(notifications);
    const tokens = new Map<string, string>(); // workerId -> raw token
    for (const r of rows) {
      const p = r.payload as { kind?: string; slotId?: string; link?: string };
      if (p.kind === 'offer' && p.slotId === g.slot.id && r.channel === 'email') {
        tokens.set(r.recipient.replace('worker:', ''), p.link!.split('/c/')[1]!);
      }
    }
    return { o, ws, deps, jobs, slotId: g.slot.id, tokens };
  }

  it('ACCEPTANCE 1: 20 concurrent claims on one slot yield exactly one CONFIRMED', async () => {
    const s = await offeringSlot(20);
    expect(s.tokens.size).toBe(20);
    const results = await Promise.all(s.ws.map((w) => claimOffer(s.deps, s.tokens.get(w.id)!)));
    const claimed = results.filter((r) => r.state === 'claimed');
    const taken = results.filter((r) => r.state === 'taken');
    expect(claimed).toHaveLength(1);
    expect(taken).toHaveLength(19); // clean "taken", never a thrown error
    const [slot] = await db().select().from(shiftSlots).where(eq(shiftSlots.id, s.slotId));
    expect(slot!.status).toBe('CONFIRMED');
    const winnerOffer = (
      await db().select().from(offers).where(eq(offers.slotId, s.slotId))
    ).filter((o) => o.status === 'CLAIMED');
    expect(winnerOffer).toHaveLength(1);
    expect(slot!.workerId).toBe(winnerOffer[0]!.workerId);
    // every other offer was withdrawn
    const rest = (await db().select().from(offers).where(eq(offers.slotId, s.slotId))).filter(
      (o) => o.status !== 'CLAIMED',
    );
    expect(rest.every((o) => o.status === 'WITHDRAWN')).toBe(true);
    expect(slot!.version).toBe(3); // PLANNED->OPEN, OPEN->OFFERING, OFFERING->CONFIRMED
  });

  it('claim writes audit rows, notifies the winner and the manager, and bumps the version', async () => {
    const s = await offeringSlot(2);
    const w = s.ws[0]!;
    const before = (await db().select().from(shiftSlots).where(eq(shiftSlots.id, s.slotId)))[0]!;
    const r = await claimOffer(s.deps, s.tokens.get(w.id)!);
    expect(r.state).toBe('claimed');
    const after = (await db().select().from(shiftSlots).where(eq(shiftSlots.id, s.slotId)))[0]!;
    expect(after.version).toBe(before.version + 1);
    expect(after.offeredRateCents).toBeGreaterThan(0);
    const audits = (await db().select().from(auditLog).where(eq(auditLog.entityId, s.slotId))).map(
      (a) => a.action,
    );
    expect(audits).toContain('shift_slot.OFFERING->CONFIRMED');
    const msgs = (await db().select().from(notifications)).map(
      (n) => `${n.recipient}|${(n.payload as { kind?: string }).kind}`,
    );
    expect(msgs).toContain(`worker:${w.id}|claim_won`);
    expect(msgs).toContain(`manager:${s.o.manager.id}|claim_manager`);
  });

  it('a second claimer gets "taken", the winner is idempotent, and nothing throws', async () => {
    const s = await offeringSlot(2);
    const [a, b] = s.ws as [(typeof s.ws)[0], (typeof s.ws)[0]];
    expect((await claimOffer(s.deps, s.tokens.get(a.id)!)).state).toBe('claimed');
    expect((await claimOffer(s.deps, s.tokens.get(b.id)!)).state).toBe('taken');
    expect((await claimOffer(s.deps, s.tokens.get(a.id)!)).state).toBe('claimed'); // same worker again
    expect((await viewOffer(s.deps, s.tokens.get(b.id)!)).state).toBe('taken');
    expect((await viewOffer(s.deps, s.tokens.get(a.id)!)).state).toBe('claimed');
  });

  it('ACCEPTANCE 5: GET (viewOffer) never consumes a token and never writes', async () => {
    const s = await offeringSlot(1);
    const w = s.ws[0]!;
    const tok = s.tokens.get(w.id)!;
    const snapshot = async () =>
      JSON.stringify([
        await db().select().from(offers).where(eq(offers.slotId, s.slotId)),
        await db().select().from(shiftSlots).where(eq(shiftSlots.id, s.slotId)),
        (await db().select().from(auditLog).where(eq(auditLog.entityId, s.slotId))).length, // this slot only: other tests share the DB
      ]);
    const before = await snapshot();
    for (let i = 0; i < 5; i++) expect((await viewOffer(s.deps, tok)).state).toBe('available');
    expect(await snapshot()).toBe(before);
    expect((await claimOffer(s.deps, tok)).state).toBe('claimed'); // still claimable after many GETs
  });

  it('ACCEPTANCE 5: tampered, truncated, wrong-pepper and unknown tokens are invalid', async () => {
    const s = await offeringSlot(1);
    const tok = s.tokens.get(s.ws[0]!.id)!;
    const flipped = tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A');
    for (const bad of [
      flipped,
      tok.slice(0, 20),
      '',
      'x'.repeat(43),
      tok + 'x',
      tok.toLowerCase() === tok ? tok.toUpperCase() : tok.toLowerCase(),
    ]) {
      expect((await viewOffer(s.deps, bad)).state).toBe('invalid');
      expect((await claimOffer(s.deps, bad)).state).toBe('invalid');
    }
    // the stored value is a peppered hash: the hash of the raw token without the pepper must not match
    const rows = await db().select().from(offers).where(eq(offers.slotId, s.slotId));
    expect(rows[0]!.tokenHash).toBe(hashToken(tok, PEPPER));
    expect(rows[0]!.tokenHash).not.toBe(hashToken(tok, 'other-pepper'));
    expect((await claimOffer(s.deps, tok)).state).toBe('claimed');
  });

  it('ACCEPTANCE 5: a used token cannot be replayed by another session', async () => {
    const s = await offeringSlot(2);
    const [a, b] = s.ws as [(typeof s.ws)[0], (typeof s.ws)[0]];
    expect((await claimOffer(s.deps, s.tokens.get(a.id)!, { expectedWorkerId: a.id })).state).toBe(
      'claimed',
    );
    // B's session cookie presented with A's token is rejected outright
    expect((await claimOffer(s.deps, s.tokens.get(a.id)!, { expectedWorkerId: b.id })).state).toBe(
      'invalid',
    );
  });

  it('expired offers fail (view and claim) and the slot stays OFFERING', async () => {
    const s = await offeringSlot(1);
    const tok = s.tokens.get(s.ws[0]!.id)!;
    const late = testDeps(db(), { now: () => new Date(now.getTime() + 16 * 60_000) }).deps;
    expect((await viewOffer(late, tok)).state).toBe('expired');
    expect((await claimOffer(late, tok)).state).toBe('expired');
    const [slot] = await db().select().from(shiftSlots).where(eq(shiftSlots.id, s.slotId));
    expect(slot!.status).toBe('OFFERING');
  });

  it('a claim on a withdrawn offer (slot no longer offering) is withdrawn, not a 500', async () => {
    const s = await offeringSlot(1);
    await db().update(shiftSlots).set({ status: 'UNFILLED' }).where(eq(shiftSlots.id, s.slotId));
    const tok = s.tokens.get(s.ws[0]!.id)!;
    expect((await claimOffer(s.deps, tok)).state).toBe('withdrawn');
  });

  it("ACCEPTANCE 9: worker A cannot read worker B's data", async () => {
    const s = await offeringSlot(3);
    const [a, b] = s.ws as [(typeof s.ws)[0], (typeof s.ws)[0]];
    const mineA = await workerShifts(db(), a.id);
    const mineB = await workerShifts(db(), b.id);
    expect(mineA).toHaveLength(1);
    expect(mineB).toHaveLength(1);
    const idsA = new Set(mineA.map((x) => x.offerId));
    for (const x of mineB) expect(idsA.has(x.offerId)).toBe(false);
    // A's offer view never exposes B's identity or pay
    const view = await viewOffer(s.deps, s.tokens.get(a.id)!);
    expect(view.offer!.workerId).toBe(a.id);
    expect(JSON.stringify(view)).not.toContain(b.id);
    expect(JSON.stringify(view)).not.toContain(b.name + ' ');
  });
});
