// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeProvider } from '@/features/manager/me-context';
import { PayPalSlot } from '@/features/manager/PayPalSlot';
import { ReportGapScreen } from '@/features/manager/ReportGapScreen';
import {
  loadPaypalSdk,
  PAYPAL_SDK_SRC,
  PaypalSdkError,
  SDK_TIMEOUT_MS,
  type PaypalSdkInstance,
} from '@/features/manager/paypal-sdk';
import { ME, sceneById } from './fixtures';
import { installStubFetch } from './stub-fetch';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/features/manager/paypal-sdk', async (orig) => ({
  ...(await orig<typeof import('@/features/manager/paypal-sdk')>()),
  loadPaypalSdk: vi.fn(),
}));

const loader = vi.mocked(loadPaypalSdk);
const actualLoader = async () =>
  (
    await vi.importActual<typeof import('@/features/manager/paypal-sdk')>(
      '@/features/manager/paypal-sdk',
    )
  ).loadPaypalSdk;

/** A fake PayPal SDK: records the session callbacks so a test can play "PayPal approved / cancelled / failed". */
function fakeSdk() {
  const start = vi.fn(async () => undefined);
  const destroy = vi.fn();
  const handlers: {
    onApprove?: (d: { orderId: string }) => void | Promise<void>;
    onCancel?: () => void;
    onError?: (e: unknown) => void;
  } = {};
  const sdk: PaypalSdkInstance = {
    findEligibleMethods: async () => ({ isEligible: () => true }),
    createPayPalOneTimePaymentSession: async (cb) => {
      Object.assign(handlers, cb);
      return { start, destroy };
    },
  };
  return { sdk, start, destroy, handlers };
}

let restore: (() => void) | undefined;
beforeEach(() => {
  loader.mockReset();
  document.head.querySelectorAll('script').forEach((s) => s.remove());
});
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
  vi.useRealTimers();
});

describe('PayPalSlot (PAYMENTS_MODE=paypal)', () => {
  const props = () => ({
    clientId: 'client-1',
    createOrder: vi.fn(async () => 'ORD1'),
    onStart: vi.fn(),
    onApproved: vi.fn(async () => undefined),
    onCancel: vi.fn(),
    onError: vi.fn(),
    onUnavailable: vi.fn(),
  });

  it('shows the design loading slot, then mounts PayPal’s own button in #paypal-button-container', async () => {
    const f = fakeSdk();
    loader.mockResolvedValue(f.sdk);
    const p = props();
    const { container } = render(<PayPalSlot {...p} />);
    expect(screen.getByText('Loading secure payment…')).toBeInTheDocument();
    await waitFor(() =>
      expect(container.querySelector('#paypal-button-container paypal-button')).not.toBeNull(),
    );
    expect(screen.queryByText('Loading secure payment…')).toBeNull();
    expect(screen.queryByTestId('stub-approve')).toBeNull();
    expect(loader).toHaveBeenCalledWith('client-1', expect.any(Number));
  });

  it('click: starts the session with the server-created order promise; approval reaches onApproved', async () => {
    const f = fakeSdk();
    loader.mockResolvedValue(f.sdk);
    const p = props();
    const { container } = render(<PayPalSlot {...p} />);
    const btn = await waitFor(() => {
      const b = container.querySelector('paypal-button');
      expect(b).not.toBeNull();
      return b!;
    });
    await userEvent.click(btn);
    expect(p.onStart).toHaveBeenCalledTimes(1);
    expect(p.createOrder).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
    const [opts, orderPromise] = f.start.mock.calls[0] as unknown as [
      { presentationMode: string },
      Promise<{ orderId: string }>,
    ];
    expect(opts).toEqual({ presentationMode: 'auto' });
    expect(await orderPromise).toEqual({ orderId: 'ORD1' });
    await act(async () => {
      await f.handlers.onApprove?.({ orderId: 'ORD1' });
    });
    expect(p.onApproved).toHaveBeenCalledWith('ORD1');
  });

  it('forwards cancel and error; a failing onApproved becomes onError', async () => {
    const f = fakeSdk();
    loader.mockResolvedValue(f.sdk);
    const p = props();
    p.onApproved = vi.fn(async () => {
      throw new Error('authorize failed');
    });
    const { container } = render(<PayPalSlot {...p} />);
    await waitFor(() => expect(container.querySelector('paypal-button')).not.toBeNull());
    f.handlers.onCancel?.();
    expect(p.onCancel).toHaveBeenCalled();
    f.handlers.onError?.(new Error('x'));
    expect(p.onError).toHaveBeenCalledTimes(1);
    await act(async () => {
      await f.handlers.onApprove?.({ orderId: 'ORD1' });
    });
    expect(p.onError).toHaveBeenCalledTimes(2);
  });

  it('createOrder failing reports an error', async () => {
    const f = fakeSdk();
    loader.mockResolvedValue(f.sdk);
    const p = props();
    p.createOrder = vi.fn(async () => {
      throw new Error('no order');
    });
    const { container } = render(<PayPalSlot {...p} />);
    const btn = await waitFor(() => {
      const b = container.querySelector('paypal-button');
      expect(b).not.toBeNull();
      return b!;
    });
    await userEvent.click(btn);
    await waitFor(() => expect(p.onError).toHaveBeenCalled());
  });

  it('reports unavailable when the SDK cannot load, and when there is no client id', async () => {
    loader.mockRejectedValue(new PaypalSdkError('timeout'));
    const p = props();
    render(<PayPalSlot {...p} />);
    await waitFor(() => expect(p.onUnavailable).toHaveBeenCalledTimes(1));
    cleanup();
    const q = props();
    render(<PayPalSlot {...q} clientId={null} />);
    expect(q.onUnavailable).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(1); // the second render never tried to load anything
  });

  it('removes the button when it unmounts', async () => {
    const f = fakeSdk();
    loader.mockResolvedValue(f.sdk);
    const { container, unmount } = render(<PayPalSlot {...props()} />);
    await waitFor(() => expect(container.querySelector('paypal-button')).not.toBeNull());
    unmount();
    expect(document.querySelector('paypal-button')).toBeNull();
    expect(f.destroy).toHaveBeenCalled();
  });
});

