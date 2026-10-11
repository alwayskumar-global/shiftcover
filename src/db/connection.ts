import type { PoolConfig } from 'pg';

/**
 * Connection budget (PLAN.md 6A): the Supabase free-plan session pooler has a small pool, so the
 * whole app stays at 10 connections or fewer:
 *
 *   web app pool      5   (pg-boss enqueues from web later reuse this pool via its `db` option)
 *   worker app pool   3
 *   worker pg-boss    2
 *   ---------------------
 *   total            10   (migrations run from a laptop with a transient 1-connection pool)
 *
 * Session mode (port 5432) is required: it keeps prepared statements, advisory locks and
 * LISTEN/NOTIFY, which pg-boss needs. Never use the transaction pooler (6543).
 */
export const POOL_MAX = { web: 5, worker: 3, boss: 2, migrate: 1 } as const;
export const TOTAL_APP_CONNECTIONS = POOL_MAX.web + POOL_MAX.worker + POOL_MAX.boss;

export type PoolRole = keyof typeof POOL_MAX;

/**
 * TLS is mandatory. Supabase's pooler certificate chain is not in Node's default CA bundle, so we
 * encrypt without chain verification (same as libpq sslmode=require). To verify, download the
 * project CA from the Dashboard and pass it as `ca`.
 *
 * `sslmode` is stripped from the URL because pg lets a URL-embedded sslmode override this option.
 */
export function buildPoolConfig(databaseUrl: string, role: PoolRole): PoolConfig {
  const url = new URL(databaseUrl);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return {
    connectionString: url.toString(),
    max: POOL_MAX[role],
    ssl: { rejectUnauthorized: false },
  };
}
