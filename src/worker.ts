import 'dotenv/config';
import { getServerEnv } from './config/env';
import { configurePool } from './db/client';
import { createBoss, startJobs } from './jobs';
import { serviceHandlers } from './jobs/service-handlers';
import { buildServiceDeps } from './services/runtime';

/** Separate entrypoint for the Render background worker: `npm run worker`. */
async function main() {
  const env = getServerEnv();
  configurePool('worker');
  const boss = createBoss(env.DATABASE_URL);
  const deps = buildServiceDeps(async (name, data, options) => boss.send(name, data, options));
  await startJobs(boss, serviceHandlers(deps));
  console.log('worker started');

  const shutdown = async (signal: string) => {
    console.log(`worker received ${signal}, stopping`);
    await boss.stop({ graceful: true });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('worker failed:', err instanceof Error ? err.message : 'unknown error');
  process.exit(1);
});
