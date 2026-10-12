import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Db } from '../src/db/client';
import * as schema from '../src/db/schema';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = !!TEST_DB_URL;

/** A pool + Drizzle handle on the throwaway test database. Call `close()` in afterAll. */
export function createTestDb(max = 25) {
  if (!TEST_DB_URL) throw new Error('TEST_DATABASE_URL is not set (run: npm run test:db)');
  const pool = new Pool({ connectionString: TEST_DB_URL, max });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, pool, close: () => pool.end() };
}
