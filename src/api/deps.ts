import { getAuth } from '../auth';
import { getServerEnv } from '../config/env';
import { enqueueFromWeb } from '../jobs/send-only';
import { buildServiceDeps } from '../services/runtime';
import type { ApiDeps } from './handlers';
import { createRateLimiter } from './rate-limit';

let cached: ApiDeps | undefined;
const limiter = createRateLimiter();

/** Production wiring for the route handlers. Web enqueues through the send-only pg-boss on the web pool. */
export function getApiDeps(): ApiDeps {
  if (!cached) {
    const env = getServerEnv();
    cached = {
      svc: buildServiceDeps((name, data, options) => enqueueFromWeb(name, data, options)),
      auth: getAuth(),
      limiter,
      sessionSecret: env.SESSION_SECRET,
      production: env.NODE_ENV === 'production',
      paymentsMode: env.PAYMENTS_MODE,
      maxPremiumPctDefault: env.MAX_PREMIUM_PCT_DEFAULT,
    };
  }
  return cached;
}
