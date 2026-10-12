import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OFFER_STATUS_PUBLIC,
  OFFER_VIEW_STATE,
  OfferDto,
  ParseResultDto,
  PAYMENT_STATUS_PUBLIC,
  PaymentDto,
  RosterResponse,
  SLOT_STATUS_PUBLIC,
  SlotDto,
  WaveSummaryDto,
  WorkerOfferDto,
} from '../src/api/dto';

/**
 * Locks the public API to PLAN.md Section 10.6. The field lists are READ FROM PLAN.md, so editing the
 * plan without the DTOs (or vice versa) fails this test. Anything extra must be in DEVIATIONS below and in
 * docs/api-m1.md "Deviations".
 */
const plan = readFileSync('PLAN.md', 'utf8');
const section = plan.slice(plan.indexOf('### 10.6'), plan.indexOf('## 11.'));
const bullet = (name: string) => {
  const line = section.split('\n').find((l) => l.startsWith(`- **${name}:**`));
  if (!line) throw new Error(`10.6 bullet not found: ${name}`);
  return line;
};
/** Backticked tokens of a bullet, reduced to their leading identifier ("worker {id, name}" -> "worker"). */
const fields = (line: string) =>
  [...new Set([...line.matchAll(/`([a-z_]+)(?: \{[^`]*\})?`/g)].map((m) => m[1]!))].sort();
const parenList = (line: string, after: string) => {
  const m = new RegExp(`\`${after}\` \\(([^)]*)\\)`).exec(line);
  if (!m) throw new Error(`no list after ${after}`);
  return m[1]!.split(',').map((x) => x.trim());
};
const keys = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape).sort();

/** Fields beyond 10.6, each documented in docs/api-m1.md "Deviations". */
const DEVIATIONS = {
  slot: [
    'cancelled_at',
    'cancelled_by',
    'gap_reason',
    'replaces_worker',
    'search_radius_mi',
    'venue_tz',
  ],
  offer: ['declined_at', 'expired_at', 'withdrawn_at'],
  wave: ['declined_count', 'expired_count', 'opened_count', 'withdrawn_count'],
  workerOffer: [
    'first_offered_rate_cents',
    'other_open_offers_count',
    'payout_ready',
    'server_time',
    'venue_address',
    'venue_lat',
    'venue_lng',
    'venue_tz',
    'wave',
  ],
  parse: [
    'base_rate_source',
    'called_out_name',
    'end_at',
    'gap_reason',
    'missing',
    'replaces_slot_id',
    'start_at',
  ],
  roster: ['date', 'server_time', 'timezone'],
  states: ['claimed', 'declined'],
};
const extrasOf = (all: string[], listed: string[]) => all.filter((k) => !listed.includes(k));

