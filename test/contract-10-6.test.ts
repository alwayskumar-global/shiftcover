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
 * plan without the DTOs (or vice versa) fails this test. Anything extra must be in DEVIATIONS and in
 * docs/api-m1.md.
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
  [...line.matchAll(/`([a-z_]+)(?: \{[^`]*\})?`/g)].map((m) => m[1]!);
const parenList = (line: string, after: string) => {
  const m = new RegExp(`\`${after}\` \\(([^)]*)\\)`).exec(line);
  if (!m) throw new Error(`no list after ${after}`);
  return m[1]!.split(',').map((x) => x.trim());
};
const keys = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape).sort();

/** Fields beyond 10.6, each documented in docs/api-m1.md "Deviations". */
const DEVIATIONS = {
  parse: ['missing', 'replaces_slot_id', 'called_out_name', 'start_at', 'end_at'],
  roster: ['date', 'timezone'],
} as const;

describe('Section 10.6 is the source of truth', () => {
  it('Slot fields match exactly', () => {
    expect(keys(SlotDto)).toEqual([...new Set(fields(bullet('Slot')))].sort());
  });

  it('Slot status values match', () => {
    expect([...SLOT_STATUS_PUBLIC]).toEqual(parenList(bullet('Slot'), 'status'));
  });

  it('Offer fields and statuses match', () => {
    expect(keys(OfferDto)).toEqual([...new Set(fields(bullet('Offer')))].sort());
    expect([...OFFER_STATUS_PUBLIC]).toEqual(parenList(bullet('Offer'), 'status'));
  });

  it('Wave summary fields match', () => {
    expect(keys(WaveSummaryDto)).toEqual([...new Set(fields(bullet('Wave summary')))].sort());
  });

  it('Payment fields and statuses match', () => {
    expect(keys(PaymentDto)).toEqual([...new Set(fields(bullet('Payment')))].sort());
    expect([...PAYMENT_STATUS_PUBLIC]).toEqual(parenList(bullet('Payment'), 'status'));
    expect(Object.keys(PaymentDto.shape.paypal_references.shape).sort()).toEqual([
      'authorization',
      'capture',
      'order',
      'payout',
    ]);
  });

  it('Worker-facing offer: every listed field is present; `claimed` is the single documented extra state', () => {
    const listed = [...new Set(fields(bullet('Worker-facing offer')))];
    expect(keys(WorkerOfferDto)).toEqual([...listed].sort());
    const planStates = parenList(bullet('Worker-facing offer'), 'state');
    expect(OFFER_VIEW_STATE.filter((s) => !planStates.includes(s))).toEqual(['claimed']);
    expect(planStates.every((s) => (OFFER_VIEW_STATE as readonly string[]).includes(s))).toBe(true);
  });

  it('Roster: resources/events/summary as listed, plus only the documented extras', () => {
    expect(keys(RosterResponse)).toEqual(['date', 'events', 'resources', 'summary', 'timezone']);
    expect(['date', 'timezone']).toEqual([...DEVIATIONS.roster]);
    expect(Object.keys(RosterResponse.shape.summary.shape).sort()).toEqual([
      'offering',
      'open_gaps',
      'shifts_today',
    ]);
    expect(Object.keys(RosterResponse.shape.resources.element.shape).sort()).toEqual([
      'id',
      'initials',
      'name',
      'role',
    ]);
    expect(bullet('Roster')).toContain('`open_gaps`, `offering`, `shifts_today`');
  });

  it('Parse result: the listed money fields exist; extras are exactly the documented ones', () => {
    const money = fields(bullet('Parse result (report a gap)')).filter((f) => f.endsWith('_cents'));
    expect(money).toEqual(['worker_pay_at_cap_cents', 'platform_fee_cents', 'total_hold_cents']);
    // Section 10.6 lists these in prose: "parsed fields (role, date, start, end, venue, base rate, max premium %)".
    expect(bullet('Parse result (report a gap)')).toContain(
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
    const extras = keys(ParseResultDto).filter((k) => !listedParsed.includes(k));
    expect(extras).toEqual([...DEVIATIONS.parse].sort());
  });
});

describe('response schemas reject unlisted fields', () => {
  const ok = {
    slot: {
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
    },
  };
  it('Slot', () => {
    expect(SlotDto.safeParse(ok.slot).success).toBe(true);
    expect(SlotDto.safeParse({ ...ok.slot, venueName: 'x' }).success).toBe(false);
    expect(SlotDto.safeParse({ ...ok.slot, status: 'OPEN' }).success).toBe(false); // lowercase only
  });
  it('Payment, Wave, Offer, WorkerOffer', () => {
    expect(
      PaymentDto.safeParse({
        status: 'none',
        authorized_cents: 0,
        captured_cents: 0,
        worker_pay_cents: 0,
        platform_fee_cents: 0,
        paypal_references: { order: null, authorization: null, capture: null, payout: null },
        last_error: null,
        currency: 'USD',
      }).success,
    ).toBe(false);
    expect(
      WaveSummaryDto.safeParse({
        wave: 1,
        sent_at: '2026-10-14T14:00:00.000Z',
        audience_count: 3,
        rate_cents: 2200,
        capped: false,
        sent: 3,
      }).success,
    ).toBe(false);
    expect(
      WorkerOfferDto.safeParse({
        state: 'invalid',
        role: null,
        venue_name: null,
        venue_area: null,
        start_at: null,
        end_at: null,
        hours: null,
        distance_mi: null,
        rate_cents: null,
        pay_total_cents: null,
        expires_at: null,
        wave: 1,
      }).success,
    ).toBe(false);
  });
});
