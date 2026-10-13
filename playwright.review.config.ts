import { defineConfig } from '@playwright/test';

/** axe + visual checks over the /review harness. Fixture data only: no database, no secrets needed. */
export default defineConfig({
  testDir: './e2e/review',
  timeout: 120_000, // the first scene compiles the route on a cold dev server
  workers: 2,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:3210', colorScheme: 'light', reducedMotion: 'reduce' },
  webServer: {
    command: 'npx next dev -p 3210 -H 127.0.0.1',
    url: 'http://127.0.0.1:3210/review',
    reuseExistingServer: true,
    timeout: 120_000,
    env: { UI_REVIEW: 'true' },
  },
});
