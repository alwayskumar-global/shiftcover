import { and, asc, eq, gte, inArray, lt, max, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  avatarTint,
  hoursBetween,
  initialsOf,
  primaryRole,
  publicSlotStatus,
  toPaymentDto,
} from '../api/adapters';
import type {
  GapDetailResponse,
  OfferDto,
  RosterResponse,
  SlotDto,
  WaveSummaryDto,
} from '../api/dto';
import { MATCHING, WAVES } from '../config/matching';
import { offers, shiftSlots, venues, workers } from '../db/schema';
import { rankCandidates } from '../domain/matching';
import { isShiftRole } from '../domain/roles';
import { addDaysToDateString, localDateString, localDayBounds, localWeekKey } from '../lib/time';
import { loadCandidates, loadGapFacts } from './candidates';
import { latestPayment } from './payment-queries';
import { ServiceError, type DbLike } from './types';

type SlotRow = typeof shiftSlots.$inferSelect;
type VenueRow = typeof venues.$inferSelect;
type WorkerRow = typeof workers.$inferSelect;

const slotRole = (r: string) => (isShiftRole(r) ? r : 'event_staff');

const workerRef = (w: Pick<WorkerRow, 'id' | 'name' | 'skills'>) => ({
  id: w.id,
  name: w.name,
  role: primaryRole(w.skills),
  initials: initialsOf(w.name),
  avatar_tint: avatarTint(w.id),
});

/** Public Section 10.6 Slot (plus the documented additive fields) from rows. */
export function toSlotDto(
  slot: SlotRow,
  venue: Pick<VenueRow, 'name' | 'area' | 'timezone' | 'searchRadiusMi'>,
  worker: Pick<WorkerRow, 'id' | 'name' | 'skills'> | null,
  replacesWorker: Pick<WorkerRow, 'id' | 'name'> | null = null,
  currentWave: number | null = null,
): SlotDto {
  return {
    id: slot.id,
    role: slotRole(slot.role),
    venue_name: venue.name,
    venue_area: venue.area,
    start_at: slot.startAt.toISOString(),
    end_at: slot.endAt.toISOString(),
    hours: hoursBetween(slot.startAt, slot.endAt),
    status: publicSlotStatus(slot.status),
    worker: worker ? workerRef(worker) : null,
    base_rate_cents: slot.baseRateCents,
    max_premium_pct: slot.maxPremiumPct,
    offered_rate_cents: slot.offeredRateCents,
    fill_by: slot.fillBy?.toISOString() ?? null,
    venue_tz: venue.timezone,
    gap_reason: slot.gapReason,
    replaces_worker: replacesWorker ? { id: replacesWorker.id, name: replacesWorker.name } : null,
    search_radius_mi: slot.searchRadiusMi ?? venue.searchRadiusMi,
    current_wave: currentWave === 1 || currentWave === 2 || currentWave === 3 ? currentWave : null,
    cancelled_at: slot.cancelledAt?.toISOString() ?? null,
    cancelled_by: slot.cancelledBy,
  };
}

/** Highest wave sent per slot, for the given slots. */
async function currentWaves(h: DbLike, slotIds: string[]) {
  if (slotIds.length === 0) return new Map<string, number>();
  const rows = await h
    .select({ slotId: offers.slotId, wave: max(offers.wave) })
    .from(offers)
    .where(inArray(offers.slotId, slotIds))
    .groupBy(offers.slotId);
  return new Map(rows.map((r) => [r.slotId, r.wave ?? 0]));
}

export async function primaryVenue(h: DbLike, orgId: string) {
  const [v] = await h
    .select()
    .from(venues)
    .where(eq(venues.orgId, orgId))
    .orderBy(asc(venues.createdAt))
    .limit(1);
  if (!v) throw new ServiceError('not_found', 'no venue for this organisation');
  return v;
}

const replacedSlot = alias(shiftSlots, 'replaced_slot');
const replacedWorker = alias(workers, 'replaced_worker');

