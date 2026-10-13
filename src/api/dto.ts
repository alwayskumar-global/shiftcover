import { z } from 'zod';
import { SHIFT_ROLES } from '../domain/roles';

/**
 * PUBLIC API contract (PLAN.md Section 10.6). External JSON is snake_case with lowercase status values.
 * Money is integer cents (USD); timestamps are ISO-8601 UTC. Response schemas are `.strict()` so a field that
 * is not listed in Section 10.6 (or in docs/api-m1.md "Deviations") fails the contract test.
 * Internal TypeScript/database names stay camelCase/uppercase; src/api/adapters.ts maps between the two.
 */

const iso = z.iso.datetime();
const cents = z.number().int().nonnegative();
const role = z.enum(SHIFT_ROLES);

export const SLOT_STATUS_PUBLIC = [
  'planned',
  'open',
  'offering',
  'confirmed',
  'in_progress',
  'pending_approval',
  'settling',
  'settled',
  'unfilled',
  'cancelled',
  'no_show',
] as const;
export const OFFER_STATUS_PUBLIC = [
  'sent',
  'opened',
  'claimed',
  'declined',
  'expired',
  'withdrawn',
] as const;
export const PAYMENT_STATUS_PUBLIC = [
  'none',
  'awaiting_approval',
  'authorized',
  'captured',
  'payout_pending',
  'paid',
  'voided',
  'capture_declined',
  'payout_failed',
] as const;
/** Worker-facing offer states. 'claimed' is an additive value (see docs/api-m1.md, Deviations). */
export const OFFER_VIEW_STATE = [
  'available',
  'claimed',
  'declined',
  'taken',
  'expired',
  'withdrawn',
  'invalid',
] as const;

export const ApiError = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .strict();

// ---------------------------------------------------------------- 10.6 Slot
/** `initials` and `avatar_tint` (1-5) are additive (design data-gap: stable avatar). */
export const WorkerRefDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    role,
    initials: z.string(),
    avatar_tint: z.number().int().min(1).max(5),
  })
  .strict();

export const SlotDto = z
  .object({
    id: z.uuid(),
    role,
    venue_name: z.string(),
    venue_area: z.string(),
    start_at: iso,
    end_at: iso,
    hours: z.number().positive(),
    status: z.enum(SLOT_STATUS_PUBLIC),
    worker: WorkerRefDto.nullable(),
    base_rate_cents: cents,
    max_premium_pct: z.number().int().min(0).max(100),
    offered_rate_cents: cents.nullable(),
    fill_by: iso.nullable(),
    // ---- additive (docs/api-m1.md Deviations) ----
    venue_tz: z.string(),
    gap_reason: z.string().nullable(),
    replaces_worker: z.object({ id: z.uuid(), name: z.string() }).strict().nullable(),
    search_radius_mi: z.number().int().positive(),
    /** Highest wave sent so far (offering slots; null before the first wave). */
    current_wave: z.number().int().min(1).max(3).nullable(),
    cancelled_at: iso.nullable(),
    cancelled_by: z.string().nullable(),
  })
  .strict();
export type SlotDto = z.infer<typeof SlotDto>;

// ---------------------------------------------------------------- 10.6 Offer
export const OfferDto = z
  .object({
    id: z.uuid(),
    worker: z
      .object({
        name: z.string(),
        role,
        initials: z.string(),
        avatar_tint: z.number().int().min(1).max(5),
      })
      .strict(),
    wave: z.number().int().min(1).max(3),
    rate_cents: cents,
    status: z.enum(OFFER_STATUS_PUBLIC),
    sent_at: iso,
    opened_at: iso.nullable(),
    claimed_at: iso.nullable(),
    expires_at: iso,
    // ---- additive ----
    declined_at: iso.nullable(),
    expired_at: iso.nullable(),
    withdrawn_at: iso.nullable(),
  })
  .strict();
export type OfferDto = z.infer<typeof OfferDto>;

// ---------------------------------------------------------------- 10.6 Wave summary
export const WaveSummaryDto = z
  .object({
    wave: z.number().int().min(1).max(3),
    sent_at: iso,
    audience_count: z.number().int().nonnegative(),
    rate_cents: cents,
    /** True when the slot's max premium clamped this wave's rate below its planned premium. */
    capped: z.boolean(),
    // ---- additive: outcome counts for the wave results line ----
    opened_count: z.number().int().nonnegative(),
    declined_count: z.number().int().nonnegative(),
    expired_count: z.number().int().nonnegative(),
    withdrawn_count: z.number().int().nonnegative(),
  })
  .strict();
export type WaveSummaryDto = z.infer<typeof WaveSummaryDto>;

// ---------------------------------------------------------------- 10.6 Payment
export const PaymentDto = z
  .object({
    status: z.enum(PAYMENT_STATUS_PUBLIC),
    authorized_cents: cents,
    captured_cents: cents,
    worker_pay_cents: cents,
    platform_fee_cents: cents,
    paypal_references: z
      .object({
        order: z.string().nullable(),
        authorization: z.string().nullable(),
        capture: z.string().nullable(),
        payout: z.string().nullable(),
      })
      .strict(),
    last_error: z.string().nullable(),
  })
  .strict();
