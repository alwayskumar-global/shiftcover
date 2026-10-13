import type { payments } from '../db/schema';
import { isShiftRole, type ShiftRole } from '../domain/roles';
import type { PaymentState, SlotState } from '../domain/states';
import type { OfferView } from '../services/claim';
import type { PaymentDto, SlotDto, WorkerOfferDto } from './dto';

/** Internal (camelCase, UPPERCASE states) -> public Section 10.6 contract (snake_case, lowercase states). */

export { KM_PER_MILE } from '../domain/matching';
import { KM_PER_MILE } from '../domain/matching';

export const hoursBetween = (start: Date, end: Date) =>
  Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 100) / 100;

export const publicSlotStatus = (s: SlotState): SlotDto['status'] =>
  s.toLowerCase() as SlotDto['status'];

/**
 * DB payment states map 1:1 except PAYOUT_UNCLAIMED and RETURNED, which Section 10.6 does not list; both
 * surface as `payout_failed` (the money did not reach the worker) until the contract lists them.
 */
export function publicPaymentStatus(s: PaymentState): PaymentDto['status'] {
  switch (s) {
    case 'NONE':
      return 'none';
    case 'AUTH_PENDING_APPROVAL':
      return 'awaiting_approval';
    case 'PAYOUT_UNCLAIMED':
    case 'RETURNED':
      return 'payout_failed';
    default:
      return s.toLowerCase() as PaymentDto['status'];
  }
}

export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** Stable decorative tint 1-5 derived from the id (design data-gap: avatar tint). */
export const avatarTint = (id: string) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 5) + 1;
};

export const primaryRole = (skills: readonly string[]): ShiftRole => {
  const r = skills.find(isShiftRole);
  return r ?? 'event_staff';
};

type PaymentRow = typeof payments.$inferSelect;

export function toPaymentDto(p: PaymentRow): PaymentDto {
  return {
    status: publicPaymentStatus(p.status),
    authorized_cents: p.authorizedCents,
    captured_cents: p.capturedCents,
    worker_pay_cents: p.workerPayCents,
    platform_fee_cents: p.platformFeeCents,
    paypal_references: {
      order: p.paypalOrderId,
      authorization: p.authorizationId,
      capture: p.captureId,
      payout: p.payoutBatchId,
    },
    last_error: p.lastError,
  };
}

export function toWorkerOfferDto(view: OfferView): WorkerOfferDto {
  const o = view.offer;
  if (!o) {
    return {
      role: null,
      venue_name: null,
      venue_area: null,
      start_at: null,
      end_at: null,
      hours: null,
      distance_mi: null,
      rate_cents: null,
      pay_total_cents: null,
      expires_at: null,
      state: view.state,
      wave: null,
      server_time: null,
      venue_tz: null,
      venue_address: null,
      venue_lat: null,
      venue_lng: null,
      first_offered_rate_cents: null,
      other_open_offers_count: null,
      payout_ready: null,
    };
  }
  return {
    role: isShiftRole(o.role) ? o.role : null,
    venue_name: o.venueName,
    venue_area: o.venueArea,
    start_at: o.startAt,
    end_at: o.endAt,
    hours: hoursBetween(new Date(o.startAt), new Date(o.endAt)),
    distance_mi: o.distanceKm === null ? null : Math.round((o.distanceKm / KM_PER_MILE) * 10) / 10,
    rate_cents: o.rateCents,
    pay_total_cents: o.estimatedPayCents,
    expires_at: o.expiresAt,
    state: view.state,
    wave: o.wave,
    server_time: o.serverTime,
    venue_tz: o.venueTz,
    venue_address: o.venueAddress,
    venue_lat: o.venueLat,
    venue_lng: o.venueLng,
    first_offered_rate_cents: o.firstOfferedRateCents,
    other_open_offers_count: o.otherOpenOffersCount,
    payout_ready: o.payoutReady,
  };
}
