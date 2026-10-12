import type { PaypalClient } from './client';

/**
 * PayPal verify-webhook-signature (PLAN.md 7.6). The event is posted back exactly as received:
 * PayPal warns that parse-then-restringify can break verification, so the raw body is spliced
 * into the request JSON without being re-serialized.
 */

const REQUIRED_HEADERS = [
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
] as const;

export interface HeaderReader {
  get(name: string): string | null;
}

export function hasTransmissionHeaders(headers: HeaderReader): boolean {
  return REQUIRED_HEADERS.every((h) => !!headers.get(h));
}

export async function verifyWebhookSignature(
  client: PaypalClient,
  args: { headers: HeaderReader; rawBody: string; webhookId: string },
): Promise<boolean> {
  if (!hasTransmissionHeaders(args.headers)) return false;
  const h = (name: string) => args.headers.get(name) as string;
  const rawBody = JSON.stringify({
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: args.webhookId,
    webhook_event: '__RAW_EVENT__',
  }).replace('"__RAW_EVENT__"', () => args.rawBody);
  const res = await client.request<{ verification_status?: string }>({
    method: 'POST',
    path: '/v1/notifications/verify-webhook-signature',
    rawBody,
    requestId: `verify-${h('paypal-transmission-id')}`,
  });
  return res?.verification_status === 'SUCCESS';
}
