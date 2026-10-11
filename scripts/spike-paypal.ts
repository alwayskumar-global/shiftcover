/**
 * Spike (12.3 step 4): AUTHORIZE order -> manual sandbox approval -> authorize -> partial capture
 * (final_capture: true) -> payout to a worker sandbox email -> fetch batch.
 * Run ONLY after env is set: npx tsx scripts/spike-paypal.ts
 * Sandbox only (the client refuses any other base URL). Never prints secrets or tokens.
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import {
  authorizeOrder,
  captureAuthorization,
  createAuthorizeOrder,
  createPayout,
  getPayoutBatch,
  senderBatchId,
} from '../src/paypal/api';
import { createPaypalClient, PaypalError } from '../src/paypal/client';

const env = (() => {
  const r = z
    .object({
      PAYPAL_ENV: z.literal('sandbox').default('sandbox'),
      PAYPAL_API_BASE: z.string().default('https://api-m.sandbox.paypal.com'),
      PAYPAL_CLIENT_ID: z.string().min(1),
      PAYPAL_CLIENT_SECRET: z.string().min(1),
      PAYPAL_PLATFORM_EMAIL: z.email(),
      /** Sandbox personal account that receives the payout. Must differ from the platform account. */
      SPIKE_WORKER_EMAIL: z.email(),
    })
    .safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')));
  if (!r.success) {
    console.error('Missing/invalid env:', r.error.issues.map((i) => i.path.join('.')).join(', '));
    process.exit(1);
  }
  return r.data;
})();

const AUTHORIZE_CENTS = 1000; // $10.00 max authorization
const CAPTURE_CENTS = 600; // $6.00 actual (partial capture; remainder released by final_capture)
const PAYOUT_CENTS = 500; // $5.00 to the worker (the $1.00 difference stands in for the platform fee)

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
  });
  const approve = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  console.log(`order ${order.id} status=${order.status}`);
  console.log(`\nApprove as a SANDBOX BUYER in a browser:\n${approve ?? '(no approval link returned)'}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter after approving... ');
  rl.close();

  const authorized = await authorizeOrder(client, order.id, `${run}-authorize`);
  const authId = authorized.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
  if (!authId) throw new Error(`No authorization id returned (order status=${authorized.status})`);
  console.log(`authorization ${authId}`);

  const capture = await captureAuthorization(client, {
    authorizationId: authId,
    captureCents: CAPTURE_CENTS,
    invoiceId: `${run}-1`,
    note: 'ShiftCover spike partial capture',
    requestId: `${run}-capture`,
  });
  console.log(`capture ${capture.id} status=${capture.status}`);

  const batchId = senderBatchId(run);
  const payout = await createPayout(client, {
    senderBatchId: batchId,
    senderItemId: `${run}-item`,
    receiverEmail: env.SPIKE_WORKER_EMAIL,
    platformEmail: env.PAYPAL_PLATFORM_EMAIL,
    amountCents: PAYOUT_CENTS,
    subject: 'ShiftCover spike payout',
    message: 'Sandbox test payout',
    note: 'spike',
    requestId: `${run}-payout`,
  });
  const payoutBatchId = payout.batch_header.payout_batch_id;
  console.log(`payout batch ${payoutBatchId} status=${payout.batch_header.batch_status}`);

  for (let i = 0; i < 12; i++) {
    const b = await getPayoutBatch(client, payoutBatchId);
    const items = (b.items ?? []).map((it) => `${it.payout_item_id}:${it.transaction_status}`).join(', ');
    console.log(`batch status=${b.batch_header.batch_status} items=[${items}]`);
    if (['SUCCESS', 'DENIED'].includes(b.batch_header.batch_status)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log('\nNext: confirm balances in the sandbox dashboard (buyer -$6.00, platform +$6.00 -$5.00, worker +$5.00).');
}

main().catch((e: unknown) => {
  if (e instanceof PaypalError) {
    console.error(`PayPal error kind=${e.kind} status=${e.status} code=${e.code} debug_id=${e.debugId}`);
  } else {
    console.error('spike failed:', e instanceof Error ? e.message : 'unknown error');
  }
  process.exit(1);
});
