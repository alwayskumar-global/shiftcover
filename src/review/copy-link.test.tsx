// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GapDetailScreen } from '@/features/manager/GapDetailScreen';
import { MeProvider } from '@/features/manager/me-context';
import { GAP_DETAILS, ME, sceneById } from './fixtures';
import { installStubFetch } from './stub-fetch';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/gaps/x',
}));

let restore: (() => void) | undefined;
const consoleSpies = () =>
  (['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
const renderGap = (key: 'offering' | 'offering-links') => {
  restore = installStubFetch(
    sceneById(`m4-${key === 'offering' ? 'offering' : 'offering-links'}`)!,
  );
  render(
    <MeProvider me={ME}>
      <GapDetailScreen id={GAP_DETAILS[key].slot.id} />
    </MeProvider>,
  );
};
const links = GAP_DETAILS['offering-links'].offers.filter((o) => o.offer_link);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  restore?.();
  vi.restoreAllMocks();
});

describe('Copy link on the offers table (M4 section B)', () => {
  it('without offer_link there is no button and no live region text', async () => {
    renderGap('offering');
    const offers = await screen.findByRole('table', { name: 'Offers' });
    expect(within(offers).queryByRole('button', { name: /Copy link/ })).toBeNull();
    expect(within(offers).queryByRole('status')).toBeNull();
  });

  it('shows one button per live offer, next to the status chip, and none for settled offers', async () => {
    renderGap('offering-links');
    const offers = await screen.findByRole('table', { name: 'Offers' });
    const buttons = within(offers).getAllByRole('button', { name: /^Copy link for / });
    expect(buttons).toHaveLength(links.length);
    expect(links.length).toBeGreaterThan(0);
    // the declined offer's row has no button
    const declined = within(offers).getByText('Marcus Lee').closest('[role="row"]') as HTMLElement;
    expect(within(declined).queryByRole('button', { name: /Copy link/ })).toBeNull();
    // same cell as the chip
    const sent = within(offers).getByText('Sam Whitfield').closest('[role="row"]') as HTMLElement;
    const cell = within(sent)
      .getByRole('button', { name: /Copy link/ })
      .closest('[role="cell"]')!;
    expect(cell).toHaveTextContent('Sent');
  });

  it('copies the exact link, says Copied for 2 seconds, announces it, and logs nothing', async () => {
    const spies = consoleSpies();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const fetchSpy = vi.fn(window.fetch);
    renderGap('offering-links');
    window.fetch = ((...a: Parameters<typeof fetch>) => fetchSpy(...a)) as typeof fetch;
    const sam = GAP_DETAILS['offering-links'].offers.find(
      (o) => o.worker.name === 'Sam Whitfield',
    )!;
    const btn = await screen.findByRole('button', { name: 'Copy link for Sam Whitfield' });
    expect(btn).toHaveClass('sc-btn--md'); // the console touch size
    await userEvent.click(btn);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(sam.offer_link);
    expect(
      await screen.findByRole('button', { name: 'Copied for Sam Whitfield' }),
    ).toHaveTextContent('Copied');
    const live = screen.getAllByRole('status').find((s) => s.textContent === 'Link copied');
    expect(live).toBeDefined();
    expect(live).toHaveAttribute('aria-live', 'polite');
    // back to "Copy link" after 2 seconds
    await waitFor(
      () =>
        expect(
          screen.getByRole('button', { name: 'Copy link for Sam Whitfield' }),
        ).toHaveTextContent('Copy link'),
      { timeout: 3500 },
    );
    // privacy: nothing logged, stored, put in the URL or sent anywhere
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain('EXAMPLE-LINK');
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain('EXAMPLE-LINK');
  });

  it('when the clipboard is unavailable it says so, still logs nothing, and keeps the label', async () => {
    const spies = consoleSpies();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    renderGap('offering-links');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Copy link for Sam Whitfield' }),
    );
    expect(await screen.findByText("Couldn't copy the link")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link for Sam Whitfield' })).toHaveTextContent(
      'Copy link',
    );
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