describe('SDK loader timeout', () => {
  it('rejects with a timeout after 10 seconds when the script never loads, and loads only the sandbox SDK', async () => {
    vi.useFakeTimers();
    const real = await actualLoader();
    const p = real('client-1');
    const settled = p.then(
      () => 'ok',
      (e: unknown) => (e instanceof PaypalSdkError ? e.reason : 'other'),
    );
    expect(document.querySelector(`script[src="${PAYPAL_SDK_SRC}"]`)).not.toBeNull();
    expect(PAYPAL_SDK_SRC).toBe('https://www.sandbox.paypal.com/web-sdk/v6/core');
    await vi.advanceTimersByTimeAsync(SDK_TIMEOUT_MS - 1);
    let early = true;
    void settled.then(() => (early = false));
    await Promise.resolve();
    expect(early).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect(await settled).toBe('timeout');
  });

  it('rejects when the script fails to load', async () => {
    const real = await actualLoader();
    const p = real('client-1', 5000);
    document
      .querySelector<HTMLScriptElement>(`script[src="${PAYPAL_SDK_SRC}"]`)!
      .dispatchEvent(new Event('error'));
    await expect(p).rejects.toMatchObject({ reason: 'script' });
  });
});

describe('M3 payment slot by mode', () => {
  const MODE_ME = (mode: 'stub' | 'paypal', clientId: string | null) => ({
    ...ME,
    config: { ...ME.config, payments_mode: mode, paypal_client_id: clientId },
  });

  async function toConfirmed(me: ReturnType<typeof MODE_ME>) {
    restore = installStubFetch(sceneById('m3-empty')!);
    render(
      <MeProvider me={me}>
        <ReportGapScreen />
      </MeProvider>,
    );
    const user = userEvent.setup();
    await user.type(
      document.getElementById('nl') as HTMLElement,
      'Maria called in sick, need a line cook 7 to 3 today',
    );
    await user.click(screen.getByRole('button', { name: 'Parse' }));
    await waitFor(() => expect(document.getElementById('f-start')).toHaveValue('07:00'));
    await user.click(screen.getByRole('button', { name: /Details are correct/ }));
    return user;
  }

  it('stub mode: the stub button shows and the PayPal SDK is never loaded', async () => {
    await toConfirmed(MODE_ME('stub', null));
    expect(await screen.findByTestId('stub-approve')).toBeInTheDocument();
    expect(loader).not.toHaveBeenCalled();
    expect(document.querySelector('script[src*="paypal"]')).toBeNull();
  });

  it('paypal mode: loads the SDK with the public client id, renders PayPal’s button, no stub button', async () => {
    const f = fakeSdk();
    loader.mockResolvedValue(f.sdk);
    await toConfirmed(MODE_ME('paypal', 'sandbox-client-id'));
    await waitFor(() =>
      expect(document.querySelector('#paypal-button-container paypal-button')).not.toBeNull(),
    );
    expect(loader).toHaveBeenCalledWith('sandbox-client-id', expect.any(Number));
    expect(screen.queryByTestId('stub-approve')).toBeNull();
    expect(document.querySelectorAll('#paypal-button-container')).toHaveLength(1);
  });

  it('paypal mode: approval creates the gap, authorizes with the order id, starts offering and shows the hold', async () => {
    const f = fakeSdk();
    loader.mockResolvedValue(f.sdk);
    const user = await toConfirmed(MODE_ME('paypal', 'sandbox-client-id'));
    const btn = await waitFor(() => {
      const b = document.querySelector('paypal-button');
      expect(b).not.toBeNull();
      return b!;
    });
    await user.click(btn);
    await act(async () => {
      await f.handlers.onApprove?.({ orderId: 'ORDFIXTURE' });
    });
    expect(await screen.findByText(/on hold/)).toBeInTheDocument();
  });

  it('paypal mode: the SDK failing shows the design error state, and Try again loads it again', async () => {
    loader.mockRejectedValueOnce(new PaypalSdkError('timeout'));
    const user = await toConfirmed(MODE_ME('paypal', 'sandbox-client-id'));
    expect(await screen.findByText('PayPal couldn’t place the hold')).toBeInTheDocument();
    expect(screen.getByText(/Nothing was charged/)).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);
    const f = fakeSdk();
    loader.mockResolvedValue(f.sdk);
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector('paypal-button')).not.toBeNull());
  });

  it('paypal mode without a client id shows the error state instead of loading forever', async () => {
    await toConfirmed(MODE_ME('paypal', null));
    expect(await screen.findByText('PayPal couldn’t place the hold')).toBeInTheDocument();
    expect(loader).not.toHaveBeenCalled();
  });
});
