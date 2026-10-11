import { formatUsd } from '../domain/money';
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
    payments?: { authorizations?: Array<{ id: string; status: string }> };
  }>;
}

export interface CaptureResponse {
  id: string;
  status: string;
}

export interface PayoutBatchResponse {
  batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header?: unknown };
  items?: Array<{
    payout_item_id: string;
    transaction_status: string;
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
export function senderBatchId(paymentId: string): string {
  return `sc-${paymentId}`;
}

export function createAuthorizeOrder(
  client: PaypalClient,
  args: { slotId: string; attempt: number; maxCents: number; requestId: string },
) {
  return client.request<OrderResponse>({
    method: 'POST',
    path: '/v2/checkout/orders',
    requestId: args.requestId,
    body: {
      intent: 'AUTHORIZE',
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
    body: {},
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
    body: {
      amount: { currency_code: 'USD', value: formatUsd(args.captureCents) },
      final_capture: true,
      invoice_id: args.invoiceId,
      ...(args.note ? { note_to_payer: args.note } : {}),
    },
  });
}

export function voidAuthorization(client: PaypalClient, authorizationId: string, requestId: string) {
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
