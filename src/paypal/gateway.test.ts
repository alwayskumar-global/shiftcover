import { describe, expect, it, vi } from 'vitest';
import { createPaypalClient, PaypalError } from './client';
import {
  classifyAuthorizeError,
  classifyCaptureError,
  classifyPayoutError,
  payoutItemFailure,
} from './errors';
import { createPaypalGateway } from './gateway';
import { requestIds, senderBatchIdFor } from './ids';

/**
 * Every PayPal call the money flows make, against a recording fetch: the exact path, method, headers (idempotency
 * key, Prefer) and JSON body, using the field names from PayPal's current API reference (docs/paypal-m2.md).
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(routes: Record<string, (body: unknown) => Response>) {
  const calls: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/oauth2/token') return json({ access_token: 'tok', expires_in: 3600 });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      headers: init?.headers as Record<string, string>,
      body,
    });
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const route = routes[key];
    if (!route) return json({ name: 'RESOURCE_NOT_FOUND' }, 404);
    return route(body);
  });
  const client = createPaypalClient({
    clientId: 'id',
    clientSecret: 'secret',
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { gw: createPaypalGateway(client, { platformEmail: 'platform@example.com' }), calls };
}

const SLOT = '11111111-1111-4111-8111-111111111111';
const PAY = '22222222-2222-4222-8222-222222222222';

describe('request ids', () => {
  it('are deterministic per operation and bump only for a new attempt', () => {
    expect(requestIds.order(SLOT, 1)).toBe(`order:${SLOT}:1`);
    expect(requestIds.authorize(SLOT, 2)).toBe(`auth:${SLOT}:2`);
    expect(requestIds.capture(PAY)).toBe(`capture:${PAY}`);
    expect(requestIds.capture(PAY, 1)).toBe(`capture:${PAY}`);
    expect(requestIds.capture(PAY, 2)).toBe(`capture:${PAY}:2`);
    expect(requestIds.void(PAY)).toBe(`void:${PAY}`);
    expect(requestIds.payout(SLOT, 1)).toBe(`payout:${SLOT}:1`);
    expect(senderBatchIdFor(PAY)).toBe(`sc-${PAY}`);
    expect(senderBatchIdFor(PAY, 3)).toBe(`sc-${PAY}-3`);
  });
});

describe('PayPal gateway requests', () => {
  it('createOrder: POST /v2/checkout/orders, intent AUTHORIZE, one purchase unit, custom_id, invoice_id, request id', async () => {
    const { gw, calls } = setup({
      'POST /v2/checkout/orders': () => json({ id: 'ORD1', status: 'CREATED' }, 201),
    });
    const r = await gw.createOrder({ slotId: SLOT, attempt: 2, maxCents: 22176 });
    expect(r).toEqual({ orderId: 'ORD1', status: 'CREATED' });
    const c = calls[0]!;
    expect(c.headers['PayPal-Request-Id']).toBe(`order:${SLOT}:2`);
    expect(c.headers.Authorization).toBe('Bearer tok');
    expect(c.body).toEqual({
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          custom_id: SLOT,
          invoice_id: `${SLOT}-2`,
          amount: { currency_code: 'USD', value: '221.76' },
        },
      ],
    });
    expect((c.body as { purchase_units: unknown[] }).purchase_units).toHaveLength(1);
  });

  it('getOrder: GET with the order id and reads the authorization', async () => {
    const { gw, calls } = setup({
      'GET /v2/checkout/orders/ORD1': () =>
        json({
          id: 'ORD1',
          status: 'COMPLETED',
          purchase_units: [
            {
              payments: {
                authorizations: [
                  {
                    id: 'AUTH1',
                    status: 'CREATED',
                    amount: { currency_code: 'USD', value: '221.76' },
                  },
                ],
              },
            },
          ],
        }),
    });
    expect(await gw.getOrder('ORD1')).toEqual({
      status: 'COMPLETED',
      authorizationId: 'AUTH1',
      authorizationStatus: 'CREATED',
      authorizedCents: 22176,
    });
    expect(calls[0]!.method).toBe('GET');
  });

  it('authorize: POST .../authorize with Prefer return=representation and the auth request id; parses amount and expiry', async () => {
    const { gw, calls } = setup({
      'POST /v2/checkout/orders/ORD1/authorize': () =>
        json(
          {
            id: 'ORD1',
            status: 'COMPLETED',
            purchase_units: [
              {
                payments: {
                  authorizations: [
                    {
                      id: 'AUTH1',
                      status: 'CREATED',
                      amount: { currency_code: 'USD', value: '221.76' },
                      expiration_time: '2026-11-11T00:00:00Z',
                    },
                  ],
                },
              },
            ],
          },
          201,
        ),
    });
    const r = await gw.authorize({ orderId: 'ORD1', slotId: SLOT, attempt: 1 });
    expect(r).toMatchObject({
      authorizationId: 'AUTH1',
      authorizationStatus: 'CREATED',
      authorizedCents: 22176,
    });
    expect(r.expiresAt).toEqual(new Date('2026-11-11T00:00:00Z'));
    expect(calls[0]!.headers['PayPal-Request-Id']).toBe(`auth:${SLOT}:1`);
    expect(calls[0]!.headers.Prefer).toBe('return=representation');
    expect(calls[0]!.body).toEqual({});
  });

  it('capture: amount, final_capture true, invoice_id, note, request id; maps status and the PayPal fee', async () => {
    const { gw, calls } = setup({
      'POST /v2/payments/authorizations/AUTH1/capture': () =>
        json(
          {
            id: 'CAP1',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '203.28' },
            final_capture: true,
            seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: '6.20' } },
          },
          201,
        ),
    });
    const r = await gw.capture({
      authorizationId: 'AUTH1',
      paymentId: PAY,
      captureAttempt: 1,
      captureCents: 20328,
      invoiceId: `${SLOT}-1`,
    });
    expect(r).toEqual({
      captureId: 'CAP1',
      status: 'COMPLETED',
      capturedCents: 20328,
      paypalFeeCents: 620,
      reason: undefined,
    });
    const c = calls[0]!;
    expect(c.headers['PayPal-Request-Id']).toBe(`capture:${PAY}`);
    expect(c.headers.Prefer).toBe('return=representation');
    expect(c.body).toEqual({
      amount: { currency_code: 'USD', value: '203.28' },
      final_capture: true,
      invoice_id: `${SLOT}-1`,
      note_to_payer: 'ShiftCover Pay shift payment',
    });
  });

  it('capture retry after a decline uses a new request id', async () => {
    const { gw, calls } = setup({
      'POST /v2/payments/authorizations/AUTH1/capture': () =>
        json(
          { id: 'CAP2', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } },
          201,
        ),
    });
    await gw.capture({
      authorizationId: 'AUTH1',
      paymentId: PAY,
      captureAttempt: 2,
      captureCents: 100,
      invoiceId: 'x-1',
    });
    expect(calls[0]!.headers['PayPal-Request-Id']).toBe(`capture:${PAY}:2`);
  });

  it('void: POST .../void with the void request id (204, no body)', async () => {
    const { gw, calls } = setup({
      'POST /v2/payments/authorizations/AUTH1/void': () => new Response(null, { status: 204 }),
    });
    await gw.void({ authorizationId: 'AUTH1', paymentId: PAY });
    expect(calls[0]!.headers['PayPal-Request-Id']).toBe(`void:${PAY}`);
    expect(calls[0]!.method).toBe('POST');
  });

  it('getAuthorization and getCapture: plain GETs, amounts in cents', async () => {
    const { gw, calls } = setup({
      'GET /v2/payments/authorizations/AUTH1': () =>
        json({ id: 'AUTH1', status: 'VOIDED', amount: { currency_code: 'USD', value: '221.76' } }),
      'GET /v2/payments/captures/CAP1': () =>
        json({ id: 'CAP1', status: 'PENDING', amount: { currency_code: 'USD', value: '203.28' } }),
    });
    expect(await gw.getAuthorization('AUTH1')).toEqual({ status: 'VOIDED', amountCents: 22176 });
    expect(await gw.getCapture('CAP1')).toEqual({
      status: 'PENDING',
      amountCents: 20328,
      paypalFeeCents: 0,
    });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
  });

  it('createPayout: sender_batch_header, EMAIL receiver, USD amount, sender_item_id, purpose SERVICES, request id', async () => {
    const { gw, calls } = setup({
      'POST /v1/payments/payouts': () =>
        json({ batch_header: { payout_batch_id: 'PB1', batch_status: 'PENDING' } }, 201),
    });
    const r = await gw.createPayout({
      paymentId: PAY,
      slotId: SLOT,
      payoutAttempt: 1,
      receiverEmail: 'worker@example.com',
      amountCents: 19360,
      note: 'thanks',
    });
    expect(r).toEqual({ batchId: 'PB1', batchStatus: 'PENDING' });
    const c = calls[0]!;
    expect(c.headers['PayPal-Request-Id']).toBe(`payout:${SLOT}:1`);
    expect(c.body).toMatchObject({
      sender_batch_header: { sender_batch_id: `sc-${PAY}` },
      items: [
        {
          recipient_type: 'EMAIL',
          receiver: 'worker@example.com',
          amount: { currency: 'USD', value: '193.60' },
          sender_item_id: `${PAY}-1`,
          purpose: 'SERVICES',
          note: 'thanks',
        },
      ],
    });
  });

  it('createPayout refuses to pay the platform account (SELF_PAY_NOT_ALLOWED guard) before any request', async () => {
    const { gw, calls } = setup({});
    await expect(
      gw.createPayout({
        paymentId: PAY,
        slotId: SLOT,
        payoutAttempt: 1,
        receiverEmail: 'Platform@Example.com',
        amountCents: 100,
        note: '',
      }),
    ).rejects.toThrow(/SELF_PAY/);
    expect(calls).toHaveLength(0);
  });

  it('a payout retry after a failure gets a new sender_batch_id and request id', async () => {
    const { gw, calls } = setup({
      'POST /v1/payments/payouts': () =>
        json({ batch_header: { payout_batch_id: 'PB2', batch_status: 'PENDING' } }, 201),
    });
    await gw.createPayout({
      paymentId: PAY,
      slotId: SLOT,
      payoutAttempt: 2,
      receiverEmail: 'w@example.com',
      amountCents: 100,
      note: '',
    });
    expect(calls[0]!.headers['PayPal-Request-Id']).toBe(`payout:${SLOT}:2`);
    expect(
      (calls[0]!.body as { sender_batch_header: { sender_batch_id: string } }).sender_batch_header
        .sender_batch_id,
    ).toBe(`sc-${PAY}-2`);
  });

  const DUP_BODY = (link: boolean) => ({
    name: 'USER_BUSINESS_ERROR',
    message: 'User business error.',
    debug_id: 'dbg1',
    details: [
      {
        field: 'SENDER_BATCH_ID',
        location: 'body',
        issue: 'Batch with given sender_batch_id already exists',
        ...(link
          ? {
              link: [
                {
                  href: 'https://api.sandbox.paypal.com/v1/payments/payouts/94TJZKTHWRUJN',
                  rel: 'self',
                  method: 'GET',
                  encType: 'application/json',
                },
              ],
            }
          : {}),
      },
    ],
    links: [],
  });

  it('createPayout: 400 "sender_batch_id already exists" resolves to the ORIGINAL batch via its link, creating nothing new', async () => {
    const { gw, calls } = setup({
      'POST /v1/payments/payouts': () => json(DUP_BODY(true), 400),
      'GET /v1/payments/payouts/94TJZKTHWRUJN': () =>
        json({
          batch_header: { payout_batch_id: '94TJZKTHWRUJN', batch_status: 'SUCCESS' },
          items: [],
        }),
    });
    const r = await gw.createPayout({
      paymentId: PAY,
      slotId: SLOT,
      payoutAttempt: 1,
      receiverEmail: 'w@example.com',
      amountCents: 1000,
      note: '',
    });
    expect(r).toEqual({ batchId: '94TJZKTHWRUJN', batchStatus: 'SUCCESS', existing: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/payments/payouts',
      'GET /v1/payments/payouts/94TJZKTHWRUJN',
    ]); // exactly one create attempt, then a read of the original: no second batch
  });

  it('createPayout: the same 400 without a link is rethrown as a retryable conflict (the payment stays pending)', async () => {
    const { gw, calls } = setup({ 'POST /v1/payments/payouts': () => json(DUP_BODY(false), 400) });
    const e = await gw
      .createPayout({
        paymentId: PAY,
        slotId: SLOT,
        payoutAttempt: 1,
        receiverEmail: 'w@example.com',
        amountCents: 1000,
        note: '',
      })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PaypalError);
    expect(classifyPayoutError(e).kind).toBe('retryable');
    expect(calls).toHaveLength(1);
  });

  it('createPayout: an unrelated 400 is not mistaken for a duplicate', async () => {
    const { gw, calls } = setup({
      'POST /v1/payments/payouts': () =>
        json(
          { name: 'VALIDATION_ERROR', message: 'bad', details: [{ issue: 'MALFORMED_REQUEST' }] },
          400,
        ),
    });
    await expect(
      gw.createPayout({
        paymentId: PAY,
        slotId: SLOT,
        payoutAttempt: 1,
        receiverEmail: 'w@example.com',
        amountCents: 1000,
        note: '',
      }),
    ).rejects.toBeInstanceOf(PaypalError);
    expect(calls).toHaveLength(1);
  });

  it('getPayoutBatch: reads batch status, item status, fee and error name', async () => {
    const { gw } = setup({
      'GET /v1/payments/payouts/PB1': () =>
        json({
          batch_header: { payout_batch_id: 'PB1', batch_status: 'SUCCESS' },
          items: [
            {
              payout_item_id: 'IT1',
              transaction_status: 'FAILED',
              payout_item_fee: { currency: 'USD', value: '0.25' },
              payout_item: { sender_item_id: 'x-1', receiver: 'w@example.com' },
              errors: { name: 'RECEIVER_UNREGISTERED', message: 'no account' },
            },
          ],
        }),
    });
    expect(await gw.getPayoutBatch('PB1')).toEqual({
      batchStatus: 'SUCCESS',
      items: [
        {
          itemId: 'IT1',
          status: 'FAILED',
          feeCents: 25,
          errorName: 'RECEIVER_UNREGISTERED',
          senderItemId: 'x-1',
        },
      ],
    });
  });
});

const err = (status: number, code: string, kind: ConstructorParameters<typeof PaypalError>[1]) =>
  new PaypalError('x', kind, status, code, [{ issue: code }], 'dbg');

describe('error mapping (PLAN 4E)', () => {
  it('authorize: ORDER_NOT_APPROVED -> awaiting_approval; declines -> retryable; never leaks the body', () => {
    expect(classifyAuthorizeError(err(422, 'ORDER_NOT_APPROVED', 'validation')).kind).toBe(
      'awaiting_approval',
    );
    for (const c of ['INSTRUMENT_DECLINED', 'PAYER_ACTION_REQUIRED'])
      expect(classifyAuthorizeError(err(422, c, 'validation')).kind).toBe('retryable');
    expect(classifyAuthorizeError(err(500, 'X', 'server')).kind).toBe('retryable');
    expect(classifyAuthorizeError(err(400, 'INVALID_REQUEST', 'validation')).kind).toBe('fatal');
    const o = classifyAuthorizeError(err(422, 'INSTRUMENT_DECLINED', 'validation'));
    expect(o.message).not.toMatch(/dbg|PayPal 422/);
  });

  it('capture: declined -> declined; voided/expired -> authorization_gone', () => {
    expect(classifyCaptureError(err(422, 'INSTRUMENT_DECLINED', 'validation')).kind).toBe(
      'declined',
    );
    expect(classifyCaptureError(err(422, 'PAYER_ACCOUNT_RESTRICTED', 'validation')).kind).toBe(
      'declined',
    );
    expect(classifyCaptureError(err(422, 'AUTHORIZATION_VOIDED', 'validation')).kind).toBe(
      'authorization_gone',
    );
    expect(classifyCaptureError(err(422, 'AUTHORIZATION_EXPIRED', 'validation')).kind).toBe(
      'authorization_gone',
    );
    expect(classifyCaptureError(err(503, 'X', 'server')).kind).toBe('retryable');
  });

  it('payout: INSUFFICIENT_FUNDS and AUTHORIZATION_ERROR -> payout_failed with a clear message', () => {
    const a = classifyPayoutError(err(422, 'INSUFFICIENT_FUNDS', 'validation'));
    const b = classifyPayoutError(err(403, 'AUTHORIZATION_ERROR', 'auth'));
    expect(a).toMatchObject({ kind: 'payout_failed' });
    expect(a.message).toMatch(/balance is too low/);
    expect(b).toMatchObject({ kind: 'payout_failed' });
    expect(classifyPayoutError(err(500, 'X', 'server')).kind).toBe('retryable');
  });

  it('payout item failures read clearly', () => {
    expect(payoutItemFailure('UNCLAIMED')).toBe('The worker has not claimed the payout yet.');
    expect(payoutItemFailure('FAILED', 'RECEIVER_UNREGISTERED')).toBe(
      'The payout failed (RECEIVER_UNREGISTERED).',
    );
  });
});
