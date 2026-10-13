// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Earnings } from '@/features/worker/Earnings';
import { LedgerScreen } from '@/features/manager/LedgerScreen';
import { Profile } from '@/features/worker/Profile';
import type { LedgerDto, WorkerEarningsDto, WorkerProfileDto } from '@/features/client-api';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

/** Phase B screens render from API-shaped bodies; every figure on screen must be one of these. */
type Handler = (req: { method: string; path: string; body?: unknown }) => {
  status?: number;
  body?: unknown;
};
let calls: Array<{ method: string; path: string; body?: unknown }> = [];
let realFetch: typeof fetch;
function stub(handler: Handler) {
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      location.origin,
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { method: init?.method ?? 'GET', path: u.pathname + u.search, body };
    calls.push(call);
    const r = handler(call);
    if (r.status === -1) throw new TypeError('network');
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
beforeEach(() => {
  calls = [];
  realFetch = window.fetch;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  window.fetch = realFetch;
});

const earn = (over: Partial<WorkerEarningsDto> = {}): WorkerEarningsDto => ({
  server_time: '2026-10-14T23:00:00.000Z',
  week: { total_cents: 19360, paid_cents: 19360, on_the_way_cents: 0 },
  month: { total_cents: 31000, paid_cents: 19360, on_the_way_cents: 11640 },
  failed_cents: 9000,
  items: [
    {
      slot_id: '11111111-1111-4111-8111-111111111111',
      role: 'line_cook',
      venue_name: 'Maple & Rye',
      venue_tz: 'America/Los_Angeles',
      start_at: '2026-10-14T14:00:00.000Z',
      end_at: '2026-10-14T22:00:00.000Z',
      approved_hours: 8,
      rate_cents: 2420,
      worker_pay_cents: 19360,
      status: 'paid',
      reference: 'PAYOUT-ABC123',
    },
    {
      slot_id: '22222222-2222-4222-8222-222222222222',
      role: 'dishwasher',
      venue_name: 'Maple & Rye',
      venue_tz: 'America/Los_Angeles',
      start_at: '2026-10-12T14:00:00.000Z',
      end_at: '2026-10-12T20:00:00.000Z',
      approved_hours: 6,
      rate_cents: 1940,
      worker_pay_cents: 11640,
      status: 'paying',
      reference: 'PAYOUT-DEF456',
    },
    {
      slot_id: '33333333-3333-4333-8333-333333333333',
      role: 'server',
      venue_name: 'Maple & Rye',
      venue_tz: 'America/Los_Angeles',
      start_at: '2026-10-10T14:00:00.000Z',
      end_at: '2026-10-10T20:00:00.000Z',
      approved_hours: 5,
      rate_cents: 1800,
      worker_pay_cents: 9000,
      status: 'failed',
      reference: 'PAYOUT-FAILED1',
    },
  ],
  ...over,
});

describe('G2-W4 earnings', () => {
  it('shows rows with status chips, totals and the failed-payout row with its action', async () => {
    stub(() => ({ body: earn() }));
    render(<Earnings />);
    await screen.findByText('This week');
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Paying')).toBeInTheDocument();
    expect(screen.getByText('Payout failed', { selector: '.sc-badge' })).toBeInTheDocument();
    // totals are the server's figures
    const week = screen.getByText('This week').closest('.sc-total')!;
    expect(week).toHaveTextContent('$193.60');
    expect(screen.getByText('This month').closest('.sc-total')).toHaveTextContent('$310.00');
    // the failed row's action and the alert that names the amount
    expect(screen.getByRole('alert')).toHaveTextContent('$90.00 is safe');
    expect(screen.getByRole('link', { name: /Check your PayPal email/ })).toHaveAttribute(
      'href',
      '/w/profile#payout-email',
    );
    // a worker pay line per row, hours x rate, no employer amounts
    expect(screen.getByText(/8 h × \$24\.20\/hr/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/fee|authoriz|captur/i);
  });

  it('copies the PayPal reference', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    stub(() => ({ body: earn() }));
    render(<Earnings />);
    await screen.findByText('This week');
    await userEvent.click(screen.getAllByRole('button', { name: /Copy PayPal payout/ })[0]!);
    expect(writeText).toHaveBeenCalledWith('PAYOUT-ABC123');
    expect(await screen.findByText('Reference copied')).toBeInTheDocument();
  });

  it('empty, error with retry, and signed-out states', async () => {
    stub(() => ({ body: earn({ items: [], failed_cents: 0 }) }));
    const a = render(<Earnings />);
    expect(await screen.findByText('No earnings yet')).toBeInTheDocument();
    a.unmount();

    let n = 0;
    stub(() => (n++ === 0 ? { status: 500, body: {} } : { body: earn() }));
    render(<Earnings />);
    expect(await screen.findByText("We couldn't load your earnings")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await screen.findByText('This week');
    cleanup();

    stub(() => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } }));
    render(<Earnings />);
    expect(await screen.findByText('Open your link again')).toBeInTheDocument();
  });

  it('shows a loading state first', async () => {
    stub(() => ({ body: earn() }));
    render(<Earnings />);
    expect(screen.getByText('Loading your earnings')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Loading your earnings')).toBeNull());
  });
});

