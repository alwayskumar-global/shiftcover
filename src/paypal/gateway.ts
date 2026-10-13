import { parseUsd } from '../domain/money';
import {
  authorizeOrder,
  captureAuthorization,
  createAuthorizeOrder,
  createPayout,
  getAuthorization,
  getCapture,
  getOrder,
  getPayoutBatch,
  voidAuthorization,
  type OrderResponse,
} from './api';
import type { PaypalClient } from './client';
import { requestIds, senderBatchIdFor } from './ids';

/**
 * What the payment services need from PayPal, in our units (integer cents, our statuses). Services depend on this
 * interface only, so DB tests drive them with a fake and the mocked-fetch tests pin the real request bodies.
 */

export type CaptureStatus = 'COMPLETED' | 'PENDING' | 'DECLINED' | 'FAILED' | 'OTHER';

export interface PaymentsGateway {
  createOrder(a: {
    slotId: string;
    attempt: number;
    maxCents: number;
  }): Promise<{ orderId: string; status: string }>;
  getOrder(orderId: string): Promise<{
    status: string;
    authorizationId?: string;
    authorizationStatus?: string;
    authorizedCents?: number;
  }>;
  authorize(a: { orderId: string; slotId: string; attempt: number }): Promise<{
    status: string;
    authorizationId?: string;
    authorizationStatus?: string;
    authorizedCents?: number;
    expiresAt?: Date;
  }>;
  capture(a: {
    authorizationId: string;
    paymentId: string;
    captureAttempt: number;
    captureCents: number;
    invoiceId: string;
  }): Promise<{
    captureId: string;
    status: CaptureStatus;
    capturedCents: number;
    paypalFeeCents: number;
    reason?: string;
  }>;
  void(a: { authorizationId: string; paymentId: string }): Promise<void>;
  getAuthorization(authorizationId: string): Promise<{ status: string; amountCents?: number }>;
  getCapture(
    captureId: string,
  ): Promise<{ status: CaptureStatus; amountCents?: number; paypalFeeCents: number }>;
  createPayout(a: {
    paymentId: string;
    slotId: string;
    payoutAttempt: number;
    receiverEmail: string;
    amountCents: number;
    note: string;
  }): Promise<{ batchId: string; batchStatus: string }>;
  getPayoutBatch(batchId: string): Promise<{
    batchStatus: string;
    items: Array<{
      itemId: string;
      status: string;
      feeCents: number;
      errorName?: string;
      senderItemId?: string;
    }>;
  }>;
}

const cents = (a?: { value: string }) => {
  if (!a) return undefined;
  try {
    return parseUsd(a.value);
  } catch {
    return undefined;
  }
};

const captureStatus = (s: string): CaptureStatus =>
  s === 'COMPLETED' || s === 'PENDING' || s === 'DECLINED' || s === 'FAILED' ? s : 'OTHER';

function authFromOrder(o: OrderResponse) {
  const a = o.purchase_units?.[0]?.payments?.authorizations?.[0];
  return {
    authorizationId: a?.id,
    authorizationStatus: a?.status,
    authorizedCents: cents(a?.amount),
    expiresAt: a?.expiration_time ? new Date(a.expiration_time) : undefined,
  };
}

export function createPaypalGateway(
  client: PaypalClient,
  opts: { platformEmail: string },
): PaymentsGateway {
  return {
    async createOrder(a) {
      const o = await createAuthorizeOrder(client, {
        slotId: a.slotId,
        attempt: a.attempt,
        maxCents: a.maxCents,
        requestId: requestIds.order(a.slotId, a.attempt),
      });
      return { orderId: o.id, status: o.status };
    },
    async getOrder(orderId) {
      const o = await getOrder(client, orderId);
      const { authorizationId, authorizationStatus, authorizedCents } = authFromOrder(o);
      return { status: o.status, authorizationId, authorizationStatus, authorizedCents };
    },
    async authorize(a) {
      const o = await authorizeOrder(client, a.orderId, requestIds.authorize(a.slotId, a.attempt));
      return { status: o.status, ...authFromOrder(o) };
    },
    async capture(a) {
      const c = await captureAuthorization(client, {
        authorizationId: a.authorizationId,
        captureCents: a.captureCents,
        invoiceId: a.invoiceId,
        note: 'ShiftCover Pay shift payment',
        requestId: requestIds.capture(a.paymentId, a.captureAttempt),
      });
      return {
        captureId: c.id,
        status: captureStatus(c.status),
        capturedCents: cents(c.amount) ?? a.captureCents,
        paypalFeeCents: cents(c.seller_receivable_breakdown?.paypal_fee) ?? 0,
        reason: c.status_details?.reason,
      };
    },
    async void(a) {
      await voidAuthorization(client, a.authorizationId, requestIds.void(a.paymentId));
    },
    async getAuthorization(authorizationId) {
      const a = await getAuthorization(client, authorizationId);
      return { status: a.status, amountCents: cents(a.amount) };
    },
    async getCapture(captureId) {
      const c = await getCapture(client, captureId);
      return {
        status: captureStatus(c.status),
        amountCents: cents(c.amount),
        paypalFeeCents: cents(c.seller_receivable_breakdown?.paypal_fee) ?? 0,
      };
    },
    async createPayout(a) {
      const r = await createPayout(client, {
        senderBatchId: senderBatchIdFor(a.paymentId, a.payoutAttempt),
        senderItemId: `${a.paymentId}-${a.payoutAttempt}`,
        receiverEmail: a.receiverEmail,
        platformEmail: opts.platformEmail,
        amountCents: a.amountCents,
        subject: 'You have been paid for your shift',
        message: 'Thanks for covering the shift. Your pay is on its way.',
        note: a.note,
        requestId: requestIds.payout(a.slotId, a.payoutAttempt),
      });
      return { batchId: r.batch_header.payout_batch_id, batchStatus: r.batch_header.batch_status };
    },
    async getPayoutBatch(batchId) {
      const b = await getPayoutBatch(client, batchId);
      return {
        batchStatus: b.batch_header.batch_status,
        items: (b.items ?? []).map((i) => ({
          itemId: i.payout_item_id,
          status: i.transaction_status,
          feeCents: cents(i.payout_item_fee ? { value: i.payout_item_fee.value } : undefined) ?? 0,
          errorName: i.errors?.name,
          senderItemId: i.payout_item?.sender_item_id,
        })),
      };
    },
  };
}
