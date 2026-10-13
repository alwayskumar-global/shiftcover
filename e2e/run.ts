import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E2E_PORT, serverEnv } from './env';

/**
 * `npm run e2e`: prepares the throwaway database, starts the web app (dev mode, stub payments) and the worker,
 * runs the Playwright flow, then stops both. The servers are started here rather than by Playwright's webServer
 * because a server spawned by the test runner hot-reloaded the page in a loop.
 */
const env = { ...process.env, ...serverEnv };
const procs: ChildProcess[] = [];
// Server output goes to a file (not the terminal) so a failed run can be diagnosed.
const logFile = join(tmpdir(), 'shiftcover-e2e-server.log');
const logFd = openSync(logFile, 'w');
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

/** The dev server compiles each route on first hit (the roster pulls in Bryntum, sign-in pulls in Better Auth). Hitting them
 * once up front, with a throwaway cookie and a wrong password, keeps those compiles out of the test's timeouts. */
async function warm() {
  const base = `http://127.0.0.1:${E2E_PORT}`;
  const cookie = { cookie: 'better-auth.session_token=warmup' };
  const hit = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { redirect: 'manual', ...init }).catch(() => undefined);
  await hit('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: 'warmup@example.com', password: 'not-a-real-password' }),
  });
  for (const path of [
    '/app/roster',
    '/app/gaps/new',
    '/app/gaps/00000000-0000-4000-8000-000000000000',
    '/c/warmup',
    '/api/manager/me',
    '/api/manager/roster',
    '/api/manager/gaps/parse',
    '/api/c/warmup',
  ])
    await hit(path, { headers: cookie });
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
  procs.push(spawn('npx', ['tsx', 'src/worker.ts'], { env, stdio: ['ignore', logFd, logFd] }));
  await waitFor(`http://127.0.0.1:${E2E_PORT}/api/health`);
  await warm();
  const r = spawnSync(
    'npx',
    ['playwright', 'test', '-c', 'playwright.e2e.config.ts', ...process.argv.slice(2)],
    {
      env: { ...process.env, E2E_EXTERNAL_SERVER: '1' },
      stdio: 'inherit',
    },
  );
  stop();
  if (r.status) console.error(`server log: ${logFile}`);
  process.exit(r.status ?? 1);
}
main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'failed');
  stop();
  process.exit(1);
});
