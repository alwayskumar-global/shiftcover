import { Pool } from 'pg';
/**
 * Environment for the end-to-end run. Everything is explicit so no value from a developer's .env (which may
 * hold hosted-database or PayPal settings) can leak in: the database is the throwaway local Postgres only,
 * payments are stubbed, and the LLM is off (the rules parser reads the note).
 * The secrets below are throwaway values for this local run, not real credentials.
 */
export const E2E_PORT = 3300;
export const E2E_DB = 'shiftcover_e2e';
export const ADMIN_URL = 'postgres://postgres:test@127.0.0.1:54329/postgres';
export const E2E_DATABASE_URL = `postgres://postgres:test@127.0.0.1:54329/${E2E_DB}`;
export const MANAGER_EMAIL = 'dana.whitfield@example.com';
export const MANAGER_PASSWORD = 'e2e-local-only-password-1';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Throws unless the URL points at this machine. Every database and page the e2e touches goes through it. */
export function assertLoopback(url: string, what: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`e2e guard: ${what} is not a valid URL`);
  }
  if (!LOOPBACK.has(host))
    throw new Error(`e2e guard: ${what} must be a local address, never a remote one`);
  return url;
}

/**
 * The only way e2e code opens a database connection: both URLs are constants in this file (no environment variable can
 * redirect them) and are checked to be loopback. The specs move shifts around ("now") only through this pool.
 */
export function localPool(kind: 'admin' | 'e2e' = 'e2e') {
  return new Pool({
    connectionString: assertLoopback(
      kind === 'admin' ? ADMIN_URL : E2E_DATABASE_URL,
      'database URL',
    ),
    max: 1,
  });
}

export const serverEnv = {
  NODE_ENV: 'development' as const,
  APP_BASE_URL: `http://127.0.0.1:${E2E_PORT}`,
  DATABASE_URL: E2E_DATABASE_URL,
  SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123',
  CLAIM_TOKEN_PEPPER: 'e2e-token-pepper-0123456789abcdef0123456',
  PAYMENTS_MODE: 'stub',
  LLM_ENABLED: 'false',
  WAVE_INTERVAL_SECONDS: '3600',
  UI_REVIEW: 'false',
  SEED_MANAGER_PASSWORD: MANAGER_PASSWORD,
};
