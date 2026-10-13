/**
 * Deterministic PayPal-Request-Id values (PLAN.md 11: idempotency keys on every PayPal write). The same operation
 * always derives the same id, so a retry after a timeout or a 5xx cannot create a second order, capture or payout.
 * A genuinely new attempt (a re-approval, a retried declined capture, a retried failed payout) bumps the counter.
 */
export const requestIds = {
  order: (slotId: string, attempt: number) => `order:${slotId}:${attempt}`,
  authorize: (slotId: string, attempt: number) => `auth:${slotId}:${attempt}`,
  capture: (paymentId: string, attempt = 1) =>
    attempt <= 1 ? `capture:${paymentId}` : `capture:${paymentId}:${attempt}`,
  void: (paymentId: string) => `void:${paymentId}`,
  payout: (slotId: string, attempt: number) => `payout:${slotId}:${attempt}`,
};

/** 7.5: a duplicate sender_batch_id inside 30 days is rejected by PayPal, which is what makes a retry safe. */
export const senderBatchIdFor = (paymentId: string, attempt = 1) =>
  attempt <= 1 ? `sc-${paymentId}` : `sc-${paymentId}-${attempt}`;
