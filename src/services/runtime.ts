import { getServerEnv } from '../config/env';
import { getDb } from '../db/client';
import { outboxNotifier } from './notifier';
import type { Enqueue, ServiceDeps } from './types';

/** Production wiring of ServiceDeps from validated env. The caller supplies how jobs are enqueued. */
export function buildServiceDeps(enqueue: Enqueue): ServiceDeps {
  const env = getServerEnv();
  return {
    db: getDb(),
    notifier: outboxNotifier,
    enqueue,
    now: () => new Date(),
    config: {
      appBaseUrl: env.APP_BASE_URL,
      tokenPepper: env.CLAIM_TOKEN_PEPPER,
      offerTtlSeconds: env.OFFER_TTL_SECONDS,
      waveIntervalSeconds: env.WAVE_INTERVAL_SECONDS,
      platformFeeBps: env.PLATFORM_FEE_BPS,
    },
  };
}
