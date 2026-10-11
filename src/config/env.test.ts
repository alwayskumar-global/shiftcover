import { describe, expect, it } from 'vitest';
import {
  EnvError,
  parsePublicEnv,
  parseServerEnv,
  requireGeminiEnv,
  requirePaypalEnv,
} from './env';

const SECRET = 's'.repeat(32);
const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  SESSION_SECRET: SECRET,
  CLAIM_TOKEN_PEPPER: 'p'.repeat(32),
};

describe('parseServerEnv', () => {
  it('applies defaults for non-secrets', () => {
    const env = parseServerEnv(base);
    expect(env.PAYPAL_API_BASE).toBe('https://api-m.sandbox.paypal.com');
    expect(env.LLM_MODEL).toBe('gemini-3.5-flash-lite');
    expect(env.LLM_ENABLED).toBe(true);
    expect(env.DEMO_MODE).toBe(false);
    expect(env.WAVE_INTERVAL_SECONDS).toBe(300);
  });

  it('treats blank placeholders as unset', () => {
    const env = parseServerEnv({ ...base, PAYPAL_CLIENT_ID: '', GEMINI_API_KEY: '' });
    expect(env.PAYPAL_CLIENT_ID).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it('fails fast when required vars are missing', () => {
    expect(() => parseServerEnv({})).toThrow(EnvError);
  });

  it('never leaks values in the error message', () => {
    const leaky = 'super-secret-value-that-is-too-short';
    try {
      parseServerEnv({ ...base, SESSION_SECRET: 'short-leaky-secret', PAYPAL_API_BASE: leaky });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const msg = (e as Error).message;
      expect(msg).toContain('SESSION_SECRET');
      expect(msg).toContain('PAYPAL_API_BASE');
      expect(msg).not.toContain('short-leaky-secret');
      expect(msg).not.toContain(leaky);
    }
  });

  it('refuses a non-sandbox PayPal base URL', () => {
    expect(() =>
      parseServerEnv({ ...base, PAYPAL_API_BASE: 'https://api-m.paypal.com' }),
    ).toThrow(EnvError);
  });

  it('refuses any model other than gemini-3.5-flash-lite', () => {
    expect(() => parseServerEnv({ ...base, LLM_MODEL: 'gemini-2.5-pro' })).toThrow(EnvError);
  });

  it('requires PayPal and Gemini config in production', () => {
    expect(() => parseServerEnv({ ...base, NODE_ENV: 'production' })).toThrow(/PAYPAL_CLIENT_ID/);
    expect(() =>
      parseServerEnv({
        ...base,
        NODE_ENV: 'production',
        PAYPAL_CLIENT_ID: 'x',
        PAYPAL_CLIENT_SECRET: 'x',
        PAYPAL_WEBHOOK_ID: 'x',
        PAYPAL_PLATFORM_EMAIL: 'platform@example.com',
        LLM_ENABLED: 'false',
      }),
    ).not.toThrow();
  });

  it('rejects out-of-range fee bps', () => {
    expect(() => parseServerEnv({ ...base, PLATFORM_FEE_BPS: '10001' })).toThrow(EnvError);
  });
});

describe('scoped requirements', () => {
  it('requirePaypalEnv fails fast when credentials are absent', () => {
    expect(() => requirePaypalEnv(parseServerEnv(base))).toThrow(/PAYPAL_CLIENT_ID/);
  });

  it('requireGeminiEnv fails fast when key is absent', () => {
    expect(() => requireGeminiEnv(parseServerEnv(base))).toThrow(/GEMINI_API_KEY/);
  });
});

describe('parsePublicEnv', () => {
  it('only exposes NEXT_PUBLIC vars', () => {
    const pub = parsePublicEnv({ NEXT_PUBLIC_PAYPAL_CLIENT_ID: 'abc', PAYPAL_CLIENT_SECRET: 'x' });
    expect(pub).toEqual({ NEXT_PUBLIC_PAYPAL_CLIENT_ID: 'abc' });
  });
});
