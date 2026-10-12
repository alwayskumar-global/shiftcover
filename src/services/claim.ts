import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { offers, shiftSlots, venues, workers } from '../db/schema';
import { slotMachine } from '../domain/slot';
import { payForMinutesCents } from '../domain/money';
import { ROLE_LABELS, isShiftRole } from '../domain/roles';
import { haversineKm } from '../domain/matching';
import { hashToken } from '../lib/tokens';
import { managersForVenue } from './offers';
import { moveOffer, writeAudit } from './transitions';
import type { ServiceDeps } from './types';

export type OfferState = 'available' | 'claimed' | 'taken' | 'expired' | 'withdrawn' | 'invalid';

export interface OfferView {
  state: OfferState;
  /** Present for every state except `invalid`. Never contains other workers' data. */
  offer?: {
    workerId: string;
    role: string;
    roleLabel: string;
    venueName: string;
    venueArea: string;
    startAt: string;
    endAt: string;
    rateCents: number;
    /** What the worker earns for the full shift at this rate (before any hours adjustment). */
    estimatedPayCents: number;
    distanceKm: number | null;
    expiresAt: string;
    wave: number;
  };
}

async function loadByToken(deps: ServiceDeps, token: string) {
  const hash = hashToken(token, deps.config.tokenPepper);
  const [row] = await deps.db
    .select({ offer: offers, slot: shiftSlots, venue: venues, worker: workers })
    .from(offers)
    .innerJoin(shiftSlots, eq(shiftSlots.id, offers.slotId))
    .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
    .innerJoin(workers, eq(workers.id, offers.workerId))
    .where(eq(offers.tokenHash, hash));
  return row;
}

type Loaded = NonNullable<Awaited<ReturnType<typeof loadByToken>>>;

function toView(r: Loaded, now: Date): OfferView {
  const { offer: o, slot, venue, worker } = r;
  const minutes = Math.round((slot.endAt.getTime() - slot.startAt.getTime()) / 60_000);
  const dto: OfferView['offer'] = {
    workerId: worker.id,
    role: slot.role,
    roleLabel: isShiftRole(slot.role) ? ROLE_LABELS[slot.role] : slot.role,
    venueName: venue.name,
    venueArea: venue.area,
    startAt: slot.startAt.toISOString(),
    endAt: slot.endAt.toISOString(),
    rateCents: o.rateCents,
    estimatedPayCents: payForMinutesCents(o.rateCents, minutes),
    distanceKm:
      worker.homeLat === null || worker.homeLng === null
        ? null
        : Math.round(haversineKm(worker.homeLat, worker.homeLng, venue.lat, venue.lng) * 10) / 10,
    expiresAt: o.expiresAt.toISOString(),
    wave: o.wave,
  };
  let state: OfferState;
  if (o.status === 'CLAIMED') state = 'claimed';
  else if (
    o.status === 'EXPIRED' ||
    ((o.status === 'SENT' || o.status === 'OPENED') && o.expiresAt <= now)
  )
    state = 'expired';
  else if (o.status === 'WITHDRAWN' || o.status === 'DECLINED') {
    state = slot.status === 'CONFIRMED' && slot.workerId !== worker.id ? 'taken' : 'withdrawn';
  } else if (slot.status !== 'OFFERING') {
    state = slot.status === 'CONFIRMED' ? 'taken' : 'withdrawn';
  } else state = 'available';
  return { state, offer: dto };
}

/** Read-only: NEVER writes and never consumes the token (email scanners prefetch links). */
export async function viewOffer(deps: ServiceDeps, token: string): Promise<OfferView> {
  const r = await loadByToken(deps, token);
  if (!r) return { state: 'invalid' };
  return toView(r, deps.now());
}

export type ClaimResult = OfferView & { slotId?: string };

class Abort extends Error {
  constructor(readonly result: ClaimResult) {
    super('abort');
  }
}

/** The guarded slot update matched no row: the transaction is abandoned and the true state is re-derived. */
class Lost extends Error {
  constructor() {
    super('lost');
  }
}

/**
 * Atomic first-claim-wins (PLAN.md 6). One transaction: validate token + expiry, take the slot row with
 * `UPDATE ... WHERE status = 'OFFERING'`, then open/claim this offer, withdraw the rest, audit, notify.
 * Lock order is always slot first, offers second, so concurrent claimers cannot deadlock.
 * `expectedWorkerId` (from the worker session cookie, when present) must match the offer's worker.
 */
