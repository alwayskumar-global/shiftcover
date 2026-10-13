'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/ui/icon';
import { loadPaypalSdk, SDK_TIMEOUT_MS, type PaypalSession } from './paypal-sdk';

type Phase = 'loading' | 'ready';

/**
 * The real payment slot (PAYMENTS_MODE=paypal). Fills the design's #paypal-button-container with PayPal's own
 * rendered button (the SDK v6 <paypal-button> web component); we draw no PayPal logo and imitate nothing.
 *
 * While the SDK loads the design's "Loading secure payment…" slot shows. If it cannot load within 10 seconds (or no
 * PayPal method is eligible) `onUnavailable` fires and the screen shows the design's PayPal error state with Try again.
 * Clicking the button calls `createOrder` (the server creates the order) and PayPal's `onApprove` calls `onApproved`.
 */
export function PayPalSlot({
  clientId,
  createOrder,
  onStart,
  onApproved,
  onCancel,
  onError,
  onUnavailable,
  timeoutMs = SDK_TIMEOUT_MS,
}: {
  clientId: string | null;
  createOrder: () => Promise<string>;
  onStart: () => void;
  onApproved: (orderId: string) => void | Promise<void>;
  onCancel: () => void;
  onError: () => void;
  onUnavailable: () => void;
  timeoutMs?: number;
}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const host = useRef<HTMLDivElement>(null);
  // Latest callbacks without re-running the (expensive, one-time) SDK setup.
  const cb = useRef({ createOrder, onStart, onApproved, onCancel, onError, onUnavailable });
  useEffect(() => {
    cb.current = { createOrder, onStart, onApproved, onCancel, onError, onUnavailable };
  });

  useEffect(() => {
    let dead = false;
    let session: PaypalSession | undefined;
    let button: HTMLElement | undefined;
    if (!clientId) {
      cb.current.onUnavailable();
      return;
    }
    loadPaypalSdk(clientId, timeoutMs)
      .then(async (sdk) => {
        const s = await sdk.createPayPalOneTimePaymentSession({
          onApprove: async ({ orderId }) => {
            try {
              await cb.current.onApproved(orderId);
            } catch {
              cb.current.onError();
            }
          },
          onCancel: () => cb.current.onCancel(),
          onError: () => cb.current.onError(),
        });
        if (dead) return;
        session = s;
        const el = document.createElement('paypal-button');
        el.addEventListener('click', () => {
          cb.current.onStart();
          // Do not await before start(): PayPal needs the click's user activation.
          const order = cb.current.createOrder().then((orderId) => ({ orderId }));
          order.catch(() => cb.current.onError());
          void session?.start({ presentationMode: 'auto' }, order);
        });
        button = el;
        host.current?.replaceChildren(el);
        setPhase('ready');
      })
      .catch(() => {
        if (!dead) cb.current.onUnavailable();
      });
    return () => {
      dead = true;
      session?.destroy?.();
      button?.remove();
    };
  }, [clientId, timeoutMs]);

  return (
    <div id="paypal-button-container" data-testid="paypal-slot">
      {phase === 'loading' && (
        <button
          className="sc-paypal__slot sc-paypal__slot--loading"
          type="button"
          aria-disabled="true"
          aria-busy="true"
        >
          <Icon name="i-loader" size="sm" className="sc-spinner sc-visually-hidden" />
          Loading secure payment…
        </button>
      )}
      <div ref={host} />
    </div>
  );
}
