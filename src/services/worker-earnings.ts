import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { payments, shiftSlots, venues } from '../db/schema';
import type { PaymentState } from '../domain/states';
import { localParts, localWeekKey } from '../lib/time';
import type { DbLike } from './types';

/**
 * The worker's own pay, one row per approved shift (PLAN 4D). Every query is scoped by the authenticated worker id and
 * selects only the worker's side of the money: worker pay, never the authorization, the capture or the platform fee.
 */
export type EarningStatus = 'approved' | 'paying' | 'paid' | 'failed';

export interface EarningRow {
  slotId: string;
  role: string;
  venueName: string;
  venueTz: string;
  startAt: Date;
  endAt: Date;
  approvedHours: number;
  rateCents: number;
  workerPayCents: number;
  status: EarningStatus;
  /** The worker's own payout reference (PayPal payout batch id), once a payout was sent. */
  reference: string | null;
}

export interface EarningTotal {
  totalCents: number;
  paidCents: number;
  onTheWayCents: number;
}

const STATUS: Partial<Record<PaymentState, EarningStatus>> = {
  AUTHORIZED: 'approved',
  CAPTURED: 'approved',
  CAPTURE_DECLINED: 'approved',
  PAYOUT_PENDING: 'paying',
  PAID: 'paid',
  PAYOUT_FAILED: 'failed',
  PAYOUT_UNCLAIMED: 'failed',
  RETURNED: 'failed',
};

const MAX_ROWS = 100;

export async function workerEarnings(h: DbLike, workerId: string, now: Date) {
  const rows = await h
    .select({
      slotId: shiftSlots.id,
      role: shiftSlots.role,
      startAt: shiftSlots.startAt,
      endAt: shiftSlots.endAt,
      approvedHours: shiftSlots.approvedHours,
      rateCents: shiftSlots.offeredRateCents,
      venueName: venues.name,
      venueTz: venues.timezone,
      attempt: payments.attempt,
      status: payments.status,
      workerPayCents: payments.workerPayCents,
      payoutBatchId: payments.payoutBatchId,
    })
    .from(shiftSlots)
    .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
    .innerJoin(payments, eq(payments.slotId, shiftSlots.id))
    .where(and(eq(shiftSlots.workerId, workerId), isNotNull(shiftSlots.approvedHours)))
    .orderBy(desc(shiftSlots.endAt));

  // Latest payment attempt per shift.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = latest.get(r.slotId);
    if (!cur || r.attempt > cur.attempt) latest.set(r.slotId, r);
  }
  const items: EarningRow[] = [];
  for (const r of latest.values()) {
    const status = STATUS[r.status];
    if (!status || r.rateCents === null || r.workerPayCents <= 0) continue;
    items.push({
      slotId: r.slotId,
      role: r.role,
      venueName: r.venueName,
      venueTz: r.venueTz,
      startAt: r.startAt,
      endAt: r.endAt,
      approvedHours: Number(r.approvedHours),
      rateCents: r.rateCents,
      workerPayCents: r.workerPayCents,
      status,
      reference: status === 'approved' ? null : r.payoutBatchId,
    });
  }
  items.sort((a, b) => b.endAt.getTime() - a.endAt.getTime());

  // Weekly (Monday-based) and monthly totals by the shift's end, in the venue's zone, against the SERVER clock.
  // A failed payout is not counted: that money has not reached the worker and is shown on its own row.
  const total = (inPeriod: (r: EarningRow) => boolean): EarningTotal => {
    let paid = 0;
    let way = 0;
    for (const r of items) {
      if (!inPeriod(r) || r.status === 'failed') continue;
      if (r.status === 'paid') paid += r.workerPayCents;
      else way += r.workerPayCents;
    }
    return { totalCents: paid + way, paidCents: paid, onTheWayCents: way };
  };
  const monthKey = (d: Date, tz: string) => {
    const p = localParts(d, tz);
    return `${p.year}-${p.month}`;
  };
  const week = total((r) => localWeekKey(r.endAt, r.venueTz) === localWeekKey(now, r.venueTz));
  const month = total((r) => monthKey(r.endAt, r.venueTz) === monthKey(now, r.venueTz));
  const failedCents = items
    .filter((r) => r.status === 'failed')
    .reduce((n, r) => n + r.workerPayCents, 0);

  return { week, month, failedCents, items: items.slice(0, MAX_ROWS) };
}
