import type { Db } from '../db/client';
import type { Notifier } from './notifier';
import type { JobName } from '../jobs/names';

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
  };
}

export class ServiceError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'forbidden'
      | 'invalid_input'
      | 'payment_not_authorized'
      | 'invalid_state'
      | 'stub_disabled',
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
