import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getApiDeps } from '@/api/deps';
import { requireManager } from '@/auth/guards';
import { LoginExperience } from '@/features/manager/LoginExperience';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign in · ShiftCover Pay' };

/**
 * A manager who already has a valid session goes straight to the console. The check is the same server-side one the
 * console layout uses (cookie -> Better Auth session -> provisioned manager row), so a stale or foreign cookie still
 * shows the form and can never loop.
 */
export default async function LoginPage() {
  let signedIn = false;
  try {
    const deps = getApiDeps();
    await requireManager(deps.auth, deps.svc.db, await headers());
    signedIn = true;
  } catch {
    signedIn = false;
  }
  if (signedIn) redirect('/app/roster');
  return <LoginExperience />;
}
