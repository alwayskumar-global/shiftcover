import { describe, expect, it } from 'vitest';
import { CaptureExceedsAuthorizationError, MoneyError } from './errors';
import {
  assertCaptureWithinAuthorization,
  computeSettlement,
  formatUsd,
  maxAuthorization,
  maxRateCents,
  parseUsd,
  payForMinutesCents,
  platformFeeCents,
} from './money';

describe('format/parse', () => {
  it('round-trips cents', () => {
    expect(formatUsd(0)).toBe('0.00');
    expect(formatUsd(5)).toBe('0.05');
    expect(formatUsd(12345)).toBe('123.45');
    expect(parseUsd('123.45')).toBe(12345);
    expect(parseUsd('7')).toBe(700);
    expect(parseUsd('7.5')).toBe(750);
  });

  it('rejects bad input', () => {
    for (const bad of ['', '-1', '1.234', '1e3', 'abc', '1,000.00']) {
      expect(() => parseUsd(bad)).toThrow(MoneyError);
    }
    expect(() => formatUsd(1.5)).toThrow(MoneyError);
    expect(() => formatUsd(-1)).toThrow(MoneyError);
  });
});

describe('platformFeeCents (7.8)', () => {
  it('computes bps with round-half-up', () => {
    expect(platformFeeCents(10_000, 500)).toBe(500); // 5%
    expect(platformFeeCents(0, 500)).toBe(0);
    expect(platformFeeCents(10_000, 0)).toBe(0);
    expect(platformFeeCents(9_999, 500)).toBe(500); // 499.95 -> 500
    expect(platformFeeCents(10, 500)).toBe(1); // 0.5 -> 1
    expect(platformFeeCents(9, 500)).toBe(0); // 0.45 -> 0
    expect(platformFeeCents(10_000, 10_000)).toBe(10_000);
  });

  it('validates inputs', () => {
    expect(() => platformFeeCents(100, -1)).toThrow(MoneyError);
    expect(() => platformFeeCents(100, 10_001)).toThrow(MoneyError);
    expect(() => platformFeeCents(1.5, 500)).toThrow(MoneyError);
  });
});

describe('maxAuthorization (flow 4B)', () => {
  it('matches hours * base * (1+premium) * (1+fee)', () => {
    // 8h at $20.00 base, 20% cap, 5% fee: 8*20*1.2 = 192.00; fee 9.60; total 201.60
    const a = maxAuthorization({ baseRateCents: 2000, maxPremiumPct: 20, minutes: 480, feeBps: 500 });
    expect(a).toEqual({
      maxRateCents: 2400,
      maxWorkerPayCents: 19_200,
      maxFeeCents: 960,
      authorizedCents: 20_160,
    });
  });

  it('handles zero premium and part hours', () => {
    const a = maxAuthorization({ baseRateCents: 1850, maxPremiumPct: 0, minutes: 90, feeBps: 500 });
    expect(a.maxWorkerPayCents).toBe(2775); // 1.5h * 18.50
    expect(a.maxFeeCents).toBe(139); // 138.75 -> 139
    expect(a.authorizedCents).toBe(2914);
  });

  it('rounds the cap rate to the cent', () => {
    expect(maxRateCents(1999, 15)).toBe(2299); // 2298.85 -> 2299
  });
});

describe('computeSettlement', () => {
  const cap = maxAuthorization({ baseRateCents: 2000, maxPremiumPct: 20, minutes: 480, feeBps: 500 });

  it('captures worker pay plus fee for actual minutes', () => {
    const s = computeSettlement({
      rateCents: 2200,
      maxRateCents: cap.maxRateCents,
      actualMinutes: 450,
      feeBps: 500,
      authorizedCents: cap.authorizedCents,
    });
    expect(s).toEqual({ workerPayCents: 16_500, platformFeeCents: 825, captureCents: 17_325 });
  });

  it('allows a capture exactly equal to the authorization', () => {
    const s = computeSettlement({
      rateCents: cap.maxRateCents,
      maxRateCents: cap.maxRateCents,
      actualMinutes: 480,
      feeBps: 500,
      authorizedCents: cap.authorizedCents,
    });
    expect(s.captureCents).toBe(cap.authorizedCents);
  });

  it('rejects hours beyond the authorized cap', () => {
    expect(() =>
      computeSettlement({
        rateCents: cap.maxRateCents,
        maxRateCents: cap.maxRateCents,
        actualMinutes: 481,
        feeBps: 500,
        authorizedCents: cap.authorizedCents,
      }),
    ).toThrow(CaptureExceedsAuthorizationError);
  });

  it('rejects a rate above the cap', () => {
    expect(() =>
      computeSettlement({
        rateCents: cap.maxRateCents + 1,
        maxRateCents: cap.maxRateCents,
        actualMinutes: 60,
        feeBps: 500,
        authorizedCents: cap.authorizedCents,
      }),
    ).toThrow(MoneyError);
  });

  it('never exceeds the authorization for any rate/minutes at or below the cap', () => {
    for (let minutes = 0; minutes <= 480; minutes += 7) {
      for (const rate of [1, 1999, 2000, 2399, cap.maxRateCents]) {
        const s = computeSettlement({
          rateCents: rate,
          maxRateCents: cap.maxRateCents,
          actualMinutes: minutes,
          feeBps: 500,
          authorizedCents: cap.authorizedCents,
        });
        expect(s.captureCents).toBeLessThanOrEqual(cap.authorizedCents);
      }
    }
  });
});

describe('assertCaptureWithinAuthorization', () => {
  it('rejects capture above authorization', () => {
    expect(() => assertCaptureWithinAuthorization(101, 100)).toThrow(CaptureExceedsAuthorizationError);
    expect(() => assertCaptureWithinAuthorization(100, 100)).not.toThrow();
  });
});

describe('payForMinutesCents', () => {
  it('rounds to the cent', () => {
    expect(payForMinutesCents(2000, 90)).toBe(3000);
    expect(payForMinutesCents(1999, 1)).toBe(33); // 33.32
  });
});
