import { describe, expect, it } from 'vitest';
import {
  EnvError,
  envWarnings,
  parsePublicEnv,
  parseServerEnv,
  requireGeminiEnv,
  requirePaypalEnv,
} from './env';

const SECRET = 's'.repeat(32);
const POOLER = 'postgres://postgres.abcdefgh:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';
const base = {
  DATABASE_URL: POOLER,
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
    expect(() => parseServerEnv({ ...base, PAYPAL_API_BASE: 'https://api-m.paypal.com' })).toThrow(
      EnvError,
    );
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

describe('DATABASE_URL (Supabase session pooler)', () => {
  const withUrl = (DATABASE_URL: string) => ({ ...base, DATABASE_URL });

  it('accepts the session pooler and default port', () => {
    expect(() => parseServerEnv(withUrl(POOLER))).not.toThrow();
    expect(() => parseServerEnv(withUrl(POOLER.replace(':5432', '')))).not.toThrow();
  });

  it('rejects port 6543 (transaction pooler) without echoing the value', () => {
    const bad = POOLER.replace(':5432', ':6543');
    try {
      parseServerEnv(withUrl(bad));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const msg = (e as Error).message;
      expect(msg).toContain('DATABASE_URL');
      expect(msg).toContain('6543');
      expect(msg).not.toContain('pw');
      expect(msg).not.toContain('abcdefgh');
      expect(msg).not.toContain('pooler.supabase.com');
    }
  });

  it('rejects the direct Supabase host', () => {
    expect(() =>
      parseServerEnv(withUrl('postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres')),
    ).toThrow(EnvError);
  });

  it('rejects non-postgres and unparseable values without leaking them', () => {
    for (const bad of ['mysql://u:secretpw@h/db', 'not a url secretpw']) {
      try {
        parseServerEnv(withUrl(bad));
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(EnvError);
        expect((e as Error).message).not.toContain('secretpw');
      }
    }
  });

  it('warns (no value) in production when the host is not the Supabase pooler', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      PAYPAL_CLIENT_ID: 'x',
      PAYPAL_CLIENT_SECRET: 'x',
      PAYPAL_WEBHOOK_ID: 'x',
      PAYPAL_PLATFORM_EMAIL: 'p@example.com',
      LLM_ENABLED: 'false',
    };
    expect(envWarnings(parseServerEnv(prod))).toEqual([]);
    const w = envWarnings(
      parseServerEnv({ ...prod, DATABASE_URL: 'postgres://u:topsecret@db.internal.example:5432/x' }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('DATABASE_URL');
    expect(w[0]).not.toContain('topsecret');
    expect(w[0]).not.toContain('db.internal.example');
  });

  it('does not warn outside production', () => {
    expect(envWarnings(parseServerEnv(withUrl('postgres://u:p@localhost:5432/x')))).toEqual([]);
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
