import { PaypalError } from '../paypal/client';

/**
 * Minimal PayPal webhook receiver logic (PLAN.md 7.6). No business logic: verify, store once,
 * enqueue a job, answer fast. Everything with I/O is injected so it is unit-testable.
 * Logging: event id and coarse reasons only. Never the body, headers, ids of accounts, or config names.
 */

export interface WebhookDeps {
  /** undefined when PAYPAL_WEBHOOK_ID / credentials are not configured. */
  verify: ((args: { rawBody: string }) => Promise<boolean>) | undefined;
  /** Insert with ON CONFLICT (event_id) DO NOTHING. Resolves true only if a new row was written. */
  insertEvent: (e: { eventId: string; eventType: string; raw: unknown }) => Promise<boolean>;
  enqueue: (job: { eventId: string; eventType: string }) => Promise<void>;
  log: (message: string) => void;
}

export interface WebhookResult {
  status: 200 | 400 | 502 | 503;
  body: { ok: boolean };
}

const res = (status: WebhookResult['status']): WebhookResult => ({
  status,
  body: { ok: status === 200 },
});

export async function handlePaypalWebhook(
  deps: WebhookDeps,
  rawBody: string,
): Promise<WebhookResult> {
  if (!deps.verify) {
    deps.log('[webhook] config error: webhook verification is not configured');
    return res(503);
  }

  let event: { id?: unknown; event_type?: unknown };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    deps.log('[webhook] rejected: body is not JSON');
    return res(400);
  }
  const eventId = typeof event.id === 'string' && event.id ? event.id : undefined;
  const eventType = typeof event.event_type === 'string' ? event.event_type : 'unknown';
  if (!eventId) {
    deps.log('[webhook] rejected: event has no id');
    return res(400);
  }

  let valid: boolean;
  try {
    valid = await deps.verify({ rawBody });
  } catch (err) {
    // PayPal unreachable / 5xx: ask PayPal to redeliver rather than dropping the event.
    const kind = err instanceof PaypalError ? err.kind : 'error';
    deps.log(`[webhook] verification unavailable event=${eventId} kind=${kind}`);
    return res(502);
  }
  if (!valid) {
    deps.log(`[webhook] invalid signature event=${eventId}`);
    return res(400);
  }

  const inserted = await deps.insertEvent({ eventId, eventType, raw: event });
  if (!inserted) {
    deps.log(`[webhook] replay ignored event=${eventId}`);
    return res(200);
  }

  try {
    await deps.enqueue({ eventId, eventType });
  } catch {
    // Event is stored; the reconciliation job (7.7) is the safety net. Still ack so PayPal does not storm.
    deps.log(`[webhook] enqueue failed event=${eventId}`);
  }
  return res(200);
}
