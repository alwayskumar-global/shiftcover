/**
 * M2 live sandbox run (local, PayPal SANDBOX only). Exercises the SHIPPED gateway code, not a copy:
 *   start   create an AUTHORIZE order (redirect-style approval) and print the approval link, then stop.
 *   finish  after you approved as a sandbox US Personal BUYER: authorize (amount verified), partial capture with
 *           final_capture, payout to the worker sandbox account, poll the batch to a final status, and repeat the
 *           capture and the payout with the same request ids to show no money moves twice.
 *
 *   npx tsx scripts/live-sandbox-m2.ts start
 *   npx tsx scripts/live-sandbox-m2.ts finish
 *
 * Needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_PLATFORM_EMAIL and SPIKE_WORKER_EMAIL in .env. No database.
 * Never prints credentials or tokens; PayPal object ids (order, authorization, capture, batch) are printed.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthorizeOrder, approvalLink } from '../src/paypal/api';
import { createPaypalClient } from '../src/paypal/client';
import { createPaypalGateway } from '../src/paypal/gateway';
import { requestIds } from '../src/paypal/ids';
import { checkSpikeEnv } from './lib/spike-paypal-guards';

const guard = checkSpikeEnv(process.env);
if (!guard.ok) {
  console.error('Refusing to run:\n' + guard.problems.map((p) => ` - ${p}`).join('\n'));
  process.exit(1);
}
const env = guard.env;

const HOLD_CENTS = 2000; // $20.00 max authorization
const CAPTURE_CENTS = 1200; // $12.00 actual (worker pay + platform fee)
const PAYOUT_CENTS = 1000; // $10.00 to the worker; the $2.00 difference stands in for the platform fee
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const STATE = join(tmpdir(), 'shiftcover-m2-live-state.json');

const client = createPaypalClient({
  clientId: env.PAYPAL_CLIENT_ID,
  clientSecret: env.PAYPAL_CLIENT_SECRET,
  baseUrl: env.PAYPAL_API_BASE,
});
const gw = createPaypalGateway(client, { platformEmail: env.PAYPAL_PLATFORM_EMAIL });

async function start() {
  const slotId = randomUUID();
  const paymentId = randomUUID();
  const order = await createAuthorizeOrder(client, {
    slotId,
    attempt: 1,
    maxCents: HOLD_CENTS,
    requestId: requestIds.order(slotId, 1),
    redirect: {
      returnUrl: 'https://example.com/m2-live/return',
      cancelUrl: 'https://example.com/m2-live/cancel',
      brandName: 'ShiftCover M2 live run',
    },
  });
  const link = approvalLink(order);
  if (!link) throw new Error('create-order response had no approval link');
  writeFileSync(STATE, JSON.stringify({ slotId, paymentId, orderId: order.id }));
  console.log(`order ${order.id} status=${order.status} hold=${usd(HOLD_CENTS)}`);
  console.log(
    '\nOpen this link in a PRIVATE window and approve with your US Personal BUYER sandbox account\n' +
      '(not the Business/platform account, not the worker account):\n\n' +
      `${link}\n\nThen run:  npx tsx scripts/live-sandbox-m2.ts finish\n`,
  );
}

async function finish() {
  const st = JSON.parse(readFileSync(STATE, 'utf8')) as {
    slotId: string;
    paymentId: string;
    orderId: string;
  };
  const rows: Array<Record<string, string>> = [];
  const order = await gw.getOrder(st.orderId);
  console.log(`order ${st.orderId} status=${order.status}`);
  if (order.status !== 'APPROVED') {
    console.error(
      `Order is ${order.status}, not APPROVED: the buyer has not approved it. Run start again for a fresh order.`,
    );
    process.exitCode = 2;
    return;
  }

  const auth = await gw.authorize({ orderId: st.orderId, slotId: st.slotId, attempt: 1 });
  if (!auth.authorizationId || auth.authorizationStatus !== 'CREATED')
    throw new Error('authorization was not created');
  if (auth.authorizedCents !== HOLD_CENTS)
    throw new Error(`authorized ${auth.authorizedCents}, expected ${HOLD_CENTS}`);
  rows.push({
    step: 'authorize',
    id: auth.authorizationId,
    status: auth.authorizationStatus,
    amount: usd(HOLD_CENTS),
    fee: '-',
  });

  const capArgs = {
    authorizationId: auth.authorizationId,
    paymentId: st.paymentId,
    captureAttempt: 1,
    captureCents: CAPTURE_CENTS,
    invoiceId: `${st.slotId}-1`,
  };
  const cap = await gw.capture(capArgs);
  rows.push({
    step: 'capture (final)',
    id: cap.captureId,
    status: cap.status,
    amount: usd(cap.capturedCents),
    fee: usd(cap.paypalFeeCents),
  });
  const cap2 = await gw.capture(capArgs); // same PayPal-Request-Id: must be the same capture, not a second charge
  rows.push({
    step: 'capture again (same id)',
    id: cap2.captureId,
    status: cap2.status,
    amount: usd(cap2.capturedCents),
    fee: '-',
  });
  if (cap2.captureId !== cap.captureId)
    throw new Error('a repeated capture created a second capture');

  const payArgs = {
    paymentId: st.paymentId,
    slotId: st.slotId,
    payoutAttempt: 1,
    receiverEmail: env.SPIKE_WORKER_EMAIL,
    amountCents: PAYOUT_CENTS,
    note: 'ShiftCover M2 live run',
  };
  const payout = await gw.createPayout(payArgs);
  rows.push({
    step: 'payout',
    id: payout.batchId,
    status: payout.batchStatus,
    amount: usd(PAYOUT_CENTS),
    fee: '-',
  });
  const payout2 = await gw
    .createPayout(payArgs)
    .catch((e: unknown) => ({
      batchId: `refused: ${e instanceof Error ? e.message : 'error'}`,
      batchStatus: '-',
    }));
  rows.push({
    step: 'payout again (same ids)',
    id: payout2.batchId,
    status: payout2.batchStatus,
    amount: '-',
    fee: '-',
  });
  if (payout2.batchId.startsWith('PAYOUT') || /^[A-Z0-9]{8,}$/.test(payout2.batchId)) {
    if (payout2.batchId !== payout.batchId)
      throw new Error('a repeated payout created a second batch');
  }

  let final = await gw.getPayoutBatch(payout.batchId);
  for (let i = 0; i < 24 && !['SUCCESS', 'DENIED', 'CANCELED'].includes(final.batchStatus); i++) {
    await new Promise((r) => setTimeout(r, 5000));
    final = await gw.getPayoutBatch(payout.batchId);
  }
  const item = final.items[0];
  rows.push({
    step: 'payout batch',
    id: payout.batchId,
    status: `${final.batchStatus} / item ${item?.status ?? '-'}`,
    amount: usd(PAYOUT_CENTS),
    fee: usd(item?.feeCents ?? 0),
  });
  console.table(rows);
  const ok = final.batchStatus === 'SUCCESS' && item?.status === 'SUCCESS';
  console.log(
    ok
      ? 'LIVE RUN OK: payout SUCCESS'
      : 'LIVE RUN INCOMPLETE: payout did not reach SUCCESS (see table)',
  );
  process.exitCode = ok ? 0 : 3;
}

const cmd = process.argv[2];
(cmd === 'start'
  ? start()
  : cmd === 'finish'
    ? finish()
    : Promise.reject(new Error('usage: start | finish'))
).catch((e: unknown) => {
  console.error('failed:', e instanceof Error ? e.message : 'unknown error');
  process.exit(1);
});
