import { describe, expect, it, vi } from 'vitest';
import {
  approvalLink,
  captureAuthorization,
  checkOrderApproved,
  createAuthorizeOrder,
  createPayout,
  senderBatchId,
  SelfPayError,
} from './api';
import {
  assertSandboxBase,
  createPaypalClient,
  NonSandboxUrlError,
  PaypalError,
  PAYPAL_SANDBOX_BASE,
} from './client';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const tokenRes = (expires_in = 3600) => json({ access_token: 'tok-1', expires_in });

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init ?? {}),
  );
  let t = 1_000_000;
  const client = createPaypalClient({
    clientId: 'id',
    clientSecret: 'secret',
    fetch: fetchMock as unknown as typeof fetch,
    now: () => t,
  });
  return { client, fetchMock, advance: (ms: number) => (t += ms) };
}

describe('sandbox enforcement', () => {
  it('accepts only the sandbox base URL', () => {
    expect(assertSandboxBase(PAYPAL_SANDBOX_BASE)).toBe(PAYPAL_SANDBOX_BASE);
    expect(assertSandboxBase(`${PAYPAL_SANDBOX_BASE}/`)).toBe(PAYPAL_SANDBOX_BASE);
    for (const bad of [
      'https://api-m.paypal.com',
      'https://api.paypal.com',
      'http://api-m.sandbox.paypal.com',
      'https://api-m.sandbox.paypal.com.evil.test',
      'https://api-m.sandbox.paypal.com/v2',
      'not a url',
    ]) {
      expect(() => assertSandboxBase(bad)).toThrow(NonSandboxUrlError);
    }
  });

  it('refuses to construct a client for production', () => {
    expect(() =>
      createPaypalClient({ clientId: 'a', clientSecret: 'b', baseUrl: 'https://api-m.paypal.com' }),
    ).toThrow(NonSandboxUrlError);
  });
});

