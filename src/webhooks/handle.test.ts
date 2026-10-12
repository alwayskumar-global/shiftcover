import { describe, expect, it, vi } from 'vitest';
import { createPaypalClient } from '../paypal/client';
import { verifyWebhookSignature } from '../paypal/webhooks';
import { handlePaypalWebhook, type WebhookDeps } from './handle';

// Raw body with deliberately awkward formatting: it must reach PayPal byte-for-byte.
const RAW = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED",  "amount": 1.10, "n":1e3}';

const HEADERS = new Headers({
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': 'tx-1',
  'paypal-transmission-sig': 'sig-SECRETISH',
  'paypal-transmission-time': '2026-10-12T10:00:00Z',
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fake PayPal: token endpoint + verify endpoint returning `status`. */
function fakePaypal(verificationStatus: 'SUCCESS' | 'FAILURE' | 'DOWN') {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: typeof init?.body === 'string' ? init.body : undefined });
    if (u.endsWith('/v1/oauth2/token')) return json({ access_token: 't', expires_in: 3600 });
    if (verificationStatus === 'DOWN') return json({ name: 'INTERNAL_SERVICE_ERROR' }, 500);
    return json({ verification_status: verificationStatus });
  });
  const client = createPaypalClient({
    clientId: 'id',
    clientSecret: 'secret',
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, calls };
}

function harness(
  verificationStatus: 'SUCCESS' | 'FAILURE' | 'DOWN',
  opts: { configured?: boolean } = {},
) {
  const { client, calls } = fakePaypal(verificationStatus);
  const stored = new Set<string>();
  const enqueued: Array<{ eventId: string; eventType: string }> = [];
  const logs: string[] = [];
  const deps: WebhookDeps = {
    verify:
      opts.configured === false
        ? undefined
        : ({ rawBody }) =>
            verifyWebhookSignature(client, {
              headers: HEADERS,
              rawBody,
              webhookId: 'WEBHOOK-ID-1',
            }),
    insertEvent: async ({ eventId }) => {
      if (stored.has(eventId)) return false; // ON CONFLICT DO NOTHING
      stored.add(eventId);
      return true;
    },
    enqueue: async (j) => {
      enqueued.push(j);
    },
    log: (m) => logs.push(m),
  };
  return { deps, calls, stored, enqueued, logs };
}

describe('POST /api/webhooks/paypal handler', () => {
  it('valid signature: stores once, enqueues, returns 200', async () => {
    const h = harness('SUCCESS');
    const r = await handlePaypalWebhook(h.deps, RAW);
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect([...h.stored]).toEqual(['WH-1']);
    expect(h.enqueued).toEqual([{ eventId: 'WH-1', eventType: 'PAYMENT.CAPTURE.COMPLETED' }]);
  });

  it('posts the raw event to PayPal byte-for-byte with the transmission fields', async () => {
    const h = harness('SUCCESS');
    await handlePaypalWebhook(h.deps, RAW);
    const verifyCall = h.calls.find((c) =>
      c.url.endsWith('/v1/notifications/verify-webhook-signature'),
    )!;
    expect(verifyCall.body).toContain(`"webhook_event":${RAW}`);
    const parsed = JSON.parse(verifyCall.body!);
    expect(parsed).toMatchObject({
      auth_algo: 'SHA256withRSA',
      transmission_id: 'tx-1',
      transmission_time: '2026-10-12T10:00:00Z',
      webhook_id: 'WEBHOOK-ID-1',
    });
  });

  it('invalid signature: 400, nothing stored or enqueued, logs event id only', async () => {
    const h = harness('FAILURE');
    const r = await handlePaypalWebhook(h.deps, RAW);
    expect(r).toEqual({ status: 400, body: { ok: false } });
    expect(h.stored.size).toBe(0);
    expect(h.enqueued).toEqual([]);
    expect(h.logs.join('\n')).toContain('WH-1');
    expect(h.logs.join('\n')).not.toMatch(/sig-SECRETISH|amount|WEBHOOK-ID-1|tx-1/);
  });

  it('missing transmission headers count as an invalid signature', async () => {
    const { client } = fakePaypal('SUCCESS');
    const ok = await verifyWebhookSignature(client, {
      headers: new Headers(),
      rawBody: RAW,
      webhookId: 'W',
    });
    expect(ok).toBe(false);
  });

  it('replay: second delivery changes nothing and enqueues nothing', async () => {
    const h = harness('SUCCESS');
    await handlePaypalWebhook(h.deps, RAW);
    const again = await handlePaypalWebhook(h.deps, RAW);
    await handlePaypalWebhook(h.deps, RAW);
    expect(again.status).toBe(200);
    expect(h.stored.size).toBe(1);
    expect(h.enqueued).toHaveLength(1);
  });

  it('missing config: 503 with a name-free response; logs server-side; no PayPal call', async () => {
    const h = harness('SUCCESS', { configured: false });
    const r = await handlePaypalWebhook(h.deps, RAW);
    expect(r).toEqual({ status: 503, body: { ok: false } });
    expect(JSON.stringify(r)).not.toMatch(/PAYPAL|WEBHOOK_ID/);
    expect(h.logs).toHaveLength(1);
    expect(h.calls).toHaveLength(0);
    expect(h.stored.size).toBe(0);
  });

  it('PayPal verification outage: 502 so PayPal retries; nothing stored', async () => {
    const h = harness('DOWN');
    const r = await handlePaypalWebhook(h.deps, RAW);
    expect(r.status).toBe(502);
    expect(h.stored.size).toBe(0);
  });

  it('rejects non-JSON and id-less bodies without calling PayPal', async () => {
    const h = harness('SUCCESS');
    expect((await handlePaypalWebhook(h.deps, 'not json')).status).toBe(400);
    expect((await handlePaypalWebhook(h.deps, '{"event_type":"X"}')).status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it('still acks when the enqueue fails (event is stored; reconcile is the safety net)', async () => {
    const h = harness('SUCCESS');
    h.deps.enqueue = async () => {
      throw new Error('queue down');
    };
    const r = await handlePaypalWebhook(h.deps, RAW);
    expect(r.status).toBe(200);
    expect(h.stored.has('WH-1')).toBe(true);
    expect(h.logs.join()).toContain('enqueue failed event=WH-1');
  });
});