describe('Section 10.6 is the source of truth', () => {
  it('Slot: every listed field present; extras are exactly the documented ones', () => {
    const listed = fields(bullet('Slot'));
    expect(listed.every((f) => keys(SlotDto).includes(f))).toBe(true);
    expect(extrasOf(keys(SlotDto), listed)).toEqual(DEVIATIONS.slot);
  });

  it('Slot status values match', () => {
    expect([...SLOT_STATUS_PUBLIC]).toEqual(parenList(bullet('Slot'), 'status'));
  });

  it('Offer fields and statuses match', () => {
    const listed = fields(bullet('Offer'));
    expect(listed.every((f) => keys(OfferDto).includes(f))).toBe(true);
    expect(extrasOf(keys(OfferDto), listed)).toEqual(DEVIATIONS.offer);
    expect([...OFFER_STATUS_PUBLIC]).toEqual(parenList(bullet('Offer'), 'status'));
  });

  it('Wave summary fields match', () => {
    const listed = fields(bullet('Wave summary'));
    expect(listed.every((f) => keys(WaveSummaryDto).includes(f))).toBe(true);
    expect(extrasOf(keys(WaveSummaryDto), listed)).toEqual(DEVIATIONS.wave);
  });

  it('Payment fields and statuses match exactly (no extras)', () => {
    expect(keys(PaymentDto)).toEqual(fields(bullet('Payment')));
    expect([...PAYMENT_STATUS_PUBLIC]).toEqual(parenList(bullet('Payment'), 'status'));
    expect(Object.keys(PaymentDto.shape.paypal_references.shape).sort()).toEqual([
      'authorization',
      'capture',
      'order',
      'payout',
    ]);
  });

  it('Worker-facing offer: listed fields present; extras and extra states are documented', () => {
    const listed = fields(bullet('Worker-facing offer'));
    expect(listed.every((f) => keys(WorkerOfferDto).includes(f))).toBe(true);
    expect(extrasOf(keys(WorkerOfferDto), listed)).toEqual(DEVIATIONS.workerOffer);
    const planStates = parenList(bullet('Worker-facing offer'), 'state');
    expect(OFFER_VIEW_STATE.filter((s) => !planStates.includes(s)).sort()).toEqual(
      DEVIATIONS.states,
    );
    expect(planStates.every((s) => (OFFER_VIEW_STATE as readonly string[]).includes(s))).toBe(true);
  });

  it('Roster: resources/events/summary as listed, plus only the documented extras', () => {
    expect(extrasOf(keys(RosterResponse), ['resources', 'events', 'summary'])).toEqual(
      DEVIATIONS.roster,
    );
    expect(Object.keys(RosterResponse.shape.summary.shape).sort()).toEqual([
      'offering',
      'open_gaps',
      'shifts_today',
    ]);
    expect(bullet('Roster')).toContain('`open_gaps`, `offering`, `shifts_today`');
    const resource = Object.keys(RosterResponse.shape.resources.element.shape);
    for (const f of ['id', 'name', 'role', 'initials']) expect(resource).toContain(f);
  });

  it('Parse result: the listed money fields exist; extras are exactly the documented ones', () => {
    const bulletLine = bullet('Parse result (report a gap)');
    const money = fields(bulletLine).filter((f) => f.endsWith('_cents'));
    expect(money.sort()).toEqual([
      'platform_fee_cents',
      'total_hold_cents',
      'worker_pay_at_cap_cents',
    ]);
    expect(bulletLine).toContain(
      'parsed fields (role, date, start, end, venue, base rate, max premium %)',
    );
    const listedParsed = [
      'source',
      'role',
      'date',
      'start',
      'end',
      'venue',
      'base_rate_cents',
      'max_premium_pct',
      ...money,
    ];
    expect(extrasOf(keys(ParseResultDto), listedParsed)).toEqual(DEVIATIONS.parse);
  });
});

describe('response schemas reject unlisted fields', () => {
  const slot = {
    id: crypto.randomUUID(),
    role: 'line_cook',
    venue_name: 'V',
    venue_area: 'A',
    start_at: '2026-10-14T14:00:00.000Z',
    end_at: '2026-10-14T22:00:00.000Z',
    hours: 8,
    status: 'open',
    worker: null,
    base_rate_cents: 2200,
    max_premium_pct: 20,
    offered_rate_cents: null,
    fill_by: null,
    venue_tz: 'America/Los_Angeles',
    gap_reason: null,
    replaces_worker: null,
    search_radius_mi: 10,
    cancelled_at: null,
    cancelled_by: null,
  };
  it('Slot', () => {
    expect(SlotDto.safeParse(slot).success).toBe(true);
    expect(SlotDto.safeParse({ ...slot, venueName: 'x' }).success).toBe(false);
    expect(SlotDto.safeParse({ ...slot, status: 'OPEN' }).success).toBe(false); // lowercase only
  });
  it('Payment, Wave', () => {
    const pay = {
      status: 'none',
      authorized_cents: 0,
      captured_cents: 0,
      worker_pay_cents: 0,
      platform_fee_cents: 0,
      paypal_references: { order: null, authorization: null, capture: null, payout: null },
      last_error: null,
    };
    expect(PaymentDto.safeParse(pay).success).toBe(true);
    expect(PaymentDto.safeParse({ ...pay, currency: 'USD' }).success).toBe(false);
    const wave = {
      wave: 1,
      sent_at: '2026-10-14T14:00:00.000Z',
      audience_count: 3,
      rate_cents: 2200,
      capped: false,
      opened_count: 0,
      declined_count: 0,
      expired_count: 0,
      withdrawn_count: 0,
    };
    expect(WaveSummaryDto.safeParse(wave).success).toBe(true);
    expect(WaveSummaryDto.safeParse({ ...wave, sent: 3 }).success).toBe(false);
  });
});
