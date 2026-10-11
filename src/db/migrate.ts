import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import 'dotenv/config';
import { getServerEnv } from '../config/env';

/** Applies ./drizzle migrations to DATABASE_URL. Run explicitly; never run against a remote DB by accident. */
async function main() {
  const { DATABASE_URL } = getServerEnv();
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
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
