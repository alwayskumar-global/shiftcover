import { randomUUID } from 'node:crypto';
import { PaypalError } from '../src/paypal/client';
import { requestIds, senderBatchIdFor } from '../src/paypal/ids';
import type { CaptureStatus, PaymentsGateway } from '../src/paypal/gateway';

/**
 * In-memory PayPal for service tests. It behaves like the real API where it matters here: operations keyed by
 * PayPal-Request-Id are idempotent (a repeat returns the first result and moves no money twice), a duplicate
 * sender_batch_id is refused, and failures can be scripted per operation.
 */
export const pp = (
  status: number,
  code: string,
  kind: ConstructorParameters<typeof PaypalError>[1],
) => new PaypalError(`PayPal ${status} ${code}`, kind, status, code, [{ issue: code }], 'debug');

type Fail = { op: string; error: Error; times: number; afterEffect?: boolean };

export class FakeGateway implements PaymentsGateway {
  orders = new Map<
    string,
    { slotId: string; attempt: number; cents: number; status: string; authId?: string }
  >();
  auths = new Map<string, { status: string; cents: number; expires: Date }>();
  captures = new Map<string, { status: CaptureStatus; cents: number; fee: number }>();
  batches = new Map<
    string,
    {
      status: string;
      item: { id: string; status: string; fee: number; error?: string };
      cents: number;
      receiver: string;
    }
  >();
  senderBatchIds = new Set<string>();
  /** idempotency: request id -> first result */
  seen = new Map<string, unknown>();
  calls: Array<{ op: string; requestId?: string; args: unknown }> = [];
  fails: Fail[] = [];
  /** Where an order stands in PayPal when the buyer has (not) approved. */
  approve = true;
  nextCaptureStatus: CaptureStatus = 'COMPLETED';
  nextPayoutItemStatus = 'SUCCESS';

  failNext(op: string, error: Error, times = 1, afterEffect = false) {
    this.fails.push({ op, error, times, afterEffect });
  }
  count(op: string) {
    return this.calls.filter((c) => c.op === op).length;
  }
  private rec(op: string, args: unknown, requestId?: string) {
    this.calls.push({ op, requestId, args });
  }
  private failure(op: string, afterEffect: boolean) {
    const f = this.fails.find((x) => x.op === op && x.times > 0 && !!x.afterEffect === afterEffect);
    if (f) {
      f.times--;
      throw f.error;
    }
  }
  private once<T>(op: string, requestId: string, effect: () => T): T {
    this.failure(op, false);
    const key = `${op}:${requestId}`;
    let out: T;
    if (this.seen.has(key)) out = this.seen.get(key) as T;
    else {
      out = effect();
      this.seen.set(key, out);
    }
    this.failure(op, true); // the effect happened, the response was "lost"
    return out;
  }

