import { z } from 'zod';
import { ServiceError } from '../services/types';

/** Small HTTP helpers shared by the route handlers. */

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 415 | 422 | 429 | 500 | 503,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

export interface ErrorBody {
  error: { code: string; message: string };
}

export function jsonError(e: unknown): Response {
  if (e instanceof HttpError) {
    return Response.json({ error: { code: e.code, message: e.message } } satisfies ErrorBody, {
      status: e.status,
    });
  }
  if (e instanceof z.ZodError) {
    return Response.json(
      {
        error: { code: 'invalid_request', message: 'Request did not match the expected shape' },
      } satisfies ErrorBody,
      { status: 400 },
    );
  }
  if (e instanceof ServiceError) {
    const status = (
      {
        not_found: 404,
        forbidden: 403,
        invalid_input: 422,
        payment_not_authorized: 409,
        invalid_state: 409,
        stub_disabled: 404,
        payment_failed: 409,
        unavailable: 503,
      } as const
    )[e.code];
    return Response.json({ error: { code: e.code, message: e.message } } satisfies ErrorBody, {
      status,
    });
  }
  // Never leak internals.
  console.error('[api] unhandled error', e instanceof Error ? e.name : 'unknown');
  return Response.json(
    { error: { code: 'internal', message: 'Something went wrong' } } satisfies ErrorBody,
    { status: 500 },
  );
}

/** Wrap a handler so every failure maps to a safe JSON error. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      return jsonError(e);
    }
  };
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const type = req.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json'))
    throw new HttpError(415, 'unsupported_media_type');
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  return schema.parse(raw);
}

/**
 * CSRF protection for cookie-authenticated POSTs: the request must declare JSON (a plain HTML form cannot)
 * and its Origin must be our own. Requests without an Origin are rejected.
 */
export function assertSameOrigin(req: Request, appBaseUrl: string): void {
  const origin = req.headers.get('origin');
  if (!origin || origin !== new URL(appBaseUrl).origin)
    throw new HttpError(403, 'bad_origin', 'Cross-origin request blocked');
}

export const noStore = { 'Cache-Control': 'no-store' } as const;
