// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsScreen } from '@/features/manager/ApprovalsScreen';
import { MyShifts } from '@/features/worker/MyShifts';
import { buildViews } from '@/features/worker/my-shifts-model';
import { sceneById } from './fixtures';
import { workerShifts } from './fixtures-g2';
import { installStubFetch } from './stub-fetch';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/approvals',
}));

let restore: (() => void) | undefined;
let calls: Array<{ method: string; path: string; body?: string }> = [];
const stub = (id: string) => {
  const inner = installStubFetch(sceneById(id)!);
  const wrapped = window.fetch;
  window.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(
      typeof i === 'string' ? i : i instanceof URL ? i.href : i.url,
      location.origin,
    );
    calls.push({
      method: init?.method ?? 'GET',
      path: u.pathname,
      body: init?.body ? String(init.body) : undefined,
    });
    return wrapped(i, init);
  }) as typeof fetch;
  restore = inner;
};
beforeEach(() => {
  calls = [];
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});
const posts = (suffix: string) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith(suffix));

describe('My shifts model', () => {
  it('splits Active now / Upcoming / Past by the server clock and drops unclaimed offers', () => {
    const v = buildViews(workerShifts('notArrived'));
    expect(v.map((x) => x.section)).toEqual([
      'active',
      'upcoming',
      'upcoming',
      'past',
      'past',
      'past',
      'past',
    ]);
    expect(v.find((x) => x.section === 'active')!.step).toBe('arrive');
    expect(v.filter((x) => x.section === 'past').map((x) => x.badge.label)).toEqual([
      'Paying',
      'Approved',
      'Paid',
      'Cancelled',
    ]);
    expect(v.some((x) => !x.shift.is_mine)).toBe(false);
  });
  it('pay comes from the stored rate and approved hours, and is zero for a cancelled shift', () => {
    const v = buildViews(workerShifts('notArrived'));
    const active = v[0]!;
    expect(active.amountCents).toBe(19360); // 8 h x $24.20
    expect(v.find((x) => x.badge.label === 'Cancelled')!.amountCents).toBe(0);
    expect(v.find((x) => x.badge.label === 'Approved')!.formulaSuffix).toBe(
      ' · 7.5 of 8 h approved',
    );
  });
  it('the active shift moves through the steps', () => {
    expect(buildViews(workerShifts('onShift'))[0]!.step).toBe('finish');
    const f = buildViews(workerShifts('finished'))[0]!;
    expect(f).toMatchObject({ step: null, section: 'active' });
    expect(f.badge.label).toBe('Waiting for approval');
  });
});

