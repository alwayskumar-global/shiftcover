import { spawnSync } from 'node:child_process';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { ADMIN_URL, E2E_DATABASE_URL, E2E_DB, serverEnv } from './env';

/** Fresh throwaway database on the local test Postgres: create, migrate, seed. Never touches a hosted database. */
async function main() {
  if (new URL(ADMIN_URL).hostname !== '127.0.0.1') throw new Error('local database only');
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  await admin.query(`drop database if exists ${E2E_DB} with (force)`);
  await admin.query(`create database ${E2E_DB}`);
  await admin.end();
  const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 1 });
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  await pool.end();
  const seed = spawnSync('npx', ['tsx', 'scripts/seed.ts'], {
    env: { ...process.env, ...serverEnv },
    stdio: 'inherit',
  });
  if (seed.status !== 0) throw new Error('seed failed');
  console.log('e2e database ready');
}
main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'failed');
  process.exit(1);
});
