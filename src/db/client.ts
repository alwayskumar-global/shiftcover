import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getServerEnv } from '../config/env';
import * as schema from './schema';

let pool: Pool | undefined;

export function getPool(): Pool {
  return (pool ??= new Pool({ connectionString: getServerEnv().DATABASE_URL, max: 10 }));
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
