import { and, eq, inArray, ne } from 'drizzle-orm';
import { WAVES } from '../config/matching';
import { offers, shiftSlots, users, venues } from '../db/schema';
import { maxRateCents } from '../domain/money';
import { ROLE_LABELS, isShiftRole } from '../domain/roles';
import { generateToken, hashToken } from '../lib/tokens';
import { matchForSlot } from './candidates';
import { stubVoid } from './payments-stub';
import { moveOffer, moveSlot } from './transitions';
import type { ServiceDeps, Tx } from './types';

/** Hourly rate for a wave: base + wave premium, never above the slot's own cap (PLAN.md 8). */
export function waveRateCents(
  baseRateCents: number,
  maxPremiumPct: number,
  wavePremiumPct: number,
): number {
  return maxRateCents(baseRateCents, Math.min(wavePremiumPct, maxPremiumPct));
}

export const offerLink = (appBaseUrl: string, token: string) =>
  `${appBaseUrl.replace(/\/+$/, '')}/c/${token}`;

/** Managers of the org that owns this venue, for notifications. */
export async function managersForVenue(tx: Tx, venueId: string) {
  const [v] = await tx.select({ orgId: venues.orgId }).from(venues).where(eq(venues.id, venueId));
  if (!v) return [];
  return tx.select({ id: users.id }).from(users).where(eq(users.orgId, v.orgId));
}

/**
 * Send one wave. Idempotent and safe to re-run: offers are unique per (slot, worker, wave), only newly
 * inserted offers get a token and a notification, and follow-up jobs use singleton keys.
 */
export async function sendWave(deps: ServiceDeps, input: { slotId: string; wave: number }) {
  const plan = WAVES.find((w) => w.wave === input.wave);
  if (!plan) return { sent: 0, reason: 'unknown_wave' as const };
  const { config } = deps;
  const now = deps.now();

  const outcome = await deps.db.transaction(async (tx) => {
    const [slot] = await tx
      .select()
      .from(shiftSlots)
      .where(eq(shiftSlots.id, input.slotId))
      .for('update');
    if (!slot || slot.status !== 'OFFERING')
      return { sent: 0, reason: 'slot_not_offering' as const, created: [] };

    const match = await matchForSlot(tx, slot);
    // Exclude workers offered in OTHER waves. Same-wave workers stay in the audience so a re-run
    // recomputes the same list and the unique index turns it into a no-op.
    const existing = await tx
      .select({ workerId: offers.workerId })
      .from(offers)
      .where(and(eq(offers.slotId, slot.id), ne(offers.wave, input.wave)));
    const already = new Set(existing.map((o) => o.workerId));
    const audience = match.ranked
      .filter((c) => !already.has(c.workerId))
      .slice(0, Number.isFinite(plan.audience) ? plan.audience : undefined);

    const rate = waveRateCents(slot.baseRateCents, slot.maxPremiumPct, plan.premiumPct);
    const expiresAt = new Date(now.getTime() + config.offerTtlSeconds * 1000);
    const [venue] = await tx.select().from(venues).where(eq(venues.id, slot.venueId));
    const created: Array<{ offerId: string }> = [];

    for (const cand of audience) {
      const token = generateToken();
      const inserted = await tx
        .insert(offers)
        .values({
          slotId: slot.id,
          workerId: cand.workerId,
          wave: input.wave,
          rateCents: rate,
          tokenHash: hashToken(token, config.tokenPepper),
          expiresAt,
          status: 'SENT',
        })
        .onConflictDoNothing()
        .returning({ id: offers.id });
      if (inserted.length === 0) continue; // already offered in this wave: no second token, no second message
      const offerId = inserted[0]!.id;
      created.push({ offerId });
      await deps.notifier(tx).send({
        recipient: `worker:${cand.workerId}`,
        channels: ['in_app', 'email', 'push'],
        kind: 'offer',
        payload: {
          offerId,
          slotId: slot.id,
          wave: input.wave,
          rateCents: rate,
          role: slot.role,
          roleLabel: isShiftRole(slot.role) ? ROLE_LABELS[slot.role] : slot.role,
          venueName: venue?.name ?? null,
          startAt: slot.startAt.toISOString(),
          endAt: slot.endAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          link: offerLink(config.appBaseUrl, token),
        },
      });
    }
    if (created.length > 0) {
      await tx.update(shiftSlots).set({ offeredRateCents: rate }).where(eq(shiftSlots.id, slot.id));
    }
    return { sent: created.length, reason: 'ok' as const, created };
  });

  if (outcome.reason === 'ok') {
    for (const o of outcome.created) {
      await deps.enqueue(
        'expire_offer',
        { offerId: o.offerId },
        { singletonKey: `expire:${o.offerId}`, startAfter: config.offerTtlSeconds + 1 },
      );
    }
    if (input.wave < WAVES.length) {
      await deps.enqueue(
        'send_wave',
        { slotId: input.slotId, wave: input.wave + 1 },
        {
          singletonKey: `wave:${input.slotId}:${input.wave + 1}`,
          startAfter: config.waveIntervalSeconds,
        },
      );
    }
  }
  return { sent: outcome.sent, reason: outcome.reason };
}

/** Expire a single offer if it is still open and past its expiry. */
export async function expireOffer(deps: ServiceDeps, input: { offerId: string }) {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const [o] = await tx.select().from(offers).where(eq(offers.id, input.offerId)).for('update');
    if (!o || !['SENT', 'OPENED'].includes(o.status) || o.expiresAt > now) return false;
    await moveOffer(tx, o.id, 'EXPIRED', { actor: 'system:expire_offer' });
    return true;
  });
}

/**
 * At fill_by: an unfilled OFFERING slot becomes UNFILLED, open offers are withdrawn, the authorization is
 * voided (stub in M1) and managers are told. Re-running changes nothing.
 */
export async function fillDeadline(deps: ServiceDeps, input: { slotId: string }) {
  const actor = 'system:fill_deadline';
  return deps.db.transaction(async (tx) => {
    const [slot] = await tx
      .select()
      .from(shiftSlots)
      .where(eq(shiftSlots.id, input.slotId))
      .for('update');
    if (!slot || slot.status !== 'OFFERING') return false;
    await moveSlot(tx, slot.id, 'UNFILLED', { actor });
    const open = await tx
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.slotId, slot.id), inArray(offers.status, ['SENT', 'OPENED'])));
    for (const o of open)
      await moveOffer(tx, o.id, 'WITHDRAWN', { actor, meta: { reason: 'unfilled' } });
    await stubVoid(tx, slot.id, actor);
    for (const m of await managersForVenue(tx, slot.venueId)) {
      await deps.notifier(tx).send({
        recipient: `manager:${m.id}`,
        channels: ['in_app', 'email'],
        kind: 'gap_unfilled',
        payload: { slotId: slot.id, role: slot.role, startAt: slot.startAt.toISOString() },
      });
    }
    return true;
  });
}
