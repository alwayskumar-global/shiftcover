import { CaptureExceedsAuthorizationError, MoneyError } from './errors';

/** All money is integer cents (USD). No floats cross a function boundary. */

function assertCents(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MoneyError(`${name} must be a non-negative integer number of cents`);
  }
}

/** Round-half-up integer division for non-negative integers. */
function divRound(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/** 12345 -> "123.45" (PayPal amount.value format). */
export function formatUsd(cents: number): string {
  assertCents(cents, 'cents');
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}

/** "123.45" -> 12345. Rejects anything that is not a plain USD amount with at most 2 decimals. */
export function parseUsd(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) throw new MoneyError('Invalid USD amount');
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  assertCents(cents, 'amount');
  return cents;
}

/** 7.8: platform_fee_cents = round(worker_pay_cents * PLATFORM_FEE_BPS / 10000). */
export function platformFeeCents(workerPayCents: number, feeBps: number): number {
  assertCents(workerPayCents, 'workerPayCents');
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new MoneyError('feeBps must be an integer in 0..10000');
  }
  return divRound(workerPayCents * feeBps, 10_000);
}

/** Pay for `minutes` at an hourly rate, rounded to the cent. */
export function payForMinutesCents(hourlyRateCents: number, minutes: number): number {
  assertCents(hourlyRateCents, 'hourlyRateCents');
  assertCents(minutes, 'minutes');
  return divRound(hourlyRateCents * minutes, 60);
}

/** Highest hourly rate allowed: base * (1 + max_premium_pct). */
export function maxRateCents(baseRateCents: number, maxPremiumPct: number): number {
  assertCents(baseRateCents, 'baseRateCents');
  if (!Number.isInteger(maxPremiumPct) || maxPremiumPct < 0 || maxPremiumPct > 100) {
    throw new MoneyError('maxPremiumPct must be an integer in 0..100');
  }
  return divRound(baseRateCents * (100 + maxPremiumPct), 100);
}

export interface MaxAuthorization {
  maxRateCents: number;
  maxWorkerPayCents: number;
  maxFeeCents: number;
  authorizedCents: number;
}

/**
 * Flow 4B: hours * base_rate * (1 + max_premium) * (1 + platform_fee).
 * Worker pay at the cap is rounded to cents first, then the fee is rounded on that figure, so
 * any actual settlement at or below the cap rate and hours is guaranteed <= the authorization.
 */
export function maxAuthorization(args: {
  baseRateCents: number;
  maxPremiumPct: number;
  minutes: number;
  feeBps: number;
}): MaxAuthorization {
  const cap = maxRateCents(args.baseRateCents, args.maxPremiumPct);
  const maxWorkerPayCents = payForMinutesCents(cap, args.minutes);
  const maxFeeCents = platformFeeCents(maxWorkerPayCents, args.feeBps);
  return {
    maxRateCents: cap,
    maxWorkerPayCents,
    maxFeeCents,
    authorizedCents: maxWorkerPayCents + maxFeeCents,
  };
}

export interface Settlement {
  workerPayCents: number;
  platformFeeCents: number;
  /** Amount to capture from the employer: worker pay + platform fee. */
  captureCents: number;
}

/**
 * Amount to capture at approval. Rejects (never silently clamps) anything above the authorization,
 * and anything above the rate cap, so the server stays the only source of amounts.
 */
export function computeSettlement(args: {
  rateCents: number;
  maxRateCents: number;
  actualMinutes: number;
  feeBps: number;
  authorizedCents: number;
}): Settlement {
  assertCents(args.authorizedCents, 'authorizedCents');
  if (args.rateCents > args.maxRateCents) throw new MoneyError('Rate exceeds the authorized cap');
  const workerPayCents = payForMinutesCents(args.rateCents, args.actualMinutes);
  const fee = platformFeeCents(workerPayCents, args.feeBps);
  const captureCents = workerPayCents + fee;
  assertCaptureWithinAuthorization(captureCents, args.authorizedCents);
  return { workerPayCents, platformFeeCents: fee, captureCents };
}

export function assertCaptureWithinAuthorization(
  requestedCents: number,
  authorizedCents: number,
): void {
  assertCents(requestedCents, 'requestedCents');
  assertCents(authorizedCents, 'authorizedCents');
  if (requestedCents > authorizedCents) {
    throw new CaptureExceedsAuthorizationError(requestedCents, authorizedCents);
  }
}
