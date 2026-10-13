/**
 * M2 live approve-and-pay run: the SHIPPED services against the PayPal SANDBOX, on a throwaway LOCAL database.
 *   start   create a gap through createGap (the real gateway creates the AUTHORIZE order) and print the approval link.
 *   finish  after you approved as a sandbox US Personal buyer: authorizePayment (amount verified), the worker arrives and
 *           finishes, approveAndPay (capture with final_capture, then the payout to SPIKE_WORKER_EMAIL), then the same
 *           approval again and the same payout request again to show nothing moves twice (a duplicate sender_batch_id
 *           resolves to the ORIGINAL batch through PayPal's link). Polls reconcile until the payout is SUCCESS.
 *
 *   npx tsx scripts/live-approve-and-pay-m2.ts start
 *   npx tsx scripts/live-approve-and-pay-m2.ts finish
 *
 * Needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_PLATFORM_EMAIL, SPIKE_WORKER_EMAIL in .env (names only here). The
 * database is a constant on 127.0.0.1 (never DATABASE_URL), created and wiped by `start`. Never prints credentials or
 * tokens; PayPal object ids (order, authorization, capture, batch) are printed.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { Db } from '../src/db/client';
import * as schema from '../src/db/schema';
import { ledgerEntries, shiftSlots, workers } from '../src/db/schema';
import { approvalLink, getOrder } from '../src/paypal/api';
import { createPaypalClient } from '../src/paypal/client';
import { createPaypalGateway } from '../src/paypal/gateway';
import { createGap } from '../src/services/gaps';
import { outboxNotifier } from '../src/services/notifier';
import { latestPayment } from '../src/services/payment-queries';
import { approveAndPay, authorizePayment, reconcilePayments } from '../src/services/payments';
import { arrive, finish } from '../src/services/shift-day';
import type { ServiceDeps } from '../src/services/types';
import { makeOrg, makeWorker } from '../test/factories';
import { checkSpikeEnv } from './lib/spike-paypal-guards';

const guard = checkSpikeEnv(process.env);
if (!guard.ok) {
  console.error('Refusing to run:\n' + guard.problems.map((p) => ` - ${p}`).join('\n'));
  process.exit(1);
}
const env = guard.env;

const DB_NAME = 'shiftcover_live_m2';
const ADMIN = 'postgres://postgres:test@127.0.0.1:54329/postgres';
const URL_ = `postgres://postgres:test@127.0.0.1:54329/${DB_NAME}`;
for (const u of [ADMIN, URL_]) {
  if (new URL(u).hostname !== '127.0.0.1')
    throw new Error('this script only ever uses the local database');
}
const STATE = join(tmpdir(), 'shiftcover-m2-live-approve-state.json');
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

const client = createPaypalClient({
  clientId: env.PAYPAL_CLIENT_ID,
  clientSecret: env.PAYPAL_CLIENT_SECRET,
  baseUrl: env.PAYPAL_API_BASE,
});
const gateway = createPaypalGateway(client, { platformEmail: env.PAYPAL_PLATFORM_EMAIL });

function buildDeps(db: Db, now: () => Date): ServiceDeps {
  return {
    db,
    notifier: outboxNotifier,
    enqueue: async () => undefined,
    now,
    config: {
      appBaseUrl: 'http://127.0.0.1:3300',
      tokenPepper: 'live-run-pepper-0123456789abcdef0123456789',
      offerTtlSeconds: 900,
      waveIntervalSeconds: 300,
      platformFeeBps: 500,
      paymentsMode: 'paypal',
    },
    payments: gateway,
  };
}

async function start() {
  const admin = new Pool({ connectionString: ADMIN, max: 1 });
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();
  const pool = new Pool({ connectionString: URL_, max: 2 });
  const db = drizzle(pool, { schema }) as unknown as Db;
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });

  const o = await makeOrg(db);
  const worker = await makeWorker(db, o.org.id, { name: 'Live Worker', paypalEmail: true });
  await db
    .update(workers)
    .set({ paypalEmail: env.SPIKE_WORKER_EMAIL })
    .where(eq(workers.id, worker.id));
  const now = new Date();
  const deps = buildDeps(db, () => now);
  // a 2 hour shift that started 30 minutes ago, $10.00/hr, no premium: hold = 2 h x $10 + 5% fee = $21.00
  const r = await createGap(
    deps,
    { orgId: o.org.id, userId: o.manager.id },
    {
      venueId: o.venue.id,
      role: 'line_cook',
      startAt: new Date(now.getTime() - 30 * 60_000),
      endAt: new Date(now.getTime() + 90 * 60_000),
      baseRateCents: 1000,
      maxPremiumPct: 0,
    },
  );
  const pay = (await latestPayment(db, r.slot.id))!;
  if (!pay.paypalOrderId) throw new Error('the order was not created');
  const link = approvalLink(await getOrder(client, pay.paypalOrderId));
  if (!link) throw new Error('PayPal returned no approval link for the order');
  writeFileSync(
    STATE,
    JSON.stringify({
      slotId: r.slot.id,
      orgId: o.org.id,
      userId: o.manager.id,
      workerId: worker.id,
    }),
  );
  console.log(`order ${pay.paypalOrderId} hold=${usd(pay.authorizedCents)} (gap ${r.slot.id})`);
  console.log(
    '\nOpen this link in a PRIVATE window and approve with your US Personal BUYER sandbox account\n' +
      `(not the Business/platform account, not the worker account):\n\n${link}\n\n` +
      'Then run:  npx tsx scripts/live-approve-and-pay-m2.ts finish\n',
  );
  await pool.end();
}

async function finishRun() {
  const st = JSON.parse(readFileSync(STATE, 'utf8')) as {
    slotId: string;
    orgId: string;
    userId: string;
    workerId: string;
  };
  const pool = new Pool({ connectionString: URL_, max: 2 });
  const db = drizzle(pool, { schema }) as unknown as Db;
  const ctx = { orgId: st.orgId, userId: st.userId };
  const rows: Array<Record<string, string>> = [];
  const [slot0] = await db.select().from(shiftSlots).where(eq(shiftSlots.id, st.slotId));
  const now = () => new Date();
  const deps = buildDeps(db, now);

  let pay = (await latestPayment(db, st.slotId))!;
  const order = await gateway.getOrder(pay.paypalOrderId!);
  console.log(`order ${pay.paypalOrderId} status=${order.status}`);
  if (pay.status === 'AUTH_PENDING_APPROVAL') {
    if (order.status !== 'APPROVED') {
      console.error(
        `Order is ${order.status}, not APPROVED: the buyer has not approved it. Run start again for a fresh order.`,
      );
      process.exitCode = 2;
      await pool.end();
      return;
    }
    await authorizePayment(deps, ctx, st.slotId, pay.paypalOrderId!);
    pay = (await latestPayment(db, st.slotId))!;
  }
  rows.push({
    step: 'authorize',
    id: pay.authorizationId ?? '',
    status: pay.status,
    amount: usd(pay.authorizedCents),
  });

  if (slot0!.status === 'PLANNED' || slot0!.status === 'OPEN' || slot0!.status === 'OFFERING') {
    // the shift was claimed by the worker (the claim flow is covered elsewhere): book it, then run the shift day for real
    await db
      .update(shiftSlots)
      .set({ status: 'CONFIRMED', workerId: st.workerId, offeredRateCents: 1000 })
      .where(eq(shiftSlots.id, st.slotId));
    await arrive(deps, st.workerId, st.slotId);
    await finish(deps, st.workerId, st.slotId);
  }

  const hours = 2;
  const r1 = await approveAndPay(deps, ctx, st.slotId, hours);
  pay = (await latestPayment(db, st.slotId))!;
  rows.push({
    step: 'approve and pay (capture, payout)',
    id: pay.captureId ?? '',
    status: r1.paymentStatus,
    amount: usd(r1.captureCents),
  });
  const batchId = pay.payoutBatchId;
  if (!batchId) throw new Error('no payout batch was recorded');

  // the same approval again: no second capture, no second batch
  const r2 = await approveAndPay(deps, ctx, st.slotId, hours).catch((e: unknown) => ({
    paymentStatus: `refused: ${e instanceof Error ? e.message : 'error'}`,
    captureCents: 0,
  }));
  rows.push({
    step: 'approve again (same hours)',
    id: pay.captureId ?? '',
    status: r2.paymentStatus,
    amount: usd(r2.captureCents),
  });
  const after = (await latestPayment(db, st.slotId))!;
  if (after.captureId !== pay.captureId || after.payoutBatchId !== batchId)
    throw new Error('a repeated approval changed the capture or the batch');

  // the same payout request again (same sender_batch_id): must resolve to the ORIGINAL batch
  const dup = await gateway.createPayout({
    paymentId: pay.id,
    slotId: st.slotId,
    payoutAttempt: pay.payoutAttempt,
    receiverEmail: env.SPIKE_WORKER_EMAIL,
    amountCents: pay.workerPayCents,
    note: 'ShiftCover live approve-and-pay run',
  });
  rows.push({
    step: 'payout again (same ids)',
    id: dup.batchId,
    status: `${dup.batchStatus}${dup.existing ? ' (resolved existing batch)' : ''}`,
    amount: '-',
  });
  if (dup.batchId !== batchId) throw new Error('a repeated payout returned a different batch');

  for (let i = 0; i < 24; i++) {
    const cur = (await latestPayment(db, st.slotId))!;
    if (cur.status === 'PAID') break;
    await new Promise((res) => setTimeout(res, 5000));
    await reconcilePayments(deps); // the throwaway database holds only this run
  }
  const done = (await latestPayment(db, st.slotId))!;
  const [slot] = await db.select().from(shiftSlots).where(eq(shiftSlots.id, st.slotId));
  const ledger = (
    await db.select().from(ledgerEntries).where(eq(ledgerEntries.paymentId, done.id))
  ).map((l) => `${l.type} ${usd(l.amountCents)}`);
  rows.push({
    step: 'payout batch',
    id: batchId,
    status: `${done.status} (slot ${slot!.status})`,
    amount: usd(done.workerPayCents),
  });
  console.table(rows);
  console.log('ledger:', ledger.join(', '));
  const ok = done.status === 'PAID' && slot!.status === 'SETTLED';
  console.log(ok ? 'LIVE RUN OK: payout SUCCESS, slot SETTLED' : 'LIVE RUN INCOMPLETE: see table');
  process.exitCode = ok ? 0 : 3;
  await pool.end();
}

const cmd = process.argv[2];
(cmd === 'start'
  ? start()
  : cmd === 'finish'
    ? finishRun()
    : Promise.reject(new Error('usage: start | finish'))
).catch((e: unknown) => {
  console.error('failed:', e instanceof Error ? e.message : 'unknown error');
  process.exit(1);
});
