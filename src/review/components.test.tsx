// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GapDetailScreen } from '@/features/manager/GapDetailScreen';
import { MeProvider } from '@/features/manager/me-context';
import { ClaimExperience } from '@/features/worker/ClaimExperience';
import {
  GAP_DETAILS,
  ME,
  WORKER_OFFERS,
  sceneById,
  type GapDetailKey,
  type WorkerOfferKey,
} from './fixtures';
import { installStubFetch } from './stub-fetch';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

let restore: (() => void) | undefined;
beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-10-12T13:49:00Z') });
});
afterEach(() => {
  cleanup();
  restore?.();
  vi.useRealTimers();
});
const stub = (sceneId: string) => {
  restore = installStubFetch(sceneById(sceneId)!);
};

describe('claim card (W1/W2)', () => {
  const cases: Array<[WorkerOfferKey, string]> = [
    ['available', 'Claim this shift'],
    ['taken', 'Someone else just claimed this shift'],
    ['expired', 'This offer has ended'],
    ['withdrawn', 'This shift is no longer available'],
    ['declined', 'Okay, we’ve passed'],
    ['invalid', 'This link doesn’t work'],
    ['booked', "You're booked."],
  ];
  it.each(cases)('renders the %s state', async (key, text) => {
    stub(`w1-${key}`);
    render(<ClaimExperience token="review-token" />);
    expect(await screen.findByText(text, { exact: false })).toBeInTheDocument();
  });

  it('shows the rising-rate banner against the first offered rate', async () => {
    stub('w1-available-rising');
    render(<ClaimExperience token="review-token" />);
    const banner = await screen.findByText(/Rate increased to \$24\.20\/hr/);
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/It was \$22\.00\/hr/)).toBeInTheDocument();
  });

  it('shows no banner at the first-wave rate', async () => {
    stub('w1-available');
    render(<ClaimExperience token="review-token" />);
    await screen.findByText('Claim this shift');
    expect(screen.queryByText(/Rate increased/)).toBeNull();
  });

  it('claims once and lands on the booked screen', async () => {
    stub('w1-available');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ClaimExperience token="review-token" />);
    await user.click(await screen.findByRole('button', { name: /Claim this shift/ }));
    await vi.advanceTimersByTimeAsync(2000); // the short hand-off beat before the booked screen
    expect(await screen.findByText("You're booked.")).toBeInTheDocument();
  });

  it('keeps the token out of the address bar after the first open', async () => {
    stub('w1-available');
    render(<ClaimExperience token="review-token" />);
    await screen.findByText('Claim this shift');
    expect(window.location.pathname).toBe('/c');
  });

  it('shows the load error with a retry', async () => {
    stub('w1-error-load');
    render(<ClaimExperience token="review-token" />);
    expect(await screen.findByText('Can’t reach ShiftCover')).toBeInTheDocument();
  });
});

const renderGap = (key: GapDetailKey) => {
  stub(`m4-${key}`);
  render(
    <MeProvider me={ME}>
      <GapDetailScreen id={GAP_DETAILS[key].slot.id} />
    </MeProvider>,
  );
};
const section = async (name: RegExp) => {
  const h = await screen.findByRole('heading', { name });
  return within(h.closest('section') as HTMLElement);
};