export type PaymentDto = z.infer<typeof PaymentDto>;

// ---------------------------------------------------------------- 10.6 Worker-facing offer
export const WorkerOfferDto = z
  .object({
    role: role.nullable(),
    venue_name: z.string().nullable(),
    venue_area: z.string().nullable(),
    start_at: iso.nullable(),
    end_at: iso.nullable(),
    hours: z.number().positive().nullable(),
    distance_mi: z.number().nonnegative().nullable(),
    rate_cents: cents.nullable(),
    pay_total_cents: cents.nullable(),
    expires_at: iso.nullable(),
    state: z.enum(OFFER_VIEW_STATE),
    // ---- additive (docs/api-m1.md Deviations) ----
    wave: z.number().int().min(1).max(3).nullable(),
    server_time: iso.nullable(),
    venue_tz: z.string().nullable(),
    venue_address: z.string().nullable(),
    venue_lat: z.number().nullable(),
    venue_lng: z.number().nullable(),
    first_offered_rate_cents: cents.nullable(),
    other_open_offers_count: z.number().int().nonnegative().nullable(),
    payout_ready: z.boolean().nullable(),
  })
  .strict();
export type WorkerOfferDto = z.infer<typeof WorkerOfferDto>;

// ---------------------------------------------------------------- 10.6 Roster
/** `days=7` returns the Monday-to-Sunday week containing `date` (additive: the Week toggle). */
export const RosterQuery = z.object({
  date: z.iso.date().optional(),
  days: z.enum(['1', '7']).optional(),
});

export const RosterResourceDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    role,
    initials: z.string(),
    avatar_tint: z.number().int().min(1).max(5),
  })
  .strict();