describe('My shifts (G2-W3)', () => {
  it('populated: three sections, status badges, pay with its formula, and the arrive button', async () => {
    stub('w3-booked');
    render(<MyShifts />);
    expect(await screen.findByRole('region', { name: 'Active now' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Upcoming' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Past/ })).toBeInTheDocument();
    for (const l of ['Booked', 'Paying', 'Approved', 'Paid', 'Cancelled'])
      expect(screen.getAllByText(l).length).toBeGreaterThan(0);
    expect(screen.getByText('$193.60')).toBeInTheDocument();
    expect(screen.getByText(/8 h × \$24\.20\/hr/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "I've arrived" })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Open in Maps/ })).toHaveLength(2);
  });

  it('arrive: posts once even on a double tap, then shows Finished and the check-in time', async () => {
    stub('w3-booked');
    render(<MyShifts />);
    const btn = await screen.findByRole('button', { name: "I've arrived" });
    fireEvent.click(btn); // two taps in the same instant: only the first may post
    fireEvent.click(btn);
    await screen.findByRole('button', { name: 'Finished' });
    expect(posts('/arrive')).toHaveLength(1);
    expect(screen.getByText('Arrived')).toBeInTheDocument();
  });

  it('finish asks for confirmation first, then posts and moves to Waiting for approval', async () => {
    stub('w3-onshift');
    render(<MyShifts />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Finished' }));
    expect(posts('/finish')).toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent(/Finish your shift\?/);
    await user.click(screen.getByRole('button', { name: /Go back/ }));
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Finished' }));
    await user.click(screen.getByRole('button', { name: /Yes, I'm finished/ }));
    await waitFor(() =>
      expect(screen.getAllByText('Waiting for approval').length).toBeGreaterThan(0),
    );
    expect(posts('/finish')).toHaveLength(1);
  });

  it('loading shows a status and skeletons; empty explains what happens next', async () => {
    stub('w3-loading');
    const { unmount } = render(<MyShifts />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading your shifts');
    unmount();
    restore?.();
    stub('w3-empty');
    render(<MyShifts />);
    expect(await screen.findByText('No shifts yet')).toBeInTheDocument();
    expect(screen.getByText(/When you claim a shift/)).toBeInTheDocument();
  });

  it('error offers Try again, which loads the list', async () => {
    stub('w3-error');
    render(<MyShifts />);
    expect(await screen.findByText("We couldn't load your shifts")).toBeInTheDocument();
    restore?.();
    stub('w3-booked');
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('region', { name: 'Active now' })).toBeInTheDocument();
  });

  it('offline: shows the saved list with a notice, and arrive/finish are paused with a snackbar', async () => {
    localStorage.setItem(
      'sc-my-shifts',
      JSON.stringify({ savedAt: '2026-10-12T13:49:00.000Z', data: workerShifts('notArrived') }),
    );
    stub('w3-offline');
    render(<MyShifts />);
    expect(await screen.findByText("You're offline")).toBeInTheDocument();
    expect(screen.getByText(/Check-in and finish are paused/)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: "I've arrived" });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(btn);
    expect(
      await screen.findByText("You're offline. Try again when you reconnect."),
    ).toBeInTheDocument();
    expect(posts('/arrive')).toHaveLength(0);
  });

  it('no worker session: asks to open the link again instead of showing an empty list', async () => {
    stub('w3-signed-out');
    render(<MyShifts />);
    expect(await screen.findByText('Open your link again')).toBeInTheDocument();
  });
});

describe('Approvals (G2-M5)', () => {
  it('lists each shift with scheduled vs worked hours, the rate, and a fee breakdown from the data', async () => {
    stub('m5-pending');
    render(<ApprovalsScreen />);
    expect(await screen.findByRole('heading', { name: 'Jordan Reyes' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sam Whitfield' })).toBeInTheDocument();
    expect(screen.getAllByText('Scheduled')).toHaveLength(3);
    expect(screen.getAllByText(/Worked \(check-in to check-out\)/)).toHaveLength(3);
    expect(screen.getAllByText(/Platform fee \(5%\)/).length).toBe(3);
    const first = screen.getAllByRole('article')[0]!;
    // 8 h x $24.20 = $193.60 + 5% = $9.68 -> $203.28; the hold is $221.76
    expect(within(first).getAllByText('$193.60').length).toBeGreaterThan(0);
    expect(within(first).getByText('$9.68')).toBeInTheDocument();
    expect(within(first).getByText('$203.28')).toBeInTheDocument();
    expect(within(first).getByText('$221.76')).toBeInTheDocument();
    expect(screen.getByText(/waiting for approval/)).toBeInTheDocument();
  });

  it('shows a fixed fee from the data in the label, not a hard-coded one', async () => {
    stub('m5-fixed-fee');
    render(<ApprovalsScreen />);
    await screen.findByRole('heading', { name: 'Jordan Reyes' });
    expect(screen.getAllByText(/Platform fee \(5% \+ \$1\.00\)/).length).toBe(3);
    const first = screen.getAllByRole('article')[0]!;
    expect(within(first).getByText('$10.68')).toBeInTheDocument(); // $9.68 + $1.00
  });

  it('hours above what the hold covers are refused with the maximum, and no confirm step opens', async () => {
    stub('m5-pending');
    render(<ApprovalsScreen />);
    const user = userEvent.setup();
    const first = (await screen.findAllByRole('article'))[0]!;
    const input = within(first).getByRole('textbox');
    await user.clear(input);
    await user.type(input, '9');
    await user.click(within(first).getByRole('button', { name: /Approve and pay/ }));
    expect(within(first).getByRole('alert')).toHaveTextContent(
      /The most you can approve is 8\.\d+ h/,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts('/approve-and-pay')).toHaveLength(0);
  });

  it('Approve and pay asks for confirmation (focus on Not yet), then posts the hours and shows Approved with the money timeline', async () => {
    stub('m5-pending');
    render(<ApprovalsScreen />);
    const user = userEvent.setup();
    const first = (await screen.findAllByRole('article'))[0]!;
    await user.click(within(first).getByRole('button', { name: /Approve and pay/ }));
    const dlg = await screen.findByRole('alertdialog');
    expect(within(dlg).getByRole('button', { name: 'Not yet' })).toHaveFocus();
    expect(dlg).toHaveTextContent(/Approve 8 h for Jordan Reyes\?/);
    expect(posts('/approve-and-pay')).toHaveLength(0);
    await user.click(within(dlg).getByRole('button', { name: 'Approve and pay' }));
    expect(
      await within(first).findByText('Approved', { selector: '.sc-alert__title' }),
    ).toBeInTheDocument();
    expect(within(first).getByLabelText('Money timeline')).toBeInTheDocument();
    expect(posts('/approve-and-pay')).toHaveLength(1);
    expect(JSON.parse(posts('/approve-and-pay')[0]!.body!)).toEqual({ approved_hours: 8 }); // no amount is ever sent
  });

  it('Not yet closes the confirm step and nothing is charged', async () => {
    stub('m5-pending');
    render(<ApprovalsScreen />);
    const user = userEvent.setup();
    const first = (await screen.findAllByRole('article'))[0]!;
    await user.click(within(first).getByRole('button', { name: /Approve and pay/ }));
    await user.click(await screen.findByRole('button', { name: 'Not yet' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts('/approve-and-pay')).toHaveLength(0);
  });

  it('capture declined: shows the decline, Retry charge, and the reference', async () => {
    stub('m5-declined');
    render(<ApprovalsScreen />);
    const first = (await screen.findAllByRole('article'))[0]!;
    expect(within(first).getByText(/PayPal declined the charge of \$203\.28/)).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: /Retry charge/ })).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: /Copy reference/ })).toBeInTheDocument();
    expect(within(first).getByRole('textbox')).toBeDisabled(); // a retry keeps the hours already approved
  });

  it('empty, loading and error states', async () => {
    stub('m5-empty');
    const a = render(<ApprovalsScreen />);
    expect(await screen.findByText('All caught up')).toBeInTheDocument();
    a.unmount();
    restore?.();
    stub('m5-loading');
    const b = render(<ApprovalsScreen />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading approvals');
    b.unmount();
    restore?.();
    stub('m5-error');
    render(<ApprovalsScreen />);
    expect(await screen.findByText("We couldn't load approvals")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
    await act(async () => undefined);
  });
});
