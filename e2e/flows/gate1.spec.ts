import { expect, test } from '@playwright/test';
import { MANAGER_EMAIL, MANAGER_PASSWORD, localPool } from './../env';

// The brief's note is "... 7 to 3 today". A shift that has already started has no time left to offer it in (the fill
// deadline fires at once), so after 06:00 venue time the run says "tomorrow" instead; the parser path is identical.
const venueHour = Number(
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(new Date()),
);
const DAY = venueHour < 6 ? 'today' : 'tomorrow';
const NOTE = `Maria called in sick, need a line cook 7 to 3 ${DAY}`;

async function waveOneLinks(): Promise<string[]> {
  const pool = localPool();
  try {
    for (let i = 0; i < 40; i++) {
      const { rows } = await pool.query<{ link: string }>(
        `select payload->>'link' as link from notifications
         where payload->>'kind' = 'offer' and (payload->>'wave')::int = 1 and channel = 'email'
         order by created_at, id`,
      );
      if (rows.length >= 2) return rows.map((r) => r.link);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('no wave 1 offers in the outbox');
  } finally {
    await pool.end();
  }
}

test('manager reports a gap, a worker claims it on a phone, a second worker sees it taken', async ({
  browser,
  page,
}) => {
  // 1. manager signs in
  await page.goto('/app/login');
  // wait until React has attached to the form, so submit runs the handler (dev server compiles lazily)
  await page.waitForFunction(() => {
    const f = document.querySelector('form');
    return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps'));
  });
  await page.fill('#login-email', MANAGER_EMAIL);
  await page.fill('#login-password', MANAGER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app\/roster/);

  // 2. roster renders the themed scheduler
  await expect(page.getByRole('heading', { name: 'Roster' })).toBeVisible();
  await expect(page.locator('.b-scheduler').first()).toBeVisible();

  // 3. report the gap
  await page
    .getByRole('link', { name: /Report a gap/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/app\/gaps\/new/);
  await page.fill('#nl', NOTE);
  await page.getByRole('button', { name: 'Parse' }).click();
  await expect(page.locator('#f-start')).toHaveValue('07:00');
  await expect(page.locator('#f-end')).toHaveValue('15:00');
  await expect(page.locator('#f-role')).toHaveValue('line_cook');
  await page.getByRole('button', { name: 'Details are correct' }).click();

  // 4. stub-authorize and start offering (stub mode only)
  const approve = page.getByTestId('stub-approve');
  await expect(approve).toBeVisible();
  await expect(approve).toHaveAttribute('aria-busy', 'false');
  await approve.click();
  await expect(page.getByText(/on hold/).first()).toBeVisible();
  await page.getByRole('link', { name: /View gap/ }).click();
  await expect(page).toHaveURL(/\/app\/gaps\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { name: 'A · Offer waves' })).toBeVisible();

  // 5. wave 1 goes out via the worker; links come from the outbox
  const links = await waveOneLinks();
  const [first, second] = links as [string, string];
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phonePage = await phone.newPage();
  await phonePage.goto(first);
  await expect(phonePage.getByRole('button', { name: /Claim this shift/ })).toBeVisible();
  const overflow = await phonePage.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await phonePage.getByRole('button', { name: /Claim this shift/ }).click();
  await expect(phonePage.getByText("You're booked.")).toBeVisible({ timeout: 15_000 });

  // 6. the manager's gap detail shows the slot filled (3 s polling)
  await expect(page.getByText('Confirmed').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/claimed this/).first()).toBeVisible();

  // 7. a second worker opening another link sees "taken"
  const other = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const otherPage = await other.newPage();
  await otherPage.goto(second);
  await expect(otherPage.getByText('Someone else just claimed this shift')).toBeVisible();
  await phone.close();
  await other.close();
});
