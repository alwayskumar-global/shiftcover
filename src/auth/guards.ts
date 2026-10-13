import { eq } from 'drizzle-orm';
import { HttpError } from '../api/http';
import type { Db } from '../db/client';
import { users } from '../db/schema';
import { AUTH_PROVIDER, type Auth } from './index';

export interface ManagerContext {
  userId: string;
  orgId: string;
  role: 'manager';
  email: string;
  name: string;
}

/**
 * Resolve the Better Auth session to OUR user row (org + role live on `users`, linked by auth_subject).
 * 401 with no session; 403 when the session has no provisioned manager row.
 */
export async function requireManager(
  auth: Auth,
  db: Db,
  headers: Headers,
): Promise<ManagerContext> {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new HttpError(401, 'unauthenticated', 'Sign in required');
  const [u] = await db.select().from(users).where(eq(users.authSubject, session.user.id));
  if (!u || u.authProvider !== AUTH_PROVIDER || u.role !== 'manager') {
    throw new HttpError(403, 'forbidden', 'Not a manager of any organisation');
  }
  return { userId: u.id, orgId: u.orgId, role: 'manager', email: u.email, name: session.user.name };
}
