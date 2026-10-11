import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getServerEnv } from '../config/env';
import { buildPoolConfig } from './connection';
import * as schema from './schema';

let pool: Pool | undefined;
let role: 'web' | 'worker' = 'web';

/** Call once at process start, before the first query. The worker uses a smaller pool. */
export function configurePool(next: 'web' | 'worker'): void {
  if (pool) throw new Error('configurePool must run before the pool is created');
  role = next;
}

export function getPool(): Pool {
  return (pool ??= new Pool(buildPoolConfig(getServerEnv().DATABASE_URL, role)));
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export type Db = ReturnType<typeof getDb>;

/** True when a trivial query succeeds. Never throws, never exposes connection details. */
export async function pingDb(): Promise<boolean> {
  try {
    await getPool().query('select 1');
    return true;
  } catch {
    return false;
  }
}
