/**
 * Spike (12.3 step 4): AUTHORIZE order -> manual sandbox approval -> authorize -> partial capture
 * (final_capture: true) -> payout to a worker sandbox email -> fetch batch.
 * Run ONLY after env is set: npx tsx scripts/spike-paypal.ts
 * Sandbox only (the client refuses any other base URL). Never prints secrets or tokens.
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import {
  approvalLink,
  authorizeOrder,
  captureAuthorization,
  checkOrderApproved,
  createAuthorizeOrder,
  createPayout,
  getOrder,
  getPayoutBatch,
  senderBatchId,
} from '../src/paypal/api';
import { createPaypalClient, PaypalError } from '../src/paypal/client';
import { checkSpikeEnv } from './lib/spike-paypal-guards';

const guard = checkSpikeEnv(process.env);
if (!guard.ok) {
  console.error('Refusing to run:\n' + guard.problems.map((p) => ` - ${p}`).join('\n'));
  process.exit(1);
}
const env = guard.env;

const AUTHORIZE_CENTS = 1000; // $10.00 max authorization
const CAPTURE_CENTS = 600; // $6.00 actual (partial capture; remainder released by final_capture)
const PAYOUT_CENTS = 500; // $5.00 to the worker (the $1.00 difference stands in for the platform fee)
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

interface Row {
  step: string;
  id: string;
  status: string;
  amount: string;
  fee: string;
}
const rows: Row[] = [];

function printSummary() {
  console.log('\n=== Summary ===');
  console.table(rows);
}

async function main() {
  const client = createPaypalClient({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    baseUrl: env.PAYPAL_API_BASE,
  });
  const run = `spike-${Date.now()}`; // idempotency namespace for this run

  const order = await createAuthorizeOrder(client, {
    slotId: run,
    attempt: 1,
    maxCents: AUTHORIZE_CENTS,
    requestId: `${run}-order`,
    redirect: {
      returnUrl: 'https://example.com/spike/return',
      cancelUrl: 'https://example.com/spike/cancel',
      brandName: 'ShiftCover Spike',
    },
  });
  rows.push({
    step: 'order',
    id: order.id,
    status: order.status,
    amount: usd(AUTHORIZE_CENTS),
    fee: '-',
  });

  const link = approvalLink(order);
  if (!link) {
    console.error('Create-order response had no payer-action/approve link. Cannot continue.');
    printSummary();
    process.exitCode = 1;
    return;
  }
  console.log(`order ${order.id} status=${order.status}`);
  console.log(
    '\nOpen this link in a PRIVATE window and approve with your US Personal BUYER sandbox account\n' +
      '(not the Business/platform account, not the worker account):\n\n' +
      `${link}\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter after approving... ');
  rl.close();

  const current = await getOrder(client, order.id);
  console.log(`order status after approval step: ${current.status}`);
  const check = checkOrderApproved(current);
  if (!check.approved) {
    console.error(
      `\nOrder is ${check.status}, not APPROVED, so authorize was NOT called.\n` +
        'The buyer has not completed approval (or cancelled). Re-run the script for a fresh order.',
    );
    rows[0]!.status = check.status;
    printSummary();
    process.exitCode = 2;
    return;
  }
  rows[0]!.status = current.status;

  const authorized = await authorizeOrder(client, order.id, `${run}-authorize`);
  const auth = authorized.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth?.id)
    throw new Error(`No authorization id returned (order status=${authorized.status})`);
  rows.push({
    step: 'authorization',
    id: auth.id,
    status: auth.status,
    amount: usd(AUTHORIZE_CENTS),
    fee: '-',
  });
  console.log(`authorization ${auth.id} status=${auth.status}`);

  const capture = await captureAuthorization(client, {
    authorizationId: auth.id,
    captureCents: CAPTURE_CENTS,
    invoiceId: `${run}-1`,
    note: 'ShiftCover spike partial capture',
    requestId: `${run}-capture`,
  });
  const captureFee = capture.seller_receivable_breakdown?.paypal_fee;
  rows.push({
    step: 'capture (final)',
    id: capture.id,
    status: capture.status,
    amount: usd(CAPTURE_CENTS),
    fee: captureFee ? `${captureFee.value} ${captureFee.currency_code}` : 'n/a',
  });
  console.log(`capture ${capture.id} status=${capture.status}`);

  const payout = await createPayout(client, {
    senderBatchId: senderBatchId(run),
    senderItemId: `${run}-item`,
    receiverEmail: env.SPIKE_WORKER_EMAIL,
    platformEmail: env.PAYPAL_PLATFORM_EMAIL,
    amountCents: PAYOUT_CENTS,
    subject: 'ShiftCover spike payout',
    message: 'Sandbox test payout',
    note: 'spike',
    requestId: `${run}-payout`,
  });
  const batchId = payout.batch_header.payout_batch_id;
  console.log(`payout batch ${batchId} status=${payout.batch_header.batch_status}`);

  let finalBatch = await getPayoutBatch(client, batchId);
  for (let i = 0; i < 12; i++) {
    finalBatch = await getPayoutBatch(client, batchId);
    const items = (finalBatch.items ?? [])
      .map((it) => `${it.payout_item_id}:${it.transaction_status}`)
      .join(', ');
    console.log(`batch status=${finalBatch.batch_header.batch_status} items=[${items}]`);
    if (['SUCCESS', 'DENIED'].includes(finalBatch.batch_header.batch_status)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const fees = finalBatch.batch_header.fees;
  rows.push({
    step: 'payout batch',
    id: batchId,
    status: finalBatch.batch_header.batch_status,
    amount: usd(PAYOUT_CENTS),
    fee: fees ? `${fees.value} ${fees.currency}` : 'n/a',
  });
  for (const it of finalBatch.items ?? []) {
    rows.push({
      step: 'payout item',
      id: it.payout_item_id,
      status: it.transaction_status,
      amount: usd(PAYOUT_CENTS),
      fee: it.errors?.name ?? '-',
    });
  }
  printSummary();
  console.log(
    'Next: confirm balances in the sandbox dashboard (buyer -$6.00, platform +$6.00 -$5.00 less fees, worker +$5.00).',
  );
}

main().catch((e: unknown) => {
  if (e instanceof PaypalError) {
    console.error(
      `PayPal error: ${e.code ?? 'unknown'} | HTTP ${e.status ?? 'n/a'} | kind=${e.kind} | debug_id=${e.debugId ?? 'n/a'}`,
    );
  } else {
    console.error('spike failed:', e instanceof Error ? e.message : 'unknown error');
  }
  printSummary();
  process.exit(1);
});
