import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { E2E_PORT, serverEnv } from './env';

/**
 * `npm run e2e`: prepares the throwaway database, starts the web app (dev mode, stub payments) and the worker,
 * runs the Playwright flow, then stops both. The servers are started here rather than by Playwright's webServer
 * because a server spawned by the test runner hot-reloaded the page in a loop.
 */
const env = { ...process.env, ...serverEnv };
const procs: ChildProcess[] = [];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('exit', stop);

async function waitFor(url: string, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function main() {
  if (spawnSync('npx', ['tsx', 'e2e/setup-db.ts'], { env, stdio: 'inherit' }).status !== 0)
    process.exit(1);
  procs.push(
    spawn('npx', ['next', 'dev', '-p', String(E2E_PORT), '-H', '127.0.0.1'], {
      env,
      stdio: 'ignore',
    }),
  );
  procs.push(spawn('npx', ['tsx', 'src/worker.ts'], { env, stdio: 'ignore' }));
  await waitFor(`http://127.0.0.1:${E2E_PORT}/api/health`);
  const r = spawnSync(
    'npx',
    ['playwright', 'test', '-c', 'playwright.e2e.config.ts', ...process.argv.slice(2)],
    {
      env: { ...process.env, E2E_EXTERNAL_SERVER: '1' },
      stdio: 'inherit',
    },
  );
  stop();
  process.exit(r.status ?? 1);
}
main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'failed');
  stop();
  process.exit(1);
});