/** One slot (org-scoped) as a public Slot DTO. */
export async function slotDto(h: DbLike, orgId: string, slotId: string): Promise<SlotDto> {
  const [row] = await h
    .select({ slot: shiftSlots, venue: venues, worker: workers, rw: replacedWorker })
    .from(shiftSlots)
    .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
    .leftJoin(workers, eq(workers.id, shiftSlots.workerId))
    .leftJoin(replacedSlot, eq(replacedSlot.id, shiftSlots.replacesSlotId))
    .leftJoin(replacedWorker, eq(replacedWorker.id, replacedSlot.workerId))
    .where(and(eq(shiftSlots.id, slotId), eq(venues.orgId, orgId)));
  if (!row) throw new ServiceError('not_found', 'gap not found');
  const waves = await currentWaves(h, [slotId]);
  return toSlotDto(row.slot, row.venue, row.worker, row.rw, waves.get(slotId) ?? null);
}

export async function paymentDto(h: DbLike, slotId: string) {
  const pay = await latestPayment(h, slotId);
  return pay ? toPaymentDto(pay) : null;
}

/** Roster for one venue-local day, shaped for the Bryntum Scheduler (resources + events + summary). */
export async function roster(
  h: DbLike,
  orgId: string,
  date: string | undefined,
  now: Date,
  days: 1 | 7 = 1,
): Promise<RosterResponse> {
  const venue = await primaryVenue(h, orgId);
  const anchor = date ?? localDateString(now, venue.timezone);
  // Week = Monday to Sunday containing the anchor day, in venue-local time.
  const first =
    days === 7
      ? localWeekKey(localDayBounds(anchor, venue.timezone).start, venue.timezone)
      : anchor;
  const last = addDaysToDateString(first, days - 1);
  const start = localDayBounds(first, venue.timezone).start;
  const end = localDayBounds(last, venue.timezone).end;
  const day = first;

  const ws = await h
    .select()
    .from(workers)
    .where(and(eq(workers.orgId, orgId), inArray(workers.status, ['active', 'invited'])))
    .orderBy(asc(workers.name));
  const rows = await h
    .select({ slot: shiftSlots, worker: workers, rw: replacedWorker })
    .from(shiftSlots)
    .leftJoin(workers, eq(workers.id, shiftSlots.workerId))
    .leftJoin(replacedSlot, eq(replacedSlot.id, shiftSlots.replacesSlotId))
    .leftJoin(replacedWorker, eq(replacedWorker.id, replacedSlot.workerId))
    .where(
      and(
        eq(shiftSlots.venueId, venue.id),
        lt(shiftSlots.startAt, end),
        gte(shiftSlots.endAt, start),
      ),
    )
    .orderBy(asc(shiftSlots.startAt));

  const waves = await currentWaves(
    h,
    rows.map((r) => r.slot.id),
  );
  const live = rows.filter((r) => r.slot.status !== 'CANCELLED');
  const assigned = ['CONFIRMED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'SETTLING', 'SETTLED'];
  return {
    date: day,
    end_date: last,
    timezone: venue.timezone,
    server_time: now.toISOString(),
    resources: ws.map((w) => workerRef(w)),
    events: rows.map((r) => toSlotDto(r.slot, venue, r.worker, r.rw, waves.get(r.slot.id) ?? null)),
    summary: {
      open_gaps: live.filter((r) => r.slot.status === 'OPEN').length,
      offering: live.filter((r) => r.slot.status === 'OFFERING').length,
      shifts_today: live.filter((r) => assigned.includes(r.slot.status)).length,
    },
  };
}

export async function gapDetail(
  h: DbLike,
  orgId: string,
  slotId: string,
  now: Date,
): Promise<GapDetailResponse> {
  const slot = await slotDto(h, orgId, slotId);
  const [slotRow] = await h.select().from(shiftSlots).where(eq(shiftSlots.id, slotId));

  const os = await h
    .select({ offer: offers, worker: workers })
    .from(offers)
    .innerJoin(workers, eq(workers.id, offers.workerId))
    .where(eq(offers.slotId, slotId))
    .orderBy(asc(offers.wave), asc(offers.createdAt));

  const waveNums = [...new Set(os.map((o) => o.offer.wave))];
  const waves: WaveSummaryDto[] = waveNums.map((wave) => {
    const rows = os.filter((o) => o.offer.wave === wave).map((o) => o.offer);
    const plan = WAVES.find((w) => w.wave === wave);
    const count = (s: string) => rows.filter((o) => o.status === s).length;
    return {
      wave,
      sent_at: rows
        .reduce((min, o) => (o.createdAt < min ? o.createdAt : min), rows[0]!.createdAt)
        .toISOString(),
      audience_count: rows.length,
      rate_cents: rows[0]!.rateCents,
      capped: !!plan && plan.premiumPct > slotRow!.maxPremiumPct,
      opened_count: rows.filter((o) => o.openedAt !== null).length,
      declined_count: count('DECLINED'),
      expired_count: count('EXPIRED'),
      withdrawn_count: count('WITHDRAWN'),
    };
  });

  const offerDtos: OfferDto[] = os.map(({ offer, worker }) => ({
    id: offer.id,
    worker: {
      name: worker.name,
      role: primaryRole(worker.skills),
      initials: initialsOf(worker.name),
      avatar_tint: avatarTint(worker.id),
    },
    wave: offer.wave,
    rate_cents: offer.rateCents,
    status: offer.status.toLowerCase() as OfferDto['status'],
    sent_at: offer.createdAt.toISOString(),
    opened_at: offer.openedAt?.toISOString() ?? null,
    claimed_at: offer.claimedAt?.toISOString() ?? null,
    expires_at: offer.expiresAt.toISOString(),
    declined_at: offer.declinedAt?.toISOString() ?? null,
    expired_at: offer.expiredAt?.toISOString() ?? null,
    withdrawn_at: offer.withdrawnAt?.toISOString() ?? null,
  }));

  // How many more workers the maximum radius would reach (only meaningful while the gap is unfilled).
  let preview = 0;
  if (['OPEN', 'OFFERING', 'UNFILLED'].includes(slotRow!.status)) {
    const gap = await loadGapFacts(h, slotRow!);
    const cands = await loadCandidates(h, slotRow!, gap);
    const at = (radiusMi: number) =>
      rankCandidates(cands, { ...gap, radiusMi }, MATCHING).ranked.length;
    preview = Math.max(0, at(MATCHING.maxSearchRadiusMi) - at(slot.search_radius_mi));
  }

  return {
    server_time: now.toISOString(),
    widen: {
      radius_mi: slot.search_radius_mi,
      max_radius_mi: MATCHING.maxSearchRadiusMi,
      preview_count: preview,
    },
    slot,
    waves,
    offers: offerDtos,
    payment: await paymentDto(h, slotId),
  };
}

export async function findRecognisedSlot(
  h: DbLike,
  orgId: string,
  venueId: string,
  firstName: string,
  window: { start: Date; end: Date } | null,
  day: { start: Date; end: Date },
) {
  const rows = await h
    .select({ slot: shiftSlots, name: workers.name })
    .from(shiftSlots)
    .innerJoin(workers, eq(workers.id, shiftSlots.workerId))
    .where(
      and(
        eq(shiftSlots.venueId, venueId),
        eq(workers.orgId, orgId),
        eq(shiftSlots.status, 'CONFIRMED'),
        sql`lower(${workers.name}) like ${firstName.toLowerCase() + ' %'}`,
        lt(shiftSlots.startAt, window?.end ?? day.end),
        gte(shiftSlots.endAt, window?.start ?? day.start),
      ),
    )
    .orderBy(asc(shiftSlots.startAt));
  return rows[0]?.slot ?? null;
}
