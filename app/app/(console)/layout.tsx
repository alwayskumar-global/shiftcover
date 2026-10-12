import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getApiDeps } from '@/api/deps';
import { buildMe } from '@/api/handlers';
import { requireManager } from '@/auth/guards';
import { ConsoleShell } from '@/features/manager/ConsoleShell';
import type { MeResponse } from '@/api/dto';

export const dynamic = 'force-dynamic';

/** Server-side session check for every console page (the proxy only checks that a cookie exists). */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const deps = getApiDeps();
  let me: MeResponse | null = null;
  try {
    const ctx = await requireManager(deps.auth, deps.svc.db, await headers());
    me = await buildMe(deps, ctx);
  } catch {
    me = null;
  }
  if (!me) redirect('/app/login');
  return <ConsoleShell me={me}>{children}</ConsoleShell>;
}
