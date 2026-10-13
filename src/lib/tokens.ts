import { createHash, randomBytes } from 'node:crypto';

/** 256-bit URL-safe token (PLAN.md 2). Only sha256(token + pepper) is ever stored. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string, pepper: string): string {
  return createHash('sha256')
    .update(token + pepper)
    .digest('hex');
}
