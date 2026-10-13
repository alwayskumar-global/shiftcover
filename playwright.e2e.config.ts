import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { E2E_PORT } from './e2e/env';

/** Gate 1 end-to-end: stub payments, throwaway local database (`npm run e2e` prepares it first). */
export default defineConfig({
  testDir: './e2e/flows',
  // Outside the project: files appearing inside it make the dev server hot-reload the page mid-test.
  outputDir: join(tmpdir(), 'shiftcover-e2e-results'),
  timeout: 120_000,
  workers: 1,
  // The dev server compiles each route on first visit (the roster pulls in Bryntum), so allow for it.
  expect: { timeout: 60_000 },
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${E2E_PORT}`, reducedMotion: 'reduce' },
  // Servers are started by e2e/run.ts (see there).
});