export const RosterResponse = z
  .object({
    /** Additive (Deviations): the venue-local day shown and its IANA zone, needed to render UTC timestamps. */
    date: z.iso.date(),
    /** Additive: last day of the range (equals `date` for a single day). */
    end_date: z.iso.date(),
    timezone: z.string(),
    server_time: iso,
    resources: z.array(RosterResourceDto),
    events: z.array(SlotDto),
    summary: z
      .object({
        open_gaps: z.number().int().nonnegative(),
        offering: z.number().int().nonnegative(),
        shifts_today: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type RosterResponse = z.infer<typeof RosterResponse>;

// ---------------------------------------------------------------- 10.6 Parse result (report a gap)
export const ParseGapRequest = z.object({ text: z.string().trim().min(3).max(500) }).strict();

export const ParseResultDto = z
  .object({
    source: z.enum(['rules', 'llm']),
    role: role.nullable(),
    /** Venue-local calendar date YYYY-MM-DD. */
    date: z.iso.date().nullable(),
    /** Venue-local clock time HH:MM (24h). */
    start: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable(),
    end: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable(),
    venue: z.object({ id: z.uuid(), name: z.string() }).strict(),
    base_rate_cents: cents.nullable(),
    /** Additive: where the rate came from, so the UI can show the "Role default" tag. */
    base_rate_source: z.enum(['text', 'replaced_shift', 'role_default']).nullable(),
    max_premium_pct: z.number().int().min(0).max(100),
    /** Computed money; null until role, times and rate are all known. */
    worker_pay_at_cap_cents: cents.nullable(),
    platform_fee_cents: cents.nullable(),
    total_hold_cents: cents.nullable(),
    // ---- additive (Deviations): what the manager must still fill in, and who called out ----
    missing: z.array(z.enum(['role', 'time', 'base_rate'])),
    replaces_slot_id: z.uuid().nullable(),
    called_out_name: z.string().nullable(),
    gap_reason: z.string().nullable(),
    /** Exact instants so the UI can POST without re-deriving them from date + start/end + zone. */
    start_at: iso.nullable(),
    end_at: iso.nullable(),
  })
  .strict();
export type ParseResultDto = z.infer<typeof ParseResultDto>;

// ---------------------------------------------------------------- requests and envelopes (not itemised in 10.6)
export const CreateGapRequest = z
  .object({
    venue_id: z.uuid(),
    role,
    start_at: iso,
    end_at: iso,
    base_rate_cents: z.number().int().positive().max(100_000),
    max_premium_pct: z.number().int().min(0).max(100),
    replaces_slot_id: z.uuid().optional(),
    /** Why the gap exists, e.g. called_in_sick. */
    gap_reason: z.string().trim().min(1).max(60).optional(),
  })
  .strict()
  .refine((v) => Date.parse(v.end_at) > Date.parse(v.start_at), {
    message: 'end_at must be after start_at',
    path: ['end_at'],
  });
export type CreateGapRequest = z.infer<typeof CreateGapRequest>;

export const HoldDto = z
  .object({
    worker_pay_at_cap_cents: cents,
    platform_fee_cents: cents,
    total_hold_cents: cents,
  })
  .strict();
export type HoldDto = z.infer<typeof HoldDto>;

export const CreateGapResponse = z
  .object({ slot: SlotDto, payment: PaymentDto, hold: HoldDto })
  .strict();
export type CreateGapResponse = z.infer<typeof CreateGapResponse>;

export const GapDetailResponse = z
  .object({
    server_time: iso,
    /** Additive: current and maximum search radius, and how many more workers the maximum would reach. */
    widen: z
      .object({
        radius_mi: z.number().int(),
        max_radius_mi: z.number().int(),
        preview_count: z.number().int().nonnegative(),
      })
      .strict(),
    slot: SlotDto,
    waves: z.array(WaveSummaryDto),
    offers: z.array(OfferDto),
    payment: PaymentDto.nullable(),
  })
  .strict();
export type GapDetailResponse = z.infer<typeof GapDetailResponse>;

export const StartOfferingResponse = z.object({ slot: SlotDto }).strict();
export const StubAuthorizeResponse = z.object({ payment: PaymentDto }).strict();

/** Claim result = the worker-facing offer after the attempt (state `claimed` on success). */
export const ClaimResponse = WorkerOfferDto;

// ---------------------------------------------------------------- GET /api/w/shifts (not a Gate 1 screen)
export const WorkerShiftsResponse = z
  .object({
    shifts: z.array(
      z
        .object({
          offer_id: z.uuid(),
          offer_status: z.enum(OFFER_STATUS_PUBLIC),
          rate_cents: cents,
          expires_at: iso,
          slot_id: z.uuid(),
          slot_status: z.enum(SLOT_STATUS_PUBLIC),
          role,
          start_at: iso,
          end_at: iso,
          venue_name: z.string(),
          is_mine: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

// ---------------------------------------------------------------- manager: me / config (additive endpoint)
export const MeResponse = z
  .object({
    manager: z.object({ email: z.string(), name: z.string(), role: z.literal('manager') }).strict(),
    org: z.object({ name: z.string() }).strict(),
    venue: z
      .object({
        id: z.uuid(),
        name: z.string(),
        area: z.string(),
        address: z.string(),
        timezone: z.string(),
      })
      .strict(),
    config: z
      .object({
        platform_fee_pct: z.number(),
        /** Additive: optional flat fee per shift (cents), on top of the percentage; 0 when none. */
        platform_fixed_fee_cents: z.number().int().nonnegative(),
        premium_min_pct: z.number().int(),
        premium_max_pct: z.number().int(),
        max_days_ahead: z.number().int(),
        link_ttl_minutes: z.number().int(),
        role_default_rate_cents: z.record(z.string(), cents),
        paypal_env: z.literal('sandbox'),
        payments_mode: z.enum(['paypal', 'stub']),
      })
      .strict(),
  })
  .strict();
export type MeResponse = z.infer<typeof MeResponse>;

// ---------------------------------------------------------------- actions (additive endpoints)
export const WidenRadiusRequest = z
  .object({ search_radius_mi: z.number().int().min(1).max(100) })
  .strict();
export const WidenRadiusResponse = z.object({ slot: SlotDto, reopened: z.boolean() }).strict();
export const CancelGapRequest = z
  .object({ reason: z.string().trim().max(200).optional() })
  .strict();
export const CancelGapResponse = z.object({ slot: SlotDto }).strict();
export const ResendLinkRequest = z.object({ email: z.email().max(254) }).strict();
/** Identical for known and unknown addresses. */
export const ResendLinkResponse = z.object({ ok: z.literal(true) }).strict();

// ---------------------------------------------------------------- M2 money endpoints (additive; not itemised in 10.6)
export const OrderResponse = z.object({ order_id: z.string().min(1) }).strict();
export const AuthorizeRequest = z.object({ order_id: z.string().min(1).max(64) }).strict();
export const AuthorizeResponse = z.object({ payment: PaymentDto, slot: SlotDto }).strict();

export const ApproveAndPayRequest = z
  .object({ approved_hours: z.number().positive().max(24) })
  .strict();
export const ApproveAndPayResponse = z
  .object({
    slot: SlotDto,
    payment: PaymentDto,
    capture_cents: cents,
    worker_pay_cents: cents,
    platform_fee_cents: cents,
  })
  .strict();

export const NoShowResponse = z.object({ slot: SlotDto, reoffered: z.boolean() }).strict();
export const ConfirmTimesRequest = z
  .object({ check_in_at: iso, check_out_at: iso.optional() })
  .strict();
export const ConfirmTimesResponse = z.object({ slot: SlotDto }).strict();

/** Worker shift-day result: only what the worker needs; no location data exists to return. */
export const ShiftDayResponse = z
  .object({
    slot_id: z.uuid(),
    status: z.enum(SLOT_STATUS_PUBLIC),
    check_in_at: iso.nullable(),
    check_out_at: iso.nullable(),
    actual_hours: z.number().nonnegative().nullable(),
  })
  .strict();