export async function claimOffer(
  deps: ServiceDeps,
  token: string,
  opts: { expectedWorkerId?: string } = {},
): Promise<ClaimResult> {
  const pre = await loadByToken(deps, token);
  if (!pre) return { state: 'invalid' };
  if (opts.expectedWorkerId && opts.expectedWorkerId !== pre.worker.id) return { state: 'invalid' };
  const now = deps.now();
  const view = toView(pre, now);
  if (view.state === 'claimed') return { ...view, slotId: pre.slot.id }; // idempotent for the same worker
  if (view.state !== 'available') return view;

  const actor = `worker:${pre.worker.id}`;
  try {
    return await deps.db.transaction(async (tx) => {
      // 1. The atomic claim. Zero rows = someone else got there first (or the slot left OFFERING).
      const won = await tx
        .update(shiftSlots)
        .set({
          status: 'CONFIRMED',
          workerId: pre.worker.id,
          offeredRateCents: pre.offer.rateCents,
          version: sql`${shiftSlots.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(shiftSlots.id, pre.slot.id), eq(shiftSlots.status, 'OFFERING')))
        .returning({ id: shiftSlots.id });
      if (won.length === 0) throw new Lost();

      // 2. Our offer must still be open (an expiry job may have run since the pre-read).
      const [cur] = await tx.select().from(offers).where(eq(offers.id, pre.offer.id)).for('update');
      if (!cur || !['SENT', 'OPENED'].includes(cur.status) || cur.expiresAt <= now) {
        throw new Abort({ state: 'expired', offer: view.offer });
      }
      if (cur.status === 'SENT')
        await moveOffer(tx, cur.id, 'OPENED', { actor }, { openedAt: now });
      await moveOffer(tx, cur.id, 'CLAIMED', { actor }, { claimedAt: now });

      // 3. Audit the slot transition through the state machine definition.
      const t = slotMachine.transition('OFFERING', 'CONFIRMED', {
        entityId: pre.slot.id,
        actor,
        meta: { offerId: cur.id, workerId: pre.worker.id },
      });
      await writeAudit(tx, t.audit);

      // 4. Withdraw every other open offer on this slot.
      const others = await tx
        .select({ id: offers.id })
        .from(offers)
        .where(
          and(
            eq(offers.slotId, pre.slot.id),
            ne(offers.id, cur.id),
            inArray(offers.status, ['SENT', 'OPENED']),
          ),
        )
        .for('update');
      for (const o of others)
        await moveOffer(tx, o.id, 'WITHDRAWN', { actor, meta: { reason: 'slot_claimed' } });

      // 5. Notifications.
      const n = deps.notifier(tx);
      await n.send({
        recipient: `worker:${pre.worker.id}`,
        channels: ['in_app', 'email', 'push'],
        kind: 'claim_won',
        payload: {
          slotId: pre.slot.id,
          role: pre.slot.role,
          venueName: pre.venue.name,
          startAt: pre.slot.startAt.toISOString(),
          endAt: pre.slot.endAt.toISOString(),
          rateCents: cur.rateCents,
        },
      });
      for (const m of await managersForVenue(tx, pre.slot.venueId)) {
        await n.send({
          recipient: `manager:${m.id}`,
          channels: ['in_app', 'email'],
          kind: 'claim_manager',
          payload: {
            slotId: pre.slot.id,
            workerId: pre.worker.id,
            workerName: pre.worker.name,
            role: pre.slot.role,
          },
        });
      }
      return { state: 'claimed' as const, slotId: pre.slot.id, offer: view.offer };
    });
  } catch (e) {
    if (e instanceof Abort) return e.result;
    if (e instanceof Lost) {
      // Zero rows means the slot was no longer OFFERING. That is not always "taken": a fill deadline, a
      // cancellation, an expiry or this worker's own concurrent claim may have got there first. Re-read the
      // committed state and report what a worker should actually be told.
      const fresh = await loadByToken(deps, token);
      if (!fresh) return { state: 'invalid' };
      const result: ClaimResult = toView(fresh, deps.now());
      if (result.state === 'claimed') result.slotId = fresh.slot.id;
      return result;
    }
    throw e;
  }
}
