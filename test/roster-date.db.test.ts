import { afterAll, describe, expect, it } from 'vitest';
import { shiftSlots } from '../src/db/schema';
import { roster } from '../src/services/read-models';
import { createTestDb, hasTestDb } from './db';
import { makeOrg, makeWorker } from './factories';

// 2026-10-13 03:00 UTC = 2026-10-12 20:00 in Portland (PDT) but already the 13th in UTC and India (08:30).
const now = new Date('2026-10-13T03:00:00Z');

describe.skipIf(!hasTestDb)('roster "today" follows the venue timezone (live Postgres)', () => {
  const t = hasTestDb ? createTestDb() : undefined;
  afterAll(() => t?.close());

  async function setup() {
    const db = t!.db;
    const o = await makeOrg(db);
    const w = await makeWorker(db, o.org.id, { name: 'Maria' });
    const slot = (startUtc: string, endUtc: string) =>
      db.insert(shiftSlots).values({
        venueId: o.venue.id,
        role: 'line_cook',
        startAt: new Date(startUtc),
        endAt: new Date(endUtc),
        workerId: w.id,
        status: 'CONFIRMED',
        baseRateCents: 2200,
        maxPremiumPct: 20,
      });
    await slot('2026-10-12T14:00:00Z', '2026-10-12T22:00:00Z'); // 12th, 07:00-15:00 Portland
    await slot('2026-10-13T14:00:00Z', '2026-10-13T22:00:00Z'); // 13th, 07:00-15:00 Portland
    return o;
  }

  it('defaults to the Portland date, not the UTC or India date', async () => {
    const o = await setup();
    const r = await roster(t!.db, o.org.id, undefined, now);
    expect(r.timezone).toBe('America/Los_Angeles');
    expect(r.date).toBe('2026-10-12');
    expect(r.end_date).toBe('2026-10-12');
    expect(r.server_time).toBe(now.toISOString());
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.start_at).toBe('2026-10-12T14:00:00.000Z');
    expect(r.summary.shifts_today).toBe(1);
  });

  it('the 13th (venue day) holds the 13th shift and counts it', async () => {
    const o = await setup();
    const r = await roster(t!.db, o.org.id, '2026-10-13', now);
    expect(r.date).toBe('2026-10-13');
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.start_at).toBe('2026-10-13T14:00:00.000Z');
    expect(r.events[0]!.venue_tz).toBe('America/Los_Angeles');
    expect(r.summary.shifts_today).toBe(1);
  });

  it('after 07:00 UTC (midnight Portland) the default moves to the 13th', async () => {
    const o = await setup();
    const r = await roster(t!.db, o.org.id, undefined, new Date('2026-10-13T07:00:00Z'));
    expect(r.date).toBe('2026-10-13');
  });
});
