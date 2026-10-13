import { getServerEnv } from '../config/env';
import { createPaypalClient } from '../paypal/client';
import { createPaypalGateway, type PaymentsGateway } from '../paypal/gateway';
import { getDb } from '../db/client';
import { outboxNotifier } from './notifier';
import type { Enqueue, ServiceDeps } from './types';

/** The real PayPal gateway, only in PAYMENTS_MODE=paypal and only when credentials exist (sandbox base is enforced). */
function buildGateway(env: ReturnType<typeof getServerEnv>): PaymentsGateway | undefined {
  if (env.PAYMENTS_MODE !== 'paypal') return undefined;
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET || !env.PAYPAL_PLATFORM_EMAIL) {
    console.error(
      '[payments] PAYMENTS_MODE=paypal but PayPal credentials are not set; money endpoints answer 503',
    );
    return undefined;
  }
  const client = createPaypalClient({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    baseUrl: env.PAYPAL_API_BASE,
  });
  return createPaypalGateway(client, { platformEmail: env.PAYPAL_PLATFORM_EMAIL });
}

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
      platformFixedFeeCents: env.PLATFORM_FIXED_FEE_CENTS,
      paymentsMode: env.PAYMENTS_MODE,
    },
    payments: buildGateway(env),
  };
}
