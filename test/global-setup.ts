import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * DB-backed tests run against a THROWAWAY local Postgres (scripts/test-db.sh up), never Supabase.
 * TEST_DATABASE_URL must point at localhost; the public schema is wiped and re-migrated once per run.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('TEST_DATABASE_URL must be a local database');
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(
      'drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;',
    );
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  } finally {
    await pool.end();
  }
}
