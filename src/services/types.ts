import type { Db } from '../db/client';
import type { Notifier } from './notifier';
import type { JobName } from '../jobs/names';
import type { PaymentsGateway } from '../paypal/gateway';

/** A Drizzle transaction handle. Services accept either a Db or a Tx. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbLike = Db | Tx;

export type Enqueue = (
  name: JobName,
  data: object,
  options?: { singletonKey?: string; startAfter?: number },
) => Promise<unknown>;

export interface ServiceDeps {
  db: Db;
  /** Build a Notifier bound to a handle (so notifications commit with the transaction that caused them). */
  notifier: (h: DbLike) => Notifier;
  enqueue: Enqueue;
  now: () => Date;
  config: {
    appBaseUrl: string;
    tokenPepper: string;
    offerTtlSeconds: number;
    waveIntervalSeconds: number;
    platformFeeBps: number;
    /** Flat fee per shift in cents (PLATFORM_FIXED_FEE_CENTS); absent means none. */
    platformFixedFeeCents?: number;
    /** PAYMENTS_MODE. 'stub' (never in production: env.ts refuses it) lets local runs settle without PayPal. */
    paymentsMode?: 'paypal' | 'stub';
  };
  /** Real PayPal calls. Undefined in PAYMENTS_MODE=stub (state and ledger only). */
  payments?: PaymentsGateway;
}

export class ServiceError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'forbidden'
      | 'invalid_input'
      | 'payment_not_authorized'
      | 'invalid_state'
      | 'stub_disabled'
      | 'payment_failed'
      | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
