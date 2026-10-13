import { PaypalError } from './client';

/**
 * Maps a PayPal failure to what the payment state machine should do (PLAN.md 4E). The raw PayPal body never leaves
 * the server: `message` is a fixed sentence we wrote, `code` is PayPal's short issue name (safe, not a body).
 */
export type PaypalOutcome =
  | { kind: 'retryable'; code: string; message: string } // buyer or network can retry; no state change that loses money
  | { kind: 'declined'; code: string; message: string } // capture refused: CAPTURE_DECLINED
  | { kind: 'awaiting_approval'; code: string; message: string } // order not approved yet
  | { kind: 'payout_failed'; code: string; message: string } // PAYOUT_FAILED with a clear last_error
  | { kind: 'authorization_gone'; code: string; message: string } // voided/expired: a fresh approval is needed
  | { kind: 'fatal'; code: string; message: string }; // our request was wrong; do not retry unchanged

const code = (e: PaypalError) => e.code ?? e.issues[0]?.issue ?? e.kind;

export function classifyAuthorizeError(e: unknown): PaypalOutcome {
  if (!(e instanceof PaypalError)) return fatal('unknown');
  const c = code(e);
  if (c === 'ORDER_NOT_APPROVED')
    return {
      kind: 'awaiting_approval',
      code: c,
      message: 'The order has not been approved in PayPal yet.',
    };
  if (c === 'PAYER_ACTION_REQUIRED' || c === 'INSTRUMENT_DECLINED')
    return {
      kind: 'retryable',
      code: c,
      message: 'PayPal could not place the hold. Check the funding source in PayPal and try again.',
    };
  if (e.retryable) return retry(c);
  return fatal(c);
}

export function classifyCaptureError(e: unknown): PaypalOutcome {
  if (!(e instanceof PaypalError)) return fatal('unknown');
  const c = code(e);
  if (c === 'INSTRUMENT_DECLINED' || /^PAYER_(ACCOUNT|CANNOT)/.test(c))
    return { kind: 'declined', code: c, message: 'PayPal declined the charge.' };
  if (c === 'AUTHORIZATION_VOIDED' || c === 'AUTHORIZATION_EXPIRED' || c === 'AUTHORIZATION_DENIED')
    return {
      kind: 'authorization_gone',
      code: c,
      message: 'The hold is no longer valid. A fresh approval is needed.',
    };
  if (e.retryable) return retry(c);
  return fatal(c);
}

export function classifyPayoutError(e: unknown): PaypalOutcome {
  if (!(e instanceof PaypalError)) return fatal('unknown');
  const c = code(e);
  if (c === 'INSUFFICIENT_FUNDS' || c === 'AUTHORIZATION_ERROR')
    return {
      kind: 'payout_failed',
      code: c,
      message:
        c === 'INSUFFICIENT_FUNDS'
          ? 'The platform balance is too low to send this payout.'
          : 'PayPal is not authorised to send this payout.',
    };
  // Duplicate sender_batch_id with no link to the original: the payout exists. Never failed, never recreated:
  // stays PAYOUT_PENDING and reconcile resolves it.
  if (e.issues.some((i) => /sender_batch_id already exists/i.test(i.issue ?? ''))) return retry(c);
  if (e.retryable) return retry(c);
  return { kind: 'payout_failed', code: c, message: 'PayPal could not send the payout.' };
}

const retry = (c: string): PaypalOutcome => ({
  kind: 'retryable',
  code: c,
  message: 'PayPal is not reachable right now. This will be retried.',
});
const fatal = (c: string): PaypalOutcome => ({
  kind: 'fatal',
  code: c,
  message: 'PayPal rejected the request.',
});

/** Reason text for a payout item that did not succeed (shown to the manager as last_error). */
export function payoutItemFailure(status: string, errorName?: string): string {
  const base: Record<string, string> = {
    FAILED: 'The payout failed',
    UNCLAIMED: 'The worker has not claimed the payout yet',
    RETURNED: 'The payout was returned',
    ONHOLD: 'The payout is on hold',
    BLOCKED: 'The payout was blocked',
    REFUNDED: 'The payout was refunded',
    REVERSED: 'The payout was reversed',
  };
  const reason = errorName ? ` (${errorName})` : '';
  return `${base[status] ?? 'The payout did not complete'}${reason}.`;
}
