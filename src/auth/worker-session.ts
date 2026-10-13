import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../api/http';

/**
 * Worker session cookie (PLAN.md 2): set after the first valid open of an offer link so the token can
 * leave the address bar. HMAC-signed, httpOnly, SameSite=Lax. Carries only the worker id and expiry.
 */
export const WORKER_COOKIE = 'sc_worker';
const MAX_AGE_SECONDS = 12 * 3600;

const sign = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

export function createWorkerSession(workerId: string, secret: string, now = new Date()): string {
  const exp = Math.floor(now.getTime() / 1000) + MAX_AGE_SECONDS;
  const payload = `${workerId}.${exp}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function readWorkerSession(
  value: string | undefined,
  secret: string,
  now = new Date(),
): string | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [workerId, exp, sig] = parts as [string, string, string];
  const expected = sign(`${workerId}.${exp}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 <= now.getTime()) return null;
  return workerId;
}

export function workerCookieHeader(value: string, production: boolean): string {
  return [
    `${WORKER_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SECONDS}`,
    ...(production ? ['Secure'] : []),
  ].join('; ');
}

export function parseCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

export function requireWorker(headers: Headers, secret: string, now = new Date()): string {
  const id = readWorkerSession(parseCookie(headers.get('cookie'), WORKER_COOKIE), secret, now);
  if (!id) throw new HttpError(401, 'unauthenticated', 'Open your offer link again to sign in');
  return id;
}
