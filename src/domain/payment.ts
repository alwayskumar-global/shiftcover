import { defineMachine } from './machine';
import type { PaymentState } from './states';

/** Section 5 payment machine. */
export const paymentMachine = defineMachine<PaymentState>('payment', {
  NONE: ['AUTH_PENDING_APPROVAL'],
  AUTH_PENDING_APPROVAL: ['AUTHORIZED', 'VOIDED'],
  AUTHORIZED: ['CAPTURED', 'CAPTURE_DECLINED', 'VOIDED'],
  // A declined capture leaves the authorization intact: retry or void.
  CAPTURE_DECLINED: ['CAPTURED', 'VOIDED'],
  CAPTURED: ['PAYOUT_PENDING'],
  PAYOUT_PENDING: ['PAID', 'PAYOUT_FAILED', 'PAYOUT_UNCLAIMED'],
  // Retryable failures go back to PAYOUT_PENDING.
  PAYOUT_FAILED: ['PAYOUT_PENDING'],
  PAYOUT_UNCLAIMED: ['PAID', 'RETURNED'],
  PAID: [],
  VOIDED: [],
  RETURNED: [],
});

export const transitionPayment = paymentMachine.transition;
