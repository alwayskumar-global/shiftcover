import { describe, expect, it } from 'vitest';
import { checkSpikeEnv } from './spike-paypal-guards';

const ok = {
  PAYPAL_CLIENT_ID: 'id',
  PAYPAL_CLIENT_SECRET: 'sec-topsecret',
  PAYPAL_PLATFORM_EMAIL: 'platform@example.com',
  SPIKE_WORKER_EMAIL: 'worker@example.com',
};

describe('checkSpikeEnv', () => {
  it('passes with distinct emails and the sandbox base', () => {
    expect(checkSpikeEnv(ok).ok).toBe(true);
    expect(checkSpikeEnv({ ...ok, PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com/' }).ok).toBe(
      true,
    );
  });

  it('refuses payout to self (case-insensitive)', () => {
    const r = checkSpikeEnv({ ...ok, SPIKE_WORKER_EMAIL: 'Platform@Example.com' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join()).toMatch(/equals PAYPAL_PLATFORM_EMAIL/);
  });

  it('refuses a non-sandbox API base', () => {
    const r = checkSpikeEnv({ ...ok, PAYPAL_API_BASE: 'https://api-m.paypal.com' });
    expect(r.ok).toBe(false);
  });

  it('reports missing vars by name only', () => {
    const r = checkSpikeEnv({
      ...ok,
      PAYPAL_CLIENT_SECRET: '',
      SPIKE_WORKER_EMAIL: 'not-an-email-leaky',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.problems.join();
      expect(msg).toContain('PAYPAL_CLIENT_SECRET');
      expect(msg).toContain('SPIKE_WORKER_EMAIL');
      expect(msg).not.toContain('leaky');
    }
  });
});
