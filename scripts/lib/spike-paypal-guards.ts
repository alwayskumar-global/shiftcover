import { z } from 'zod';
import { PAYPAL_SANDBOX_BASE } from '../../src/paypal/client';

export const spikeEnvSchema = z.object({
  PAYPAL_ENV: z.literal('sandbox').default('sandbox'),
  PAYPAL_API_BASE: z.string().default(PAYPAL_SANDBOX_BASE),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_PLATFORM_EMAIL: z.email(),
  /** Sandbox US Personal account that receives the payout. Must differ from the platform account. */
  SPIKE_WORKER_EMAIL: z.email(),
});
export type SpikeEnv = z.infer<typeof spikeEnvSchema>;

export type GuardResult = { ok: true; env: SpikeEnv } | { ok: false; problems: string[] };

/** Startup guard: names only in messages, never values. */
export function checkSpikeEnv(source: Record<string, string | undefined>): GuardResult {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = spikeEnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    return {
      ok: false,
      problems: [
        ...new Set(parsed.error.issues.map((i) => `${i.path.join('.')} missing or invalid`)),
      ],
    };
  }
  const env = parsed.data;
  const problems: string[] = [];
  if (env.PAYPAL_API_BASE.replace(/\/+$/, '') !== PAYPAL_SANDBOX_BASE) {
    problems.push('PAYPAL_API_BASE is not the PayPal sandbox base URL');
  }
  if (
    env.SPIKE_WORKER_EMAIL.trim().toLowerCase() === env.PAYPAL_PLATFORM_EMAIL.trim().toLowerCase()
  ) {
    problems.push(
      'SPIKE_WORKER_EMAIL equals PAYPAL_PLATFORM_EMAIL (payout to self is rejected by PayPal)',
    );
  }
  return problems.length ? { ok: false, problems } : { ok: true, env };
}
