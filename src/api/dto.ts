import { z } from 'zod';
import { OFFER_STATES, PAYMENT_STATES, SLOT_STATES } from '../domain/states';
import { SHIFT_ROLES } from '../domain/roles';

/**
 * Every M1 request and response DTO, in one module. Money is always integer cents (USD). Timestamps are
 * ISO-8601 UTC strings. Route handlers parse requests and (in tests) responses with these schemas.
 */

const iso = z.iso.datetime();
const cents = z.number().int().nonnegative();
const role = z.enum(SHIFT_ROLES);

// ---------- shared ----------
export const HoldDto = z.object({
  currency: z.literal('USD'),
  maxRateCents: cents,
  maxWorkerPayCents: cents,
  maxFeeCents: cents,
  /** What the employer approves via PayPal: hours x base x (1 + max premium) x (1 + platform fee). */
  authorizedCents: cents,
});
export type HoldDto = z.infer<typeof HoldDto>;

export const ApiError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

// ---------- POST /api/manager/gaps/parse ----------
export const ParseGapRequest = z.object({ text: z.string().trim().min(3).max(500) });

export const ParsedCardDto = z.object({
  source: z.literal('rules'),
  role: role.nullable(),
  roleLabel: z.string().nullable(),
  startAt: iso.nullable(),
  endAt: iso.nullable(),
  baseRateCents: cents.nullable(),
  /** Where the rate came from: stated in the text, copied from the shift being replaced, or absent. */
  baseRateSource: z.enum(['text', 'replaced_shift', 'missing']),
  maxPremiumPct: z.number().int().min(0).max(100),
  maxPremiumSource: z.enum(['text', 'default']),
  calledOutName: z.string().nullable(),
  /** The existing roster shift this gap replaces, when the called-out worker was recognised. */
  replacesSlotId: z.uuid().nullable(),
  venueId: z.uuid(),
  /** Fields the manager must complete before creating the gap. */
  missing: z.array(z.enum(['role', 'time', 'baseRate'])),
  /** Present only when the card is complete. */
  hold: HoldDto.nullable(),
});
export type ParsedCardDto = z.infer<typeof ParsedCardDto>;

// ---------- POST /api/manager/gaps ----------
export const CreateGapRequest = z
  .object({
    venueId: z.uuid(),
    role,
    startAt: iso,
    endAt: iso,
    baseRateCents: z.number().int().positive().max(100_000),
    maxPremiumPct: z.number().int().min(0).max(100),
    replacesSlotId: z.uuid().optional(),
  })
  .refine((v) => Date.parse(v.endAt) > Date.parse(v.startAt), {
    message: 'endAt must be after startAt',
    path: ['endAt'],
  });
export type CreateGapRequest = z.infer<typeof CreateGapRequest>;

