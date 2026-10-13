import { getAuth } from '../auth';
import { getServerEnv } from '../config/env';
import { enqueueFromWeb } from '../jobs/send-only';
import { getLlm } from '../llm/runtime';
import { createWhyService } from '../llm/why-worker';
import { buildServiceDeps } from '../services/runtime';
import type { ApiDeps } from './handlers';
import { createRateLimiter } from './rate-limit';

let cached: ApiDeps | undefined;
const limiter = createRateLimiter();

/** Production wiring for the route handlers. Web enqueues through the send-only pg-boss on the web pool. */
export function getApiDeps(): ApiDeps {
  if (!cached) {
    const env = getServerEnv();
    const llm = getLlm();
    cached = {
      svc: buildServiceDeps((name, data, options) => enqueueFromWeb(name, data, options)),
      auth: getAuth(),
      limiter,
      sessionSecret: env.SESSION_SECRET,
      production: env.NODE_ENV === 'production',
      paymentsMode: env.PAYMENTS_MODE,
      paypalEnv: env.PAYPAL_ENV,
      paypalClientId: env.PAYMENTS_MODE === 'paypal' ? env.PAYPAL_CLIENT_ID : undefined,
      maxPremiumPctDefault: env.MAX_PREMIUM_PCT_DEFAULT,
      llm,
      why: createWhyService({ llm }),
    };
  }
  return cached;
}
