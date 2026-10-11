/** Section 5 state vocabularies. Single source of truth for the domain code and DB enums. */

export const SLOT_STATES = [
  'PLANNED',
  'OPEN',
  'OFFERING',
  'CONFIRMED',
  'IN_PROGRESS',
  'PENDING_APPROVAL',
  'SETTLING',
  'SETTLED',
  'UNFILLED',
  'CANCELLED',
  'NO_SHOW',
] as const;
export type SlotState = (typeof SLOT_STATES)[number];

export const OFFER_STATES = [
  'SENT',
  'OPENED',
  'CLAIMED',
  'DECLINED',
  'EXPIRED',
  'WITHDRAWN',
] as const;
export type OfferState = (typeof OFFER_STATES)[number];

export const PAYMENT_STATES = [
  'NONE',
  'AUTH_PENDING_APPROVAL',
  'AUTHORIZED',
  'CAPTURED',
  'PAYOUT_PENDING',
  'PAID',
  'VOIDED',
  'CAPTURE_DECLINED',
  'PAYOUT_FAILED',
  'PAYOUT_UNCLAIMED',
  'RETURNED',
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];
