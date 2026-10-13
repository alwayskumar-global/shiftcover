import { and, asc, desc, eq, gte, inArray, ne } from 'drizzle-orm';
import { ledgerEntries, payments, shiftSlots, venues, workers } from '../db/schema';
import type { PaymentState } from '../domain/states';
import type { ServiceDeps } from './types';

/**
 * The manager's money ledger (G2-M6): one row per payment attempt for this organisation, with the append-only ledger
 * entries behind it for the per-shift breakdown. Every figure comes from the payments and ledger_entries rows.
 */
export type LedgerGroup = 'held' | 'in_progress' | 'paid' | 'failed' | 'voided';
export const LEDGER_GROUPS: readonly LedgerGroup[] = [
  'held',
  'in_progress',
  'paid',
  'failed',
  'voided',
];
export type LedgerRange = '7d' | '30d' | 'all';

const GROUP_STATES: Record<LedgerGroup, PaymentState[]> = {
  held: ['AUTH_PENDING_APPROVAL', 'AUTHORIZED'],
  in_progress: ['CAPTURED', 'PAYOUT_PENDING'],
  paid: ['PAID'],
  failed: ['CAPTURE_DECLINED', 'PAYOUT_FAILED', 'PAYOUT_UNCLAIMED', 'RETURNED'],
  voided: ['VOIDED'],
};

export const groupOf = (s: PaymentState): LedgerGroup =>
  (LEDGER_GROUPS.find((g) => GROUP_STATES[g].includes(s)) ?? 'held') as LedgerGroup;

const MAX_ROWS = 300;
const DAYS: Record<Exclude<LedgerRange, 'all'>, number> = { '7d': 7, '30d': 30 };

export async function listLedger(
  deps: ServiceDeps,
  orgId: string,
  q: { group?: LedgerGroup; range?: LedgerRange },
) {
  const now = deps.now();
  const where = [eq(venues.orgId, orgId), ne(payments.status, 'NONE')];
  if (q.group) where.push(inArray(payments.status, GROUP_STATES[q.group]));
  if (q.range && q.range !== 'all')
    where.push(gte(shiftSlots.startAt, new Date(now.getTime() - DAYS[q.range] * 86_400_000)));
  const rows = await deps.db
    .select({ pay: payments, slot: shiftSlots, venue: venues, worker: workers })
    .from(payments)
    .innerJoin(shiftSlots, eq(shiftSlots.id, payments.slotId))
    .innerJoin(venues, eq(venues.id, shiftSlots.venueId))
    .leftJoin(workers, eq(workers.id, shiftSlots.workerId))
    .where(and(...where))
    .orderBy(desc(shiftSlots.startAt), desc(payments.attempt))
    .limit(MAX_ROWS + 1);
  const truncated = rows.length > MAX_ROWS;
  const page = rows.slice(0, MAX_ROWS);
  const ids = page.map((r) => r.pay.id);
  const entries = ids.length
    ? await deps.db
        .select()
        .from(ledgerEntries)
        .where(inArray(ledgerEntries.paymentId, ids))
        .orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.id))
    : [];
  const byPayment = new Map<string, typeof entries>();
  for (const e of entries) byPayment.set(e.paymentId, [...(byPayment.get(e.paymentId) ?? []), e]);

  const items = page.map(({ pay, slot, venue, worker }) => ({
    paymentId: pay.id,
    slotId: slot.id,
    attempt: pay.attempt,
    role: slot.role,
    workerName: worker?.name ?? null,
    venueTz: venue.timezone,
    startAt: slot.startAt,
    endAt: slot.endAt,
    approvedHours: slot.approvedHours === null ? null : Number(slot.approvedHours),
    status: pay.status,
    group: groupOf(pay.status),
    lastError: pay.lastError,
    authorizedCents: pay.authorizedCents,
    capturedCents: pay.capturedCents,
    workerPayCents: pay.workerPayCents,
    platformFeeCents: pay.platformFeeCents,
    paypalCaptureFeeCents: pay.paypalCaptureFeeCents,
    paypalPayoutFeeCents: pay.paypalPayoutFeeCents,
    /** The part of the hold that was not charged, once a charge happened. */
    releasedCents: pay.capturedCents > 0 ? pay.authorizedCents - pay.capturedCents : null,
    references: {
      order: pay.paypalOrderId,
      authorization: pay.authorizationId,
      capture: pay.captureId,
      payout: pay.payoutBatchId,
    },
    entries: (byPayment.get(pay.id) ?? []).map((e) => ({
      id: e.id,
      type: e.type,
      amountCents: e.amountCents,
      ref: e.ref,
      createdAt: e.createdAt,
    })),
  }));
  const sum = (f: (i: (typeof items)[number]) => number) => items.reduce((n, i) => n + f(i), 0);
  return {
    serverTime: now,
    truncated,
    totals: {
      authorizedCents: sum((i) => i.authorizedCents),
      capturedCents: sum((i) => i.capturedCents),
      workerPayCents: sum((i) => i.workerPayCents),
      platformFeeCents: sum((i) => i.platformFeeCents),
    },
    items,
  };
}