const profile = (over: Partial<WorkerProfileDto> = {}): WorkerProfileDto => ({
  name: 'Jordan Reyes',
  initials: 'JR',
  avatar_tint: 2,
  email: 'jordan@example.com',
  paypal_email: 'jordan.pay@example.com',
  skills: ['line_cook', 'prep_cook'],
  home_area: 'Pearl District',
  notifications: { offers_email: true, offers_push: true, pay_email: true },
  ...over,
});
const err = (status: number, code: string, message: string) => ({
  status,
  body: { error: { code, message } },
});

describe('G2-W5 profile', () => {
  it('shows skills, area, notification switches and the payout email', async () => {
    stub(() => ({ body: profile() }));
    render(<Profile />);
    await screen.findByText('Jordan Reyes');
    expect(screen.getByRole('button', { name: 'Line cook' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Server' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('Home area')).toHaveValue('Pearl District');
    expect(screen.getByRole('switch', { name: 'Shift offers: Push' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText('jordan.pay@example.com')).toBeInTheDocument();
  });

  it('saves a skill and a switch with PATCH, and keeps at least one skill', async () => {
    stub((r) =>
      r.method === 'PATCH'
        ? { body: profile({ skills: ['line_cook', 'prep_cook', 'server'] }) }
        : { body: profile({ skills: ['line_cook'] }) },
    );
    render(<Profile />);
    await screen.findByText('Jordan Reyes');
    await userEvent.click(screen.getByRole('button', { name: 'Line cook' }));
    expect(await screen.findByText('Keep at least one skill to get offers.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Server' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        skills: ['line_cook', 'server'],
      }),
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Pay: Email when I’m paid' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({
        notifications: { pay_email: false },
      }),
    );
  });

  it('warns when both offer channels are off', async () => {
    stub(() => ({
      body: profile({
        notifications: { offers_email: false, offers_push: false, pay_email: true },
      }),
    }));
    render(<Profile />);
    expect(await screen.findByText('Keep one on for shift offers')).toBeInTheDocument();
  });

  it('error and signed-out states', async () => {
    stub(() => ({ status: 500, body: {} }));
    const a = render(<Profile />);
    expect(await screen.findByText("We couldn't load your profile")).toBeInTheDocument();
    a.unmount();
    stub(() => err(401, 'unauthenticated', 'x'));
    render(<Profile />);
    expect(await screen.findByText('Open your link again')).toBeInTheDocument();
  });

  it('payout email flow: validation error, code step, wrong code, success; the code is never logged or stored', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    let verifyN = 0;
    stub((r) => {
      if (r.path === '/api/w/profile/payout-email')
        return { body: { new_email: 'new.pay@example.com', expires_in_seconds: 600 } };
      if (r.path === '/api/w/profile/payout-email/verify')
        return verifyN++ === 0
          ? err(422, 'code_wrong', "That code isn't right. 4 tries left.")
          : { body: { paypal_email: 'new.pay@example.com' } };
      return { body: profile() };
    });
    render(<Profile />);
    await screen.findByText('Jordan Reyes');
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByText('Current payout email: jordan.pay@example.com')).toBeInTheDocument();
    // validation error: no request is made
    await userEvent.type(screen.getByLabelText('New PayPal email'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(/Enter a full email address/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/payout-email'))).toBe(false);
    // send
    await userEvent.clear(screen.getByLabelText('New PayPal email'));
    await userEvent.type(screen.getByLabelText('New PayPal email'), 'new.pay@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('new.pay@example.com')).toBeInTheDocument();
    expect(screen.getByText('Code expires in 10:00')).toBeInTheDocument();
    // short code: validation, no request
    await userEvent.type(screen.getByLabelText('6-digit code'), '123');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm new email' }));
    expect(await screen.findByText('Enter the 6 digits from the email.')).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/verify'))).toBe(false);
    // wrong, then right
    await userEvent.type(screen.getByLabelText('6-digit code'), '456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm new email' }));
    expect(await screen.findByText("That code isn't right. 4 tries left.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm new email' }));
    expect(await screen.findByText('Payout email updated')).toBeInTheDocument();
    expect(screen.getByText('New payouts go to new.pay@example.com.')).toBeInTheDocument();
    // the code only travelled in the verify body
    expect(calls.filter((c) => c.path.endsWith('/verify')).map((c) => c.body)).toEqual([
      { code: '123456' },
      { code: '123456' },
    ]);
    expect(calls.every((c) => !c.path.includes('123456'))).toBe(true);
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('123456');
    for (const l of logs) {
      expect(JSON.stringify(l.mock.calls)).not.toContain('123456');
      l.mockRestore();
    }
  });

  it('an expired code shows the expired state and offers a new code', async () => {
    stub((r) => {
      if (r.path === '/api/w/profile/payout-email')
        return { body: { new_email: 'new.pay@example.com', expires_in_seconds: 600 } };
      if (r.path.endsWith('/verify')) return err(410, 'code_expired', 'This code has expired.');
      return { body: profile() };
    });
    render(<Profile />);
    await screen.findByText('Jordan Reyes');
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await userEvent.type(screen.getByLabelText('New PayPal email'), 'new.pay@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await userEvent.type(await screen.findByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm new email' }));
    expect(await screen.findByText('This code has expired')).toBeInTheDocument();
    expect(screen.getByLabelText('6-digit code')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Confirm new email' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Send a new code' }));
    await waitFor(() => expect(screen.queryByText('This code has expired')).toBeNull());
    expect(screen.getByLabelText('6-digit code')).toBeEnabled();
  });

  it('a send failure keeps the worker on step 1 with nothing changed', async () => {
    stub((r) => (r.path === '/api/w/profile/payout-email' ? { status: -1 } : { body: profile() }));
    render(<Profile />);
    await screen.findByText('Jordan Reyes');
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await userEvent.type(screen.getByLabelText('New PayPal email'), 'new.pay@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText("We couldn't send the code")).toBeInTheDocument();
    expect(screen.getByLabelText('New PayPal email')).toBeInTheDocument();
  });
});

const entry = (
  n: number,
  type: LedgerDto['items'][number]['entries'][number]['type'],
  amount: number,
  ref: string | null = null,
) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  type,
  amount_cents: amount,
  ref,
  created_at: `2026-10-14T2${n}:00:00.000Z`,
});
const row = (over: Partial<LedgerDto['items'][number]>): LedgerDto['items'][number] => ({
  payment_id: '10000000-0000-4000-8000-000000000001',
  slot_id: '20000000-0000-4000-8000-000000000001',
  attempt: 1,
  role: 'line_cook',
  worker_name: 'Jordan Reyes',
  venue_tz: 'America/Los_Angeles',
  start_at: '2026-10-14T14:00:00.000Z',
  end_at: '2026-10-14T22:00:00.000Z',
  approved_hours: 8,
  status: 'paid',
  group: 'paid',
  last_error: null,
  authorized_cents: 22176,
  captured_cents: 20328,
  worker_pay_cents: 19360,
  platform_fee_cents: 968,
  paypal_capture_fee_cents: 0,
  paypal_payout_fee_cents: 0,
  released_cents: 1848,
  references: { order: 'ORDER-1', authorization: 'AUTH-1', capture: 'CAP-1', payout: 'BATCH-1' },
  entries: [
    entry(0, 'AUTHORIZED', 22176, 'AUTH-1'),
    entry(1, 'CAPTURED', 20328, 'CAP-1'),
    entry(2, 'PAID', 19360, 'BATCH-1'),
  ],
  ...over,
});
const ledger = (items: LedgerDto['items'], over: Partial<LedgerDto> = {}): LedgerDto => ({
  server_time: '2026-10-15T00:00:00.000Z',
  truncated: false,
  totals: {
    authorized_cents: 44352,
    captured_cents: 20328,
    worker_pay_cents: 19360,
    platform_fee_cents: 968,
  },
  items,
  ...over,
});
const failedRow = row({
  payment_id: '10000000-0000-4000-8000-000000000002',
  slot_id: '20000000-0000-4000-8000-000000000002',
  worker_name: 'Sam Okafor',
  status: 'payout_failed',
  group: 'failed',
  last_error: 'The PayPal email was not recognised.',
  entries: [
    entry(0, 'AUTHORIZED', 22176),
    entry(1, 'CAPTURED', 20328),
    entry(2, 'PAYOUT_FAILED', 19360),
  ],
});

