// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Earnings } from '@/features/worker/Earnings';
import type { WorkerEarningsDto } from '@/features/client-api';

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