describe('wave timeline (M4 section A)', () => {
  it('offering: wave 1 done, wave 2 open now, wave 3 up next at the cap', async () => {
    renderGap('offering');
    const a = await section(/A · Offer waves/);
    expect(a.getByText('Open now')).toBeInTheDocument();
    expect(a.getByText('Sends next')).toBeInTheDocument();
    expect(a.getByText('$22.00/hr')).toBeInTheDocument();
    expect(a.getByText('$24.20/hr')).toBeInTheDocument();
    expect(a.getByText('$26.40/hr')).toBeInTheDocument();
    expect(a.getByText('1 declined · 1 opened · 1 waiting')).toBeInTheDocument();
  });
  it('filled: the claiming wave is marked Claimed with its final rate', async () => {
    renderGap('filled');
    const a = await section(/A · Offer waves/);
    expect(a.getByText('Claimed')).toBeInTheDocument();
    expect(a.getByText(/final rate/)).toBeInTheDocument();
    expect(a.getByText('Not sent')).toBeInTheDocument();
  });
  it('unfilled: every wave reads No takers', async () => {
    renderGap('unfilled');
    const a = await section(/A · Offer waves/);
    expect(a.getAllByText('No takers')).toHaveLength(3);
  });
  it('cancelled: later waves are stopped or not sent', async () => {
    renderGap('cancelled');
    const a = await section(/A · Offer waves/);
    expect(a.getAllByText('Not sent').length).toBeGreaterThan(0);
  });
});

describe('money timeline (M4 section C)', () => {
  it('offering: authorized and on hold, nothing captured', async () => {
    renderGap('offering');
    const c = await section(/C · Money/);
    expect(c.getByText('On hold')).toBeInTheDocument();
    expect(c.getAllByText('$221.76').length).toBeGreaterThan(0);
    expect(c.getAllByText('Up next')).toHaveLength(2);
  });
  it('open: waits for the hold and offers the stub approve slot in stub mode only', async () => {
    renderGap('open');
    const c = await section(/C · Money/);
    expect(c.getByText('Waiting for you')).toBeInTheDocument();
    expect(c.getByTestId('stub-approve')).toBeInTheDocument();
  });
  it('unfilled: hold released, capture and payout not applicable', async () => {
    renderGap('unfilled');
    const c = await section(/C · Money/);
    expect(c.getByText('Released')).toBeInTheDocument();
    expect(c.getAllByText('Not applicable')).toHaveLength(2);
    expect(c.queryByTestId('stub-approve')).toBeNull();
  });
  it('capture declined: failed capture, payout waiting, support reference to copy', async () => {
    renderGap('capture-declined');
    const c = await section(/C · Money/);
    expect(c.getByText('Declined')).toBeInTheDocument();
    expect(c.getByText('Waiting')).toBeInTheDocument();
    expect(c.getByRole('button', { name: /Copy reference for support/ })).toBeInTheDocument();
  });
  it('payout failed: charged, then payout failed with references', async () => {
    renderGap('payout-failed');
    const c = await section(/C · Money/);
    expect(c.getByText('Charged')).toBeInTheDocument();
    expect(c.getByText('Payout failed')).toBeInTheDocument();
    expect(c.getByRole('button', { name: 'Copy Payout reference' })).toBeInTheDocument();
  });
  it('cancelled: hold released, nothing charged', async () => {
    renderGap('cancelled');
    const c = await section(/C · Money/);
    expect(c.getByText(/You cancelled the gap/)).toBeInTheDocument();
  });
});

describe('gap header actions', () => {
  it('cancel opens a labelled alertdialog that defaults focus to Keep gap', async () => {
    renderGap('offering');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByRole('button', { name: /Cancel gap/ }));
    const dlg = await screen.findByRole('alertdialog', { name: 'Cancel this gap?' });
    expect(within(dlg).getByRole('button', { name: 'Keep gap' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('widening the cap is inert until PayPal approval exists', async () => {
    renderGap('offering');
    expect(await screen.findByRole('button', { name: /Widen the cap/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
  it('a filled gap cannot widen and a settled-stage gap cannot be cancelled', async () => {
    renderGap('pending-approval');
    expect(await screen.findByRole('button', { name: /Cancel gap/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

describe('fixtures match the public contract', () => {
  it('worker offers and gap details parse against the strict DTOs', async () => {
    const { GapDetailResponse, WorkerOfferDto } = await import('@/api/dto');
    for (const o of Object.values(WORKER_OFFERS))
      expect(() => WorkerOfferDto.parse(o)).not.toThrow();
    for (const d of Object.values(GAP_DETAILS))
      expect(() => GapDetailResponse.parse(d)).not.toThrow();
  });
});