describe('G2-M6 ledger', () => {
  it('shows the entries table with the API figures, status chips and totals', async () => {
    stub(() => ({ body: ledger([row({}), failedRow]) }));
    render(<LedgerScreen />);
    await screen.findByText('Jordan Reyes');
    const table = screen.getByRole('table', { name: 'Money ledger' });
    for (const h of [
      'Date',
      'Shift',
      'Worker',
      'Authorized',
      'Captured',
      'Worker pay',
      'Fee',
      'Status',
    ])
      expect(within(table).getByRole('columnheader', { name: h })).toBeInTheDocument();
    expect(within(table).getAllByText('$221.76')).toHaveLength(2);
    expect(within(table).getAllByText('$193.60').length).toBeGreaterThan(0);
    expect(within(table).getByText('Paid', { selector: '.sc-badge' })).toBeInTheDocument();
    expect(within(table).getByText('Payout failed', { selector: '.sc-badge' })).toBeInTheDocument();
    const stats = screen.getByLabelText('Totals in this view');
    expect(stats).toHaveTextContent('$443.52');
    expect(stats).toHaveTextContent('$9.68');
  });

  it('filters ask the server (range and status) and the search narrows the rows', async () => {
    stub(() => ({ body: ledger([row({}), failedRow]) }));
    render(<LedgerScreen />);
    await screen.findByText('Jordan Reyes');
    expect(calls[0]!.path).toBe('/api/manager/ledger?range=30d');
    await userEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(calls.at(-1)!.path).toBe('/api/manager/ledger?range=7d'));
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failed');
    await waitFor(() =>
      expect(calls.at(-1)!.path).toBe('/api/manager/ledger?range=7d&group=failed'),
    );
    await screen.findByText('Jordan Reyes');
    await userEvent.type(screen.getByLabelText('Search worker or role'), 'sam');
    expect(screen.queryByText('Jordan Reyes')).toBeNull();
    expect(screen.getByText('Sam Okafor')).toBeInTheDocument();
  });

  it('opens the per-shift breakdown with server figures, entries and references', async () => {
    stub(() => ({ body: ledger([row({})]) }));
    render(<LedgerScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: /Open breakdown for Line cook/ }),
    );
    const panel = screen.getByRole('dialog', { name: 'Shift breakdown' });
    expect(within(panel).getByText('Charged to you').closest('.sc-money__row')).toHaveTextContent(
      '$203.28',
    );
    expect(within(panel).getByText('Hold not used').closest('.sc-money__row')).toHaveTextContent(
      '$18.48',
    );
    const entries = within(panel).getByRole('list', { name: 'Ledger entries' });
    expect(
      within(entries)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('strong')!.textContent),
    ).toEqual(['Hold placed', 'Charged', 'Payout delivered']);
    expect(
      within(panel).getByRole('button', { name: 'Copy Capture reference' }),
    ).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a payout-failed row opens a recovery action that retries with the approved hours', async () => {
    let retried = false;
    stub((r) => {
      if (r.method === 'POST') {
        retried = true;
        return {
          body: {
            slot_status: 'settled',
            payment_status: 'paid',
            capture_cents: 20328,
            worker_pay_cents: 19360,
            platform_fee_cents: 968,
          },
        };
      }
      return { body: ledger([retried ? row({ payment_id: failedRow.payment_id }) : failedRow]) };
    });
    render(<LedgerScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: /Open breakdown for Line cook/ }),
    );
    const panel = screen.getByRole('dialog', { name: 'Shift breakdown' });
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'The PayPal email was not recognised.',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Retry payout' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        path: `/api/manager/shifts/${failedRow.slot_id}/approve-and-pay`,
        body: { approved_hours: 8 },
      }),
    );
    expect(await screen.findByText('Payout retried. The status updates here.')).toBeInTheDocument();
  });

  it('a retry that fails shows the reason and keeps the panel open', async () => {
    stub((r) =>
      r.method === 'POST'
        ? err(409, 'invalid_state', 'this shift was approved for different hours')
        : { body: ledger([failedRow]) },
    );
    render(<LedgerScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: /Open breakdown for Line cook/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry payout' }));
    expect(
      await screen.findByText('this shift was approved for different hours'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Shift breakdown' })).toBeInTheDocument();
  });

  it('empty, filtered-empty, loading and error states', async () => {
    stub(() => ({
      body: ledger([], {
        totals: {
          authorized_cents: 0,
          captured_cents: 0,
          worker_pay_cents: 0,
          platform_fee_cents: 0,
        },
      }),
    }));
    const a = render(<LedgerScreen />);
    expect(screen.getByRole('table', { name: 'Money ledger' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(await screen.findByText('Nothing matches these filters')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('No money has moved yet')).toBeInTheDocument();
    a.unmount();

    let n = 0;
    stub(() => (n++ === 0 ? { status: 500, body: {} } : { body: ledger([row({})]) }));
    render(<LedgerScreen />);
    expect(await screen.findByText("We couldn't load the ledger")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await screen.findByText('Jordan Reyes');
  });
});
