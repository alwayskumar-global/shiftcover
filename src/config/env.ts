import { z } from 'zod';

/**
 * Server-side environment. Contains secrets: never import from client components.
 * Fails fast with a message that lists variable names and issue codes only, never values.
 */

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
export const ALLOWED_LLM_MODEL = 'gemini-3.5-flash-lite';

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const serverSchema = z
  .object({
    APP_BASE_URL: z.url().default('http://localhost:3000'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DEMO_MODE: z.stringbool().default(false),

    DATABASE_URL: z.string().min(1),
    SESSION_SECRET: z.string().min(32),
    CLAIM_TOKEN_PEPPER: z.string().min(32),

    PAYPAL_ENV: z.literal('sandbox').default('sandbox'),
    PAYPAL_API_BASE: z.literal(SANDBOX_BASE).default(SANDBOX_BASE),
    PAYPAL_CLIENT_ID: z.string().min(1).optional(),
    PAYPAL_CLIENT_SECRET: z.string().min(1).optional(),
    PAYPAL_WEBHOOK_ID: z.string().min(1).optional(),
    PAYPAL_PLATFORM_EMAIL: z.email().optional(),

    LLM_PROVIDER: z.literal('gemini').default('gemini'),
    GEMINI_API_KEY: z.string().min(1).optional(),
    LLM_MODEL: z.literal(ALLOWED_LLM_MODEL).default(ALLOWED_LLM_MODEL),
    LLM_ENABLED: z.stringbool().default(true),
    LLM_MAX_OUTPUT_TOKENS: int(1024, 1),
    LLM_DAILY_CALL_CAP: int(500),
    LLM_PER_USER_HOURLY_CAP: int(20),

    VAPID_PUBLIC_KEY: z.string().min(1).optional(),
    VAPID_PRIVATE_KEY: z.string().min(1).optional(),
    VAPID_SUBJECT: z.string().startsWith('mailto:').optional(),

    EMAIL_PROVIDER: z.string().min(1).optional(),
    EMAIL_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(1).optional(),

    WAVE_INTERVAL_SECONDS: int(300, 1),
    PLATFORM_FEE_BPS: int(500).pipe(z.number().max(10_000)),
    MAX_PREMIUM_PCT_DEFAULT: int(20).pipe(z.number().max(100)),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const need: Array<keyof typeof env> = [
      'PAYPAL_CLIENT_ID',
      'PAYPAL_CLIENT_SECRET',
      'PAYPAL_WEBHOOK_ID',
      'PAYPAL_PLATFORM_EMAIL',
    ];
    if (env.LLM_ENABLED) need.push('GEMINI_API_KEY');
    for (const key of need) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'required in production' });
      }
    }
  });

const publicSchema = z.object({
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: z.string().min(1).optional(),
});

export type ServerEnv = z.infer<typeof serverSchema>;
export type PublicEnv = z.infer<typeof publicSchema>;

export class EnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment: ${issues.join('; ')}`);
    this.name = 'EnvError';
  }
}

type Source = Record<string, string | undefined>;

/** Treat blank values (as in .env.example placeholders) as unset. */
function clean(source: Source): Source {
  return Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
}

function parse<T extends z.ZodType>(schema: T, source: Source): z.infer<T> {
  const result = schema.safeParse(clean(source));
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`),
    );
  }
  return result.data;
}

export function parseServerEnv(source: Source): ServerEnv {
  return parse(serverSchema, source);
}

export function parsePublicEnv(source: Source): PublicEnv {
  return parse(publicSchema, source);
}

let cachedServer: ServerEnv | undefined;
let cachedPublic: PublicEnv | undefined;

export function getServerEnv(): ServerEnv {
  return (cachedServer ??= parseServerEnv(process.env));
}

export function getPublicEnv(): PublicEnv {
  // NEXT_PUBLIC_* must be referenced statically so Next can inline them in client bundles.
  return (cachedPublic ??= parsePublicEnv({
    NEXT_PUBLIC_PAYPAL_CLIENT_ID: process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID,
  }));
}

export type PaypalEnv = ServerEnv & {
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_PLATFORM_EMAIL: string;
};

/** Fail fast where PayPal credentials are actually needed. */
export function requirePaypalEnv(env: ServerEnv = getServerEnv()): PaypalEnv {
  const missing = (['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_PLATFORM_EMAIL'] as const)
    .filter((k) => env[k] === undefined)
    .map((k) => `${k}: required`);
  if (missing.length) throw new EnvError(missing);
  return env as PaypalEnv;
}

export type GeminiEnv = ServerEnv & { GEMINI_API_KEY: string };

export function requireGeminiEnv(env: ServerEnv = getServerEnv()): GeminiEnv {
  if (env.GEMINI_API_KEY === undefined) throw new EnvError(['GEMINI_API_KEY: required']);
  return env as GeminiEnv;
}

/** Test helper. */
export function resetEnvCache(): void {
  cachedServer = undefined;
  cachedPublic = undefined;
}
