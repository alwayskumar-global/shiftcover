import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { magicLink } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { getServerEnv } from '../config/env';
import { getDb, type Db } from '../db/client';
import { authAccount, authSession, authUser, authVerification, users } from '../db/schema';
import { MAGIC_LINK_TTL_MINUTES } from '../config/business';
import { outboxNotifier, type Notifier } from '../services/notifier';

/**
 * Manager auth (PLAN.md 2): Better Auth, email+password and magic link. Sign-up is disabled everywhere:
 * managers are provisioned by the seed/admin path, which links auth_user.id to users.auth_subject.
 * Magic links go through the Notifier (Outbox) because no email provider exists yet.
 */
export const AUTH_PROVIDER = 'better-auth';

export interface AuthOptions {
  db: Db;
  secret: string;
  baseURL: string;
  production: boolean;
  notifier?: (db: Db) => Notifier;
  /** Magic-link lifetime in seconds. */
  magicLinkTtl?: number;
  rateLimit?: boolean;
}

export function createAuth(o: AuthOptions) {
  const notify = o.notifier ?? outboxNotifier;
  return betterAuth({
    database: drizzleAdapter(o.db, {
      provider: 'pg',
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification,
      },
    }),
    secret: o.secret,
    baseURL: o.baseURL,
    trustedOrigins: [new URL(o.baseURL).origin],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    advanced: {
      useSecureCookies: o.production,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: o.production },
    },
    // In-memory counters are fine for the single Render web instance; move to the database if scaled out.
    rateLimit: {
      enabled: o.rateLimit ?? true,
      window: 60,
      max: 60,
      storage: 'memory',
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-in/magic-link': { window: 60, max: 3 },
        '/magic-link/verify': { window: 60, max: 10 },
      },
    },
    plugins: [
      magicLink({
        disableSignUp: true,
        expiresIn: o.magicLinkTtl ?? MAGIC_LINK_TTL_MINUTES * 60,
        sendMagicLink: async ({ email, url }) => {
          // Only provisioned managers get a link; unknown emails get nothing (and no hint either way).
          const [m] = await o.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, email.toLowerCase()));
          if (!m) return;
          await notify(o.db).send({
            recipient: `email:${email.toLowerCase()}`,
            channels: ['email'],
            kind: 'sign_in_link',
            payload: { url, expiresInSeconds: o.magicLinkTtl ?? MAGIC_LINK_TTL_MINUTES * 60 },
          });
        },
      }),
      nextCookies(), // keep last
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let cached: Auth | undefined;
export function getAuth(): Auth {
  if (!cached) {
    const env = getServerEnv();
    cached = createAuth({
      db: getDb(),
      secret: env.SESSION_SECRET,
      baseURL: env.APP_BASE_URL,
      production: env.NODE_ENV === 'production',
    });
  }
  return cached;
}
