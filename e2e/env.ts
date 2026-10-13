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