export const SlotDto = z.object({
  id: z.uuid(),
  venueId: z.uuid(),
  role,
  roleLabel: z.string(),
  status: z.enum(SLOT_STATES),
  startAt: iso,
  endAt: iso,
  fillBy: iso.nullable(),
  baseRateCents: cents,
  maxPremiumPct: z.number().int(),
  offeredRateCents: cents.nullable(),
  version: z.number().int(),
  worker: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
export type SlotDto = z.infer<typeof SlotDto>;

export const PaymentSummaryDto = z.object({
  status: z.enum(PAYMENT_STATES),
  currency: z.literal('USD'),
  authorizedCents: cents,
  capturedCents: cents,
  workerPayCents: cents,
  platformFeeCents: cents,
});

export const CreateGapResponse = z.object({
  slot: SlotDto,
  hold: HoldDto,
  payment: PaymentSummaryDto,
  /** The parsed-card data the UI shows after creation (same shape the parse endpoint returns, minus hints). */
  card: z.object({
    role,
    roleLabel: z.string(),
    startAt: iso,
    endAt: iso,
    durationMinutes: z.number().int(),
    baseRateCents: cents,
    maxPremiumPct: z.number().int(),
  }),
});
export type CreateGapResponse = z.infer<typeof CreateGapResponse>;

// ---------- GET /api/manager/gaps/[id] ----------
export const OfferRowDto = z.object({
  id: z.uuid(),
  workerId: z.uuid(),
  workerName: z.string(),
  wave: z.number().int(),
  rateCents: cents,
  status: z.enum(OFFER_STATES),
  expiresAt: iso,
  openedAt: iso.nullable(),
  claimedAt: iso.nullable(),
});

export const WaveSummaryDto = z.object({
  wave: z.number().int(),
  rateCents: cents,
  sent: z.number().int(),
  opened: z.number().int(),
  claimed: z.number().int(),
  expired: z.number().int(),
  withdrawn: z.number().int(),
  declined: z.number().int(),
  sentAt: iso,
});

export const GapDetailResponse = z.object({
  slot: SlotDto.extend({ venueName: z.string() }),
  waves: z.array(WaveSummaryDto),
  offers: z.array(OfferRowDto),
  payment: PaymentSummaryDto.nullable(),
});
export type GapDetailResponse = z.infer<typeof GapDetailResponse>;

// ---------- GET /api/manager/roster ----------
export const RosterQuery = z.object({ date: z.iso.date().optional() });

export const RosterResourceDto = z.object({
  id: z.uuid(),
  kind: z.literal('worker'),
  name: z.string(),
  initials: z.string(),
  roles: z.array(z.string()),
  reliabilityScore: z.number(),
});

export const RosterEventDto = z.object({
  id: z.uuid(),
  /** null = nobody assigned (an open gap): the UI renders these on its "open gaps" row. */
  resourceId: z.uuid().nullable(),
  workerName: z.string().nullable(),
  role,
  roleLabel: z.string(),
  status: z.enum(SLOT_STATES),
  /** True while the slot still needs a worker (OPEN, OFFERING or UNFILLED). */
  isGap: z.boolean(),
  startDate: iso,
  endDate: iso,
  baseRateCents: cents,
  offeredRateCents: cents.nullable(),
});

export const RosterResponse = z.object({
  date: z.iso.date(),
  timezone: z.string(),
  venue: z.object({ id: z.uuid(), name: z.string() }),
  summary: z.object({
    openGaps: z.number().int(),
    offering: z.number().int(),
    shiftsToday: z.number().int(),
  }),
  resources: z.array(RosterResourceDto),
  events: z.array(RosterEventDto),
});
export type RosterResponse = z.infer<typeof RosterResponse>;

// ---------- GET /api/c/[token], POST /api/c/[token]/claim ----------
export const OfferStateDto = z.enum([
  'available',
  'claimed',
  'taken',
  'expired',
  'withdrawn',
  'invalid',
]);

export const OfferViewResponse = z.object({
  state: OfferStateDto,
  offer: z
    .object({
      role,
      roleLabel: z.string(),
      venueName: z.string(),
      startAt: iso,
      endAt: iso,
      rateCents: cents,
      estimatedPayCents: cents,
      distanceKm: z.number().nullable(),
      expiresAt: iso,
      wave: z.number().int(),
    })
    .nullable(),
});
export type OfferViewResponse = z.infer<typeof OfferViewResponse>;

export const ClaimResponse = OfferViewResponse.extend({ slotId: z.uuid().nullable() });
export type ClaimResponse = z.infer<typeof ClaimResponse>;

// ---------- GET /api/w/shifts ----------
export const WorkerShiftsResponse = z.object({
  shifts: z.array(
    z.object({
      offerId: z.uuid(),
      offerStatus: z.enum(OFFER_STATES),
      rateCents: cents,
      expiresAt: iso,
      slotId: z.uuid(),
      slotStatus: z.enum(SLOT_STATES),
      role,
      startAt: iso,
      endAt: iso,
      venueName: z.string(),
      isMine: z.boolean(),
    }),
  ),
});

// ---------- gap actions ----------
export const StartOfferingResponse = z.object({ slot: SlotDto });
export const StubAuthorizeResponse = z.object({ payment: PaymentSummaryDto });
