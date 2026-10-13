import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { authAccount, authUser, users } from '../db/schema';
import { AUTH_PROVIDER, type Auth } from './index';

/**
 * Provision (or update) a manager: Better Auth identity + credential account, linked to our `users` row
 * through auth_subject. Sign-up is disabled in the app, so this server-side path is the only way in.
 * The password is hashed with Better Auth's own hasher; it is never logged or stored in plain text.
 */
export async function provisionManager(
  db: Db,
  auth: Auth,
  input: { orgId: string; email: string; name: string; password: string },
) {
  const email = input.email.toLowerCase();
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(input.password);
  return db.transaction(async (tx) => {
    const [existingUser] = await tx.select().from(users).where(eq(users.email, email));
    let authId: string;
    const [existingAuth] = await tx.select().from(authUser).where(eq(authUser.email, email));
    if (existingAuth) {
      authId = existingAuth.id;
      await tx.update(authAccount).set({ password: hash }).where(eq(authAccount.userId, authId));
    } else {
      authId = randomUUID();
      await tx
        .insert(authUser)
        .values({ id: authId, name: input.name, email, emailVerified: true });
      await tx.insert(authAccount).values({
        id: randomUUID(),
        accountId: authId,
        providerId: 'credential',
        userId: authId,
        password: hash,
      });
    }
    if (existingUser) {
      await tx
        .update(users)
        .set({ authProvider: AUTH_PROVIDER, authSubject: authId })
        .where(eq(users.id, existingUser.id));
      return { userId: existingUser.id, authId };
    }
    const [u] = await tx
      .insert(users)
      .values({
        orgId: input.orgId,
        email,
        role: 'manager',
        authProvider: AUTH_PROVIDER,
        authSubject: authId,
      })
      .returning({ id: users.id });
    return { userId: u!.id, authId };
  });
}
