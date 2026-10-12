/**
 * Minimal PayPal REST client (Section 7). Sandbox only: any other base URL is refused at
 * construction and again on every request. Never logs or embeds credentials, tokens, or bodies.
 */

export const PAYPAL_SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

export type PaypalErrorKind =
  | 'auth' // 401/403: bad credentials or missing scope
  | 'validation' // 400/422: request rejected, do not retry unchanged
  | 'not_found' // 404
  | 'conflict' // 409 / duplicate ids
  | 'rate_limited' // 429
  | 'server' // 5xx: safe to retry with the same PayPal-Request-Id
  | 'network' // fetch failed / timeout: safe to retry with the same PayPal-Request-Id
  | 'unknown';

export interface PaypalIssue {
  issue?: string;
  description?: string;
  field?: string;
}

export class PaypalError extends Error {
  constructor(
    message: string,
    readonly kind: PaypalErrorKind,
    readonly status: number | undefined,
    /** PayPal `name`, e.g. INVALID_REQUEST, or the first issue code, e.g. SELF_PAY_NOT_ALLOWED. */
    readonly code: string | undefined,
    readonly issues: PaypalIssue[],
    readonly debugId: string | undefined,
  ) {
    super(message);
    this.name = 'PaypalError';
  }

  get retryable(): boolean {
    return this.kind === 'server' || this.kind === 'network' || this.kind === 'rate_limited';
  }
}

export class NonSandboxUrlError extends Error {
  constructor() {
    super(`PayPal base URL must be ${PAYPAL_SANDBOX_BASE}`);
    this.name = 'NonSandboxUrlError';
  }
}

export function assertSandboxBase(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NonSandboxUrlError();
  }
  if (parsed.origin !== PAYPAL_SANDBOX_BASE || parsed.pathname.replace(/\/+$/, '') !== '') {
    throw new NonSandboxUrlError();
  }
  return PAYPAL_SANDBOX_BASE;
}

export interface PaypalClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH';
  /** Path beginning with "/", e.g. "/v2/checkout/orders". */
  path: string;
  body?: unknown;
  /** Pre-serialized JSON body, sent byte-for-byte (use when a value must not be re-serialized). */
  rawBody?: string;
  /** Required for POST/PATCH: PayPal idempotency key. Reuse the same value when retrying. */
  requestId?: string;
  headers?: Record<string, string>;
}

export interface PaypalClient {
  request<T = unknown>(opts: RequestOptions): Promise<T>;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

const TOKEN_SKEW_MS = 60_000;

function kindFor(status: number): PaypalErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'validation';
  if (status >= 500) return 'server';
  return 'unknown';
}

async function toPaypalError(res: Response): Promise<PaypalError> {
  let payload: { name?: string; message?: string; details?: PaypalIssue[]; error?: string } = {};
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    // non-JSON error body: fall through with defaults
  }
  const issues = (payload.details ?? []).map((d) => ({
    issue: d.issue,
    description: d.description,
    field: d.field,
  }));
  const code = issues[0]?.issue ?? payload.name ?? payload.error;
  let kind = kindFor(res.status);
  // PayPal reports idempotency / duplicate problems as 422 with these issue codes.
  if (kind === 'validation' && issues.some((i) => /DUPLICATE|ALREADY/i.test(i.issue ?? ''))) {
    kind = 'conflict';
  }
  return new PaypalError(
    `PayPal ${res.status}${code ? ` ${code}` : ''}${payload.message ? `: ${payload.message}` : ''}`,
    kind,
    res.status,
    code,
    issues,
    res.headers.get('paypal-debug-id') ?? undefined,
  );
}

export function createPaypalClient(opts: PaypalClientOptions): PaypalClient {
  const baseUrl = assertSandboxBase(opts.baseUrl ?? PAYPAL_SANDBOX_BASE);
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');

  let token: CachedToken | undefined;
  let inflight: Promise<string> | undefined;

  async function send(url: string, init: RequestInit): Promise<Response> {
    // Defense in depth: re-check the target on every call.
    if (new URL(url).origin !== PAYPAL_SANDBOX_BASE) throw new NonSandboxUrlError();
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new PaypalError(
        'PayPal request failed (network)',
        'network',
        undefined,
        undefined,
        [],
        undefined,
      );
    }
  }

  async function fetchToken(): Promise<string> {
    const res = await send(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw await toPaypalError(res);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token || typeof json.expires_in !== 'number') {
      throw new PaypalError(
        'PayPal token response malformed',
        'unknown',
        res.status,
        undefined,
        [],
        undefined,
      );
    }
    token = { value: json.access_token, expiresAt: now() + json.expires_in * 1000 - TOKEN_SKEW_MS };
    return token.value;
  }

  async function getToken(): Promise<string> {
    if (token && token.expiresAt > now()) return token.value;
    inflight ??= fetchToken().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  async function attempt(o: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await getToken()}`,
      Accept: 'application/json',
      ...o.headers,
    };
    if (o.body !== undefined || o.rawBody !== undefined)
      headers['Content-Type'] = 'application/json';
    if (o.requestId) headers['PayPal-Request-Id'] = o.requestId;
    return send(`${baseUrl}${o.path}`, {
      method: o.method,
      headers,
      body: o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
    });
  }

  return {
    async request<T>(o: RequestOptions): Promise<T> {
      if (!o.path.startsWith('/')) throw new Error('PayPal path must start with "/"');
      if ((o.method === 'POST' || o.method === 'PATCH') && !o.requestId) {
        throw new Error('PayPal writes require a requestId (PayPal-Request-Id)');
      }
      let res = await attempt(o);
      if (res.status === 401) {
        // Token may have been revoked or expired early: refresh once.
        token = undefined;
        res = await attempt(o);
      }
      if (!res.ok) throw await toPaypalError(res);
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    },
  };
}
