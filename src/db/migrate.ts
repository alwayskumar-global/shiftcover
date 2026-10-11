import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { getServerEnv } from '../config/env';
import { buildPoolConfig } from './connection';

/**
 * Applies ./drizzle migrations to DATABASE_URL (Supabase session pooler, validated by env.ts).
 * Run explicitly from your machine: `npm run db:migrate`. Never prints the connection string.
 */
async function main() {
  const { DATABASE_URL } = getServerEnv();
  const pool = new Pool(buildPoolConfig(DATABASE_URL, 'migrate'));
  try {
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('migration failed:', err instanceof Error ? err.message : 'unknown error');
  process.exit(1);
});
