/**
 * Loader for the PayPal JS SDK v6 (sandbox). The SDK is loaded only in PAYMENTS_MODE=paypal and never in stub mode.
 * Everything that can go wrong (script blocked, slow network, no eligible method) is one rejected promise with a
 * short reason, so the screen shows one error state.
 *
 * API used (https://developer.paypal.com/docsai/payments/methods/paypal/sdk/js/v6/paypal-checkout):
 *   window.paypal.createInstance({ clientId, components: ['paypal-payments'] })
 *   sdk.findEligibleMethods() -> .isEligible('paypal')
 *   sdk.createPayPalOneTimePaymentSession({ onApprove({orderId}), onCancel, onError })
 *   session.start({ presentationMode: 'auto' }, createOrderPromise)   // promise resolves { orderId }
 *   the button is PayPal's own <paypal-button> web component.
 */

export const PAYPAL_SDK_SRC = 'https://www.sandbox.paypal.com/web-sdk/v6/core';
export const SDK_TIMEOUT_MS = 10_000;

export interface PaypalSession {
  start(
    opts: { presentationMode: 'auto' | 'popup' | 'modal' | 'redirect' },
    order: Promise<{ orderId: string }>,
  ): Promise<void>;
  destroy?(): void;
}
export interface PaypalSdkInstance {
  findEligibleMethods(): Promise<{ isEligible(method: string): boolean }>;
  createPayPalOneTimePaymentSession(cb: {
    onApprove: (data: { orderId: string }) => void | Promise<void>;
    onCancel?: () => void;
    onError?: (err: unknown) => void;
  }): Promise<PaypalSession> | PaypalSession;
}
declare global {
  interface Window {
    paypal?: {
      createInstance(o: { clientId: string; components: string[] }): Promise<PaypalSdkInstance>;
    };
  }
}

export type SdkFailure = 'timeout' | 'script' | 'ineligible' | 'init';

export class PaypalSdkError extends Error {
  constructor(readonly reason: SdkFailure) {
    super(`PayPal SDK unavailable: ${reason}`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new PaypalSdkError('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

function loadScript(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (window.paypal) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PAYPAL_SDK_SRC}"]`);
    const s = existing ?? document.createElement('script');
    s.addEventListener('load', () => resolve(), { once: true });
    s.addEventListener('error', () => reject(new PaypalSdkError('script')), { once: true });
    if (!existing) {
      s.src = PAYPAL_SDK_SRC;
      s.async = true;
      document.head.appendChild(s);
    }
  });
}

/** Resolves an SDK instance with PayPal as an eligible method, or rejects with PaypalSdkError within `timeoutMs`. */
export function loadPaypalSdk(
  clientId: string,
  timeoutMs = SDK_TIMEOUT_MS,
): Promise<PaypalSdkInstance> {
  return withTimeout(
    (async () => {
      await loadScript();
      if (!window.paypal) throw new PaypalSdkError('script');
      let sdk: PaypalSdkInstance;
      try {
        sdk = await window.paypal.createInstance({ clientId, components: ['paypal-payments'] });
      } catch {
        throw new PaypalSdkError('init');
      }
      const eligible = await sdk.findEligibleMethods();
      if (!eligible.isEligible('paypal')) throw new PaypalSdkError('ineligible');
      return sdk;
    })(),
    timeoutMs,
  );
}
