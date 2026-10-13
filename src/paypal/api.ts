import { formatUsd } from '../domain/money';
import { senderBatchIdFor } from './ids';
import type { PaypalClient } from './client';

/** Thin typed wrappers over the endpoints in Section 7. Amounts are cents in, strings out. */

export interface Link {
  href: string;
  rel: string;
  method?: string;
}

export interface OrderResponse {
  id: string;
  status: string;
  links?: Link[];
  purchase_units?: Array<{
    payments?: {
      authorizations?: Array<{
        id: string;
        status: string;
        amount?: { currency_code: string; value: string };
        expiration_time?: string;
      }>;
    };
  }>;
}

export interface CaptureResponse {
  id: string;
  status: string;
  amount?: { currency_code: string; value: string };
  final_capture?: boolean;
  status_details?: { reason?: string };
  /** Present when the response is a full representation. */
  seller_receivable_breakdown?: {
    paypal_fee?: { currency_code: string; value: string };
    net_amount?: { currency_code: string; value: string };
  };
}

export interface RedirectExperience {
  returnUrl: string;
  cancelUrl: string;
  brandName: string;
}

/** Orders v2: `payer-action` is returned when payment_source.paypal is present; `approve` otherwise. */
export function approvalLink(order: OrderResponse): string | undefined {
  const find = (rel: string) => order.links?.find((l) => l.rel === rel)?.href;
  return find('payer-action') ?? find('approve');
}

export type ApprovalCheck = { approved: true } | { approved: false; status: string };

/** Authorize is only valid once the buyer approved the order. */
export function checkOrderApproved(order: Pick<OrderResponse, 'status'>): ApprovalCheck {
  return order.status === 'APPROVED'
    ? { approved: true }
    : { approved: false, status: order.status };
}

export interface PayoutBatchResponse {
  batch_header: {
    payout_batch_id: string;
    batch_status: string;
    amount?: { currency: string; value: string };
    fees?: { currency: string; value: string };
    sender_batch_header?: unknown;
  };
  items?: Array<{
    payout_item_id: string;
    transaction_status: string;
    payout_item_fee?: { currency: string; value: string };
    payout_item?: { sender_item_id?: string; receiver?: string };
    errors?: { name?: string; message?: string };
  }>;
}

export class SelfPayError extends Error {
  constructor() {
    super('Payout receiver must not be the platform account (SELF_PAY_NOT_ALLOWED)');
    this.name = 'SelfPayError';
  }
}

/** 7.5: deterministic so a retry reuses the same batch id. */
export function senderBatchId(paymentId: string, attempt = 1): string {
  return senderBatchIdFor(paymentId, attempt);
}

export function createAuthorizeOrder(
  client: PaypalClient,
  args: {
    slotId: string;
    attempt: number;
    maxCents: number;
    requestId: string;
    /** Redirect-style approval (scripts, /dev harness). Omit when the JS SDK button drives approval. */
    redirect?: RedirectExperience;
  },
) {
  return client.request<OrderResponse>({
    method: 'POST',
    path: '/v2/checkout/orders',
    requestId: args.requestId,
    body: {
      intent: 'AUTHORIZE',
      ...(args.redirect
        ? {
            payment_source: {
              paypal: {
                experience_context: {
                  return_url: args.redirect.returnUrl,
                  cancel_url: args.redirect.cancelUrl,
                  brand_name: args.redirect.brandName,
                  landing_page: 'LOGIN',
                  shipping_preference: 'NO_SHIPPING',
                  user_action: 'CONTINUE',
                },
              },
            },
          }
        : {}),
      purchase_units: [
        {
          custom_id: args.slotId,
          invoice_id: `${args.slotId}-${args.attempt}`,
          amount: { currency_code: 'USD', value: formatUsd(args.maxCents) },
        },
      ],
    },
  });
}

export function getOrder(client: PaypalClient, orderId: string) {
  return client.request<OrderResponse>({
    method: 'GET',
    path: `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
  });
}

export function authorizeOrder(client: PaypalClient, orderId: string, requestId: string) {
  return client.request<OrderResponse>({
    method: 'POST',
    path: `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
    requestId,
    // Without return=representation the response is only id, status and links: no authorization id or amount.
    headers: { Prefer: 'return=representation' },
    body: {},
  });
}

export interface AuthorizationResponse {
  id: string;
  status: string; // CREATED, CAPTURED, DENIED, PARTIALLY_CAPTURED, VOIDED, PENDING
  amount?: { currency_code: string; value: string };
  expiration_time?: string;
}

/** GET /v2/payments/authorizations/{authorization_id} (reconciliation). */
export function getAuthorization(client: PaypalClient, authorizationId: string) {
  return client.request<AuthorizationResponse>({
    method: 'GET',
    path: `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`,
  });
}

/** GET /v2/payments/captures/{capture_id} (reconciliation). */
export function getCapture(client: PaypalClient, captureId: string) {
  return client.request<CaptureResponse>({
    method: 'GET',
    path: `/v2/payments/captures/${encodeURIComponent(captureId)}`,
  });
}

export function captureAuthorization(
  client: PaypalClient,
  args: {
    authorizationId: string;
    captureCents: number;
    invoiceId: string;
    note?: string;
    requestId: string;
  },
) {
  return client.request<CaptureResponse>({
    method: 'POST',
    path: `/v2/payments/authorizations/${encodeURIComponent(args.authorizationId)}/capture`,
    requestId: args.requestId,
    headers: { Prefer: 'return=representation' }, // include seller_receivable_breakdown (fees)
    body: {
      amount: { currency_code: 'USD', value: formatUsd(args.captureCents) },
      final_capture: true,
      invoice_id: args.invoiceId,
      ...(args.note ? { note_to_payer: args.note } : {}),
    },
  });
}

export function voidAuthorization(
  client: PaypalClient,
  authorizationId: string,
  requestId: string,
) {
  return client.request<void>({
    method: 'POST',
    path: `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
    requestId,
  });
}

export function createPayout(
  client: PaypalClient,
  args: {
    senderBatchId: string;
    senderItemId: string;
    receiverEmail: string;
    platformEmail: string;
    amountCents: number;
    subject: string;
    message: string;
    note?: string;
    requestId: string;
  },
) {
  if (args.receiverEmail.trim().toLowerCase() === args.platformEmail.trim().toLowerCase()) {
    throw new SelfPayError();
  }
  return client.request<{ batch_header: { payout_batch_id: string; batch_status: string } }>({
    method: 'POST',
    path: '/v1/payments/payouts',
    requestId: args.requestId,
    body: {
      sender_batch_header: {
        sender_batch_id: args.senderBatchId,
        email_subject: args.subject,
        email_message: args.message,
      },
      items: [
        {
          recipient_type: 'EMAIL',
          receiver: args.receiverEmail,
          amount: { currency: 'USD', value: formatUsd(args.amountCents) },
          note: args.note,
          sender_item_id: args.senderItemId,
          purpose: 'SERVICES',
        },
      ],
    },
  });
}

export function getPayoutBatch(client: PaypalClient, batchId: string) {
  return client.request<PayoutBatchResponse>({
    method: 'GET',
    path: `/v1/payments/payouts/${encodeURIComponent(batchId)}`,
  });
}
