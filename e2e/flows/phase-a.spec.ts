import { expect, test } from '@playwright/test';
import type { Pool } from 'pg';
import { MANAGER_EMAIL, MANAGER_PASSWORD, assertLoopback, localPool } from './../env';

/**
 * G2 demo blockers, stub mode, local throwaway database: claim -> My shifts -> arrive -> finish -> manager approves.
 * Stub mode settles in state and ledger only (no PayPal). The live PayPal path is verified separately by hand.
 * The shift is moved into "now" directly in the throwaway database so the arrive button is available today.
 */
const venueHour = Number(
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(new Date()),
);
const DAY = venueHour < 6 ? 'today' : 'tomorrow';
const NOTE = `Maria called in sick, need a line cook 7 to 3 ${DAY}`;

async function withDb<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = localPool();
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function firstOfferLink(slotId: string): Promise<string> {
  return withDb(async (pool) => {
    for (let i = 0; i < 40; i++) {
      const { rows } = await pool.query<{ link: string }>(
        `select payload->>'link' as link from notifications
         where payload->>'kind' = 'offer' and payload->>'slotId' = $1 and (payload->>'wave')::int = 1 and channel = 'email'
         order by created_at, id`,
        [slotId],
      );
      if (rows.length >= 1) return assertLoopback(rows[0]!.link, 'offer link'); // never open a non-local link
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('no wave 1 offer in the outbox');
  });
}

test('claim -> My shifts -> arrive -> finish -> approve and pay -> Paid -> Earnings -> Profile email change -> Ledger -> Workers', async ({
  browser,
  page,
}) => {
  // manager reports the gap and starts offering
  await page.goto('/app/login');
  await page.waitForFunction(() => {
    const f = document.querySelector('form');
    return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps'));
  });
  await page.fill('#login-email', MANAGER_EMAIL);
  await page.fill('#login-password', MANAGER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app\/roster/);
  // already signed in: the login page sends the manager to the console instead of showing the form
  await page.goto('/app/login');
  await expect(page).toHaveURL(/\/app\/roster/);
  await page
    .getByRole('link', { name: /Report a gap/ })
    .first()
    .click();
  await page.fill('#nl', NOTE);
  await page.getByRole('button', { name: 'Parse' }).click();
  await expect(page.locator('#f-start')).toHaveValue('07:00');
  await page.getByRole('button', { name: 'Details are correct' }).click();
  const approve = page.getByTestId('stub-approve');
  await expect(approve).toHaveAttribute('aria-busy', 'false');
  await approve.click();
  await page.getByRole('link', { name: /View gap/ }).click();
  await expect(page).toHaveURL(/\/app\/gaps\/[0-9a-f-]{36}/);
  const slotId = page.url().split('/').pop()!;
  // M3: the top candidates with a reason each; Gemini is off in e2e, so these are the deterministic templates
  await expect(page.getByRole('heading', { name: 'Best matches' })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Best matches' }).getByRole('listitem').first(),
  ).toContainText(/Line cook,/);

  // the first worker claims on a phone, then follows "Go to My shifts"
  const link = await firstOfferLink(slotId);
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const w = await phone.newPage();
  await w.goto(link);
  await w.getByRole('button', { name: /Claim this shift/ }).click();
  await expect(w.getByText("You're booked.")).toBeVisible({ timeout: 15_000 });
  await w.getByRole('link', { name: /Go to My shifts/ }).click();
  await expect(w).toHaveURL(/\/w$/);
  await expect(w.getByRole('heading', { name: 'My shifts' })).toBeVisible();
  await expect(w.getByRole('region', { name: 'Upcoming' })).toBeVisible();
  expect(await w.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );

  // move the shift into "now" (local throwaway database) so it is the active shift
  await withDb((pool) =>
    pool.query(
      `update shift_slots set start_at = now() - interval '30 minutes', end_at = now() + interval '7 hours 30 minutes' where id = $1`,
      [slotId],
    ),
  );
  await w.reload();
  await expect(w.getByRole('region', { name: 'Active now' })).toBeVisible();
  await w.getByRole('button', { name: "I've arrived" }).click();
  await expect(w.getByRole('button', { name: 'Finished' })).toBeVisible();
  await expect(w.getByText('On shift').first()).toBeVisible();
  await w.getByRole('button', { name: 'Finished' }).click();
  await w.getByRole('button', { name: /Yes, I'm finished/ }).click();
  await expect(w.getByText('Waiting for approval').first()).toBeVisible();

  // the manager approves the hours
  await page.goto('/app/approvals');
  const card = page.getByRole('article').filter({ hasText: 'Line cook' }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText('Capture will charge')).toBeVisible();
  // the compressed run worked ~0 hours: the manager sets the hours to approve
  await card.getByRole('button', { name: /Use scheduled/ }).click();
  await card.getByRole('button', { name: /Approve and pay/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve and pay' }).click();
  await expect(card.getByText('Approved', { exact: true }).first()).toBeVisible();

  // the worker sees it paid
  await w.reload();
  await expect(w.getByText('Paid', { exact: true }).first()).toBeVisible();

  // G2-W4 earnings: the paid shift, the worker's own pay and a payout reference; no employer amounts
  await w.getByRole('link', { name: 'Earnings' }).click();
  await expect(w).toHaveURL(/\/w\/earnings$/);
  await expect(w.getByRole('heading', { name: 'Earnings' })).toBeVisible();
  await expect(w.getByText('This week')).toBeVisible();
  const earn = w.getByRole('article').filter({ hasText: 'Line cook' }).first();
  await expect(earn.getByText('Paid', { exact: true })).toBeVisible();
  await expect(earn.getByRole('button', { name: /Copy PayPal payout reference/ })).toContainText(
    'STUB-PAYOUT',
  );
  expect(await w.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );

  // G2-W5 profile: change the payout email with the code from the Outbox
  await w.getByRole('link', { name: 'Profile' }).click();
  await expect(w).toHaveURL(/\/w\/profile$/);
  await expect(w.getByRole('button', { name: 'Line cook' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await w.getByRole('button', { name: 'Change' }).click();
  await w.fill('#new-email', 'e2e.payout@example.com');
  await w.getByRole('button', { name: 'Send code' }).click();
  await expect(w.getByLabel('6-digit code')).toBeVisible();
  await page.goto('/app/outbox');
  const codeCell = page.getByRole('row').filter({ hasText: 'payout email code' }).first();
  await expect(codeCell).toBeVisible();
  const code = (await codeCell.locator('.sc-ref').innerText()).trim();
  expect(code).toMatch(/^\d{6}$/);
  await w.fill('#otp', code === '000000' ? '111111' : '000000'); // a wrong code first
  await w.getByRole('button', { name: 'Confirm new email' }).click();
  await expect(w.getByText(/That code isn't right/)).toBeVisible();
  await w.fill('#otp', code);
  await w.getByRole('button', { name: 'Confirm new email' }).click();
  await expect(w.getByText('Payout email updated')).toBeVisible();
  await expect(w.getByText('e2e.payout@example.com').first()).toBeVisible();
  await phone.close();

  // G2-M6 ledger: the paid shift, then its breakdown
  await page.goto('/app/ledger');
  await expect(page.getByRole('heading', { name: 'Money' })).toBeVisible();
  // the first scenario in this run left a held shift too: pick this run's paid one
  const row = page
    .getByRole('row')
    .filter({ hasText: 'Line cook' })
    .filter({ has: page.getByText('Paid', { exact: true }) })
    .first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /Open breakdown/ }).click();
  const panel = page.getByRole('dialog', { name: 'Shift breakdown' });
  await expect(panel.getByText('Charged to you')).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Ledger entries' })).toContainText(
    'Payout delivered',
  );
  await page.keyboard.press('Escape');

  // G2-M7 workers: the directory, then an invite
  await page.goto('/app/workers');
  await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible();
  await page.fill('#inv-email', 'e2e.invite@example.com');
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByText('Invite sent to e2e.invite@example.com')).toBeVisible();
  await expect(page.getByText(/Invited · e2e.invite@example.com/)).toBeVisible();
  await page.fill('#inv-email', 'e2e.invite@example.com');
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByText('You already invited this email')).toBeVisible();
});
