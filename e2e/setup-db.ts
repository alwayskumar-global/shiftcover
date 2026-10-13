import { spawnSync } from 'node:child_process';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { E2E_DB, localPool, serverEnv } from './env';

/** Fresh throwaway database on the local test Postgres: create, migrate, seed. Never touches a hosted database. */
async function main() {
  const admin = localPool('admin');
  await admin.query(`drop database if exists ${E2E_DB} with (force)`);
  await admin.query(`create database ${E2E_DB}`);
  await admin.end();
  const pool = localPool();
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
