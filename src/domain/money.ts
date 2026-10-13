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

export interface FeeConfig {
  feeBps: number;
  /** Optional flat fee added once per shift (cents). Config, never hard-coded: the final fee model is Kumar's call. */
  fixedFeeCents?: number;
}

/** Platform fee on a worker pay amount: the percentage part plus the optional flat part (0 when there is no pay). */
export function platformFee(workerPayCents: number, cfg: FeeConfig): number {
  const fixed = cfg.fixedFeeCents ?? 0;
  assertCents(fixed, 'fixedFeeCents');
  return platformFeeCents(workerPayCents, cfg.feeBps) + (workerPayCents > 0 ? fixed : 0);
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
  fixedFeeCents?: number;
}): MaxAuthorization {
  const cap = maxRateCents(args.baseRateCents, args.maxPremiumPct);
  const maxWorkerPayCents = payForMinutesCents(cap, args.minutes);
  const maxFeeCents = platformFee(maxWorkerPayCents, {
    feeBps: args.feeBps,
    fixedFeeCents: args.fixedFeeCents,
  });
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
  fixedFeeCents?: number;
  authorizedCents: number;
}): Settlement {
  assertCents(args.authorizedCents, 'authorizedCents');
  if (args.rateCents > args.maxRateCents) throw new MoneyError('Rate exceeds the authorized cap');
  const workerPayCents = payForMinutesCents(args.rateCents, args.actualMinutes);
  const fee = platformFee(workerPayCents, {
    feeBps: args.feeBps,
    fixedFeeCents: args.fixedFeeCents,
  });
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

/**
 * The most hours that can be approved for a shift: the largest 2-decimal figure whose pay + fee still fits inside
 * the authorization (the hold). The server enforces the same bound when it captures.
 */
export function maxApprovableHours(args: {
  rateCents: number;
  authorizedCents: number;
  feeBps: number;
  fixedFeeCents?: number;
}): number {
  const cost = (hours: number) => {
    const pay = payForMinutesCents(args.rateCents, Math.round(hours * 60));
    return pay + platformFee(pay, { feeBps: args.feeBps, fixedFeeCents: args.fixedFeeCents });
  };
  let lo = 0;
  let hi = 24 * 100; // hundredths of an hour
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cost(mid / 100) <= args.authorizedCents) lo = mid;
    else hi = mid - 1;
  }
  return lo / 100;
}