  async createOrder(a: { slotId: string; attempt: number; maxCents: number }) {
    const rid = requestIds.order(a.slotId, a.attempt);
    this.rec('createOrder', a, rid);
    return this.once('createOrder', rid, () => {
      const orderId = `ORD${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;
      this.orders.set(orderId, {
        slotId: a.slotId,
        attempt: a.attempt,
        cents: a.maxCents,
        status: 'CREATED',
      });
      return { orderId, status: 'CREATED' };
    });
  }
  async getOrder(orderId: string) {
    this.rec('getOrder', { orderId });
    const o = this.orders.get(orderId);
    if (!o) throw pp(404, 'RESOURCE_NOT_FOUND', 'not_found');
    const status = this.approve && o.status === 'CREATED' ? 'APPROVED' : o.status;
    const a = o.authId ? this.auths.get(o.authId) : undefined;
    return {
      status,
      authorizationId: o.authId,
      authorizationStatus: a?.status,
      authorizedCents: a?.cents,
    };
  }
  async authorize(a: { orderId: string; slotId: string; attempt: number }) {
    const rid = requestIds.authorize(a.slotId, a.attempt);
    this.rec('authorize', a, rid);
    const o = this.orders.get(a.orderId);
    if (!o) throw pp(404, 'RESOURCE_NOT_FOUND', 'not_found');
    if (!this.approve && o.status === 'CREATED') throw pp(422, 'ORDER_NOT_APPROVED', 'validation');
    return this.once('authorize', rid, () => {
      const id = `AUTH${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;
      const expires = new Date(Date.now() + 3 * 24 * 3600_000);
      this.auths.set(id, { status: 'CREATED', cents: o.cents, expires });
      o.status = 'COMPLETED';
      o.authId = id;
      return {
        status: 'COMPLETED',
        authorizationId: id,
        authorizationStatus: 'CREATED',
        authorizedCents: o.cents,
        expiresAt: expires,
      };
    });
  }
  async capture(a: {
    authorizationId: string;
    paymentId: string;
    captureAttempt: number;
    captureCents: number;
    invoiceId: string;
  }) {
    const rid = requestIds.capture(a.paymentId, a.captureAttempt);
    this.rec('capture', a, rid);
    return this.once('capture', rid, () => {
      const auth = this.auths.get(a.authorizationId);
      if (!auth) throw pp(404, 'RESOURCE_NOT_FOUND', 'not_found');
      if (auth.status === 'VOIDED') throw pp(422, 'AUTHORIZATION_VOIDED', 'validation');
      if (a.captureCents > auth.cents) throw pp(422, 'AUTHORIZATION_AMOUNT_EXCEEDED', 'validation');
      const captureId = `CAP${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;
      const status = this.nextCaptureStatus;
      if (status === 'DECLINED') throw pp(422, 'INSTRUMENT_DECLINED', 'validation');
      const fee = Math.round(a.captureCents * 0.029) + 30;
      this.captures.set(captureId, { status, cents: a.captureCents, fee });
      if (status === 'COMPLETED') auth.status = 'CAPTURED';
      return { captureId, status, capturedCents: a.captureCents, paypalFeeCents: fee };
    });
  }
  async void(a: { authorizationId: string; paymentId: string }) {
    const rid = requestIds.void(a.paymentId);
    this.rec('void', a, rid);
    this.failure('void', false);
    const auth = this.auths.get(a.authorizationId);
    if (!auth) throw pp(404, 'RESOURCE_NOT_FOUND', 'not_found');
    if (auth.status === 'CAPTURED') throw pp(422, 'AUTHORIZATION_ALREADY_CAPTURED', 'validation');
    auth.status = 'VOIDED';
  }
  async getAuthorization(authorizationId: string) {
    this.rec('getAuthorization', { authorizationId });
    const a = this.auths.get(authorizationId);
    if (!a) throw pp(404, 'RESOURCE_NOT_FOUND', 'not_found');
    return { status: a.status, amountCents: a.cents };
  }
  async getCapture(captureId: string) {
    this.rec('getCapture', { captureId });
    const c = this.captures.get(captureId);
    if (!c) throw pp(404, 'RESOURCE_NOT_FOUND', 'not_found');
    return { status: c.status, amountCents: c.cents, paypalFeeCents: c.fee };
  }
  async createPayout(a: {
    paymentId: string;
    slotId: string;
    payoutAttempt: number;
    receiverEmail: string;
    amountCents: number;
    note: string;
  }) {
    const rid = requestIds.payout(a.slotId, a.payoutAttempt);
    this.rec('createPayout', a, rid);
    return this.once('createPayout', rid, () => {
      const sbi = senderBatchIdFor(a.paymentId, a.payoutAttempt);
      if (this.senderBatchIds.has(sbi)) throw pp(400, 'DUPLICATE_SENDER_BATCH_ID', 'validation');
      this.senderBatchIds.add(sbi);
      const batchId = `PAYOUT${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
      const itemStatus = this.nextPayoutItemStatus;
      this.batches.set(batchId, {
        status: itemStatus === 'SUCCESS' ? 'SUCCESS' : 'PENDING',
        item: { id: `ITEM${randomUUID().slice(0, 8)}`, status: itemStatus, fee: 25 },
        cents: a.amountCents,
        receiver: a.receiverEmail,
      });
      return { batchId, batchStatus: 'PENDING' };
    });
  }
  async getPayoutBatch(batchId: string) {
    this.rec('getPayoutBatch', { batchId });
    const b = this.batches.get(batchId);
    if (!b) throw pp(404, 'RESOURCE_NOT_FOUND', 'not_found');
    return {
      batchStatus: b.status,
      items: [
        { itemId: b.item.id, status: b.item.status, feeCents: b.item.fee, errorName: b.item.error },
      ],
    };
  }
  /** Test hook: PayPal moves a payout item on by itself (what a webhook or a poll would reveal). */
  setPayoutItem(batchId: string, status: string, error?: string) {
    const b = this.batches.get(batchId)!;
    b.item.status = status;
    b.item.error = error;
    b.status = status === 'SUCCESS' ? 'SUCCESS' : 'PROCESSING';
  }
}