describe('token cache', () => {
  it('fetches a token once and reuses it', async () => {
    const { client, fetchMock } = setup((url) =>
      url.endsWith('/v1/oauth2/token') ? tokenRes() : json({ ok: 1 }),
    );
    await client.request({ method: 'GET', path: '/v1/a' });
    await client.request({ method: 'GET', path: '/v1/b' });
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
    const init = tokenCalls[0]![1]!;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('id:secret').toString('base64')}`,
    );
  });

  it('refreshes after expiry (with skew)', async () => {
    const { client, fetchMock, advance } = setup((url) =>
      url.endsWith('/v1/oauth2/token') ? tokenRes(120) : json({}),
    );
    await client.request({ method: 'GET', path: '/v1/a' });
    advance(30_000);
    await client.request({ method: 'GET', path: '/v1/a' });
    advance(40_000); // past 120s minus 60s skew
    await client.request({ method: 'GET', path: '/v1/a' });
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('oauth2/token'));
    expect(tokenCalls).toHaveLength(2);
  });

  it('shares one in-flight token request across concurrent calls', async () => {
    const { client, fetchMock } = setup((url) =>
      url.endsWith('/v1/oauth2/token') ? tokenRes() : json({}),
    );
    await Promise.all([1, 2, 3].map(() => client.request({ method: 'GET', path: '/v1/a' })));
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('refreshes the token once on a 401 and retries', async () => {
    let apiCalls = 0;
    const { client, fetchMock } = setup((url) => {
      if (url.endsWith('/v1/oauth2/token')) return tokenRes();
      apiCalls++;
      return apiCalls === 1
        ? json({ name: 'AUTHENTICATION_FAILURE' }, { status: 401 })
        : json({ ok: 1 });
    });
    await expect(client.request({ method: 'GET', path: '/v1/a' })).resolves.toEqual({ ok: 1 });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('oauth2/token'))).toHaveLength(
      2,
    );
  });
});

describe('request helper', () => {
  it('sets PayPal-Request-Id and JSON headers on writes', async () => {
    const { client, fetchMock } = setup((url) =>
      url.endsWith('/v1/oauth2/token') ? tokenRes() : json({ id: 'x' }),
    );
    await client.request({
      method: 'POST',
      path: '/v2/checkout/orders',
      body: { a: 1 },
      requestId: 'req-1',
    });
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/v2/checkout/orders'))!;
    const h = init!.headers as Record<string, string>;
    expect(h['PayPal-Request-Id']).toBe('req-1');
    expect(h.Authorization).toBe('Bearer tok-1');
    expect(h['Content-Type']).toBe('application/json');
    expect(init!.body).toBe('{"a":1}');
  });

  it('refuses a write without a request id', async () => {
    const { client } = setup(() => tokenRes());
    await expect(client.request({ method: 'POST', path: '/v1/x', body: {} })).rejects.toThrow(
      /requestId/,
    );
  });
});

describe('error mapping', () => {
  const failWith = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    setup((url) =>
      url.endsWith('/v1/oauth2/token') ? tokenRes() : json(body, { status, headers }),
    ).client;

  it('maps validation errors with issue code and debug id', async () => {
    const client = failWith(
      422,
      {
        name: 'UNPROCESSABLE_ENTITY',
        message: 'bad',
        details: [{ issue: 'SELF_PAY_NOT_ALLOWED', description: 'nope' }],
      },
      { 'paypal-debug-id': 'dbg-1' },
    );
    const err = await client.request({ method: 'GET', path: '/v1/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaypalError);
    const pe = err as PaypalError;
    expect(pe.kind).toBe('validation');
    expect(pe.code).toBe('SELF_PAY_NOT_ALLOWED');
    expect(pe.debugId).toBe('dbg-1');
    expect(pe.retryable).toBe(false);
  });

  it.each([
    [401, 'auth', false],
    [404, 'not_found', false],
    [409, 'conflict', false],
    [429, 'rate_limited', true],
    [500, 'server', true],
    [503, 'server', true],
  ] as const)('maps %i to %s (retryable=%s)', async (status, kind, retryable) => {
    const client = failWith(status, { name: 'X' });
    const err = (await client
      .request({ method: 'GET', path: '/v1/x' })
      .catch((e: unknown) => e)) as PaypalError;
    expect(err.kind).toBe(kind);
    expect(err.retryable).toBe(retryable);
  });

  it('maps duplicate-id 422s to conflict', async () => {
    const client = failWith(422, { name: 'X', details: [{ issue: 'DUPLICATE_BATCH_ID' }] });
    const err = (await client
      .request({ method: 'GET', path: '/v1/x' })
      .catch((e: unknown) => e)) as PaypalError;
    expect(err.kind).toBe('conflict');
  });

  it('maps network failures as retryable and never leaks credentials', async () => {
    const client = createPaypalClient({
      clientId: 'id',
      clientSecret: 'topsecret',
      fetch: (async () => {
        throw new Error('ECONNRESET topsecret');
      }) as unknown as typeof fetch,
    });
    const err = (await client
      .request({ method: 'GET', path: '/v1/x' })
      .catch((e: unknown) => e)) as PaypalError;
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain('topsecret');
  });
});

describe('api wrappers', () => {
  const recorder = () => {
    const request = vi.fn(async () => ({}));
    return { request, client: { request } as never };
  };

  it('captures with final_capture and formatted amount', async () => {
    const { request, client } = recorder();
    await captureAuthorization(client, {
      authorizationId: 'AUTH1',
      captureCents: 17_325,
      invoiceId: 'slot-1-1',
      requestId: 'cap-1',
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v2/payments/authorizations/AUTH1/capture',
        requestId: 'cap-1',
        body: expect.objectContaining({
          final_capture: true,
          amount: { currency_code: 'USD', value: '173.25' },
        }),
      }),
    );
  });

  it('builds an EMAIL payout with deterministic batch id', async () => {
    const { request, client } = recorder();
    await createPayout(client, {
      senderBatchId: senderBatchId('pay-1'),
      senderItemId: 'pay-1-item',
      receiverEmail: 'worker@example.com',
      platformEmail: 'platform@example.com',
      amountCents: 16_500,
      subject: 's',
      message: 'm',
      requestId: 'po-1',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (request.mock.calls[0] as unknown as [{ body: any; requestId: string }])[0];
    expect(call.body.sender_batch_header.sender_batch_id).toBe('sc-pay-1');
    expect(call.body.items[0]).toMatchObject({
      recipient_type: 'EMAIL',
      receiver: 'worker@example.com',
      amount: { currency: 'USD', value: '165.00' },
      purpose: 'SERVICES',
    });
    expect(call.requestId).toBe('po-1');
  });

  it('refuses to pay the platform account', () => {
    const { client } = recorder();
    expect(() =>
      createPayout(client, {
        senderBatchId: 'b',
        senderItemId: 'i',
        receiverEmail: 'Platform@Example.com',
        platformEmail: 'platform@example.com',
        amountCents: 100,
        subject: 's',
        message: 'm',
        requestId: 'r',
      }),
    ).toThrow(SelfPayError);
  });
});

describe('createAuthorizeOrder / approval guard', () => {
  it('adds redirect experience_context and keeps one AUTHORIZE purchase unit', async () => {
    const request = vi.fn(async () => ({ id: 'O1', status: 'PAYER_ACTION_REQUIRED' }));
    await createAuthorizeOrder({ request } as never, {
      slotId: 'spike-1',
      attempt: 1,
      maxCents: 1000,
      requestId: 'r1',
      redirect: {
        returnUrl: 'https://example.com/spike/return',
        cancelUrl: 'https://example.com/spike/cancel',
        brandName: 'ShiftCover Spike',
      },
    });
    const call = (
      request.mock.calls[0] as unknown as [
        { path: string; requestId: string; body: Record<string, unknown> },
      ]
    )[0];
    expect(call.path).toBe('/v2/checkout/orders');
    expect(call.requestId).toBe('r1');
    expect(call.body.intent).toBe('AUTHORIZE');
    expect(call.body.payment_source).toEqual({
      paypal: {
        experience_context: {
          return_url: 'https://example.com/spike/return',
          cancel_url: 'https://example.com/spike/cancel',
          brand_name: 'ShiftCover Spike',
          landing_page: 'LOGIN',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'CONTINUE',
        },
      },
    });
    const units = call.body.purchase_units as Array<{
      amount: unknown;
      custom_id: string;
      invoice_id: string;
    }>;
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      custom_id: 'spike-1',
      invoice_id: 'spike-1-1',
      amount: { currency_code: 'USD', value: '10.00' },
    });
  });

  it('omits payment_source when the JS SDK button drives approval', async () => {
    const request = vi.fn(async () => ({ id: 'O1', status: 'CREATED' }));
    await createAuthorizeOrder({ request } as never, {
      slotId: 's',
      attempt: 1,
      maxCents: 100,
      requestId: 'r',
    });
    const call = (request.mock.calls[0] as unknown as [{ body: Record<string, unknown> }])[0];
    expect(call.body).not.toHaveProperty('payment_source');
  });

  it('picks payer-action first, then approve, from the response links', () => {
    expect(
      approvalLink({
        id: 'O',
        status: 'PAYER_ACTION_REQUIRED',
        links: [
          { rel: 'self', href: 'https://x/self' },
          { rel: 'approve', href: 'https://x/approve' },
          { rel: 'payer-action', href: 'https://x/payer' },
        ],
      }),
    ).toBe('https://x/payer');
    expect(
      approvalLink({
        id: 'O',
        status: 'CREATED',
        links: [{ rel: 'approve', href: 'https://x/approve' }],
      }),
    ).toBe('https://x/approve');
    expect(approvalLink({ id: 'O', status: 'CREATED' })).toBeUndefined();
  });

  it('only allows authorize once the order is APPROVED', () => {
    expect(checkOrderApproved({ status: 'APPROVED' })).toEqual({ approved: true });
    for (const status of ['CREATED', 'PAYER_ACTION_REQUIRED', 'VOIDED', 'COMPLETED']) {
      expect(checkOrderApproved({ status })).toEqual({ approved: false, status });
    }
  });
});
