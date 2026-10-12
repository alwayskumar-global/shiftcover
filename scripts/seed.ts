/**
 * Demo seed (synthetic data only).  npm run seed | npm run seed:reset
 *
 *   --reset    delete ONLY the demo org's rows (org "Maple & Rye" and everything hanging off it)
 *   --remote   required when DATABASE_URL is not a loopback database (guards against seeding Supabase by accident)
 *
 * SEED_MANAGER_PASSWORD (>= 12 chars) is read from the environment; it is never hardcoded or printed.
 */
import 'dotenv/config';
import { eq, inArray, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createAuth } from '../src/auth';
import { provisionManager } from '../src/auth/provision';
import { getServerEnv } from '../src/config/env';
import { buildPoolConfig } from '../src/db/connection';
import type { Db } from '../src/db/client';
import * as schema from '../src/db/schema';
import {
  auditLog,
  authUser,
  ledgerEntries,
  notifications,
  offers,
  orgs,
  payments,
  pushSubscriptions,
  shiftSlots,
  users,
  venues,
  workerAvailability,
  workerCertifications,
  workers,
} from '../src/db/schema';
import { addDaysToDateString, localDateString, zonedTimeToUtc } from '../src/lib/time';

const ORG_NAME = 'Maple & Rye';
const MANAGER = { name: 'Dana Whitfield', email: 'dana.whitfield@example.com' };
const TZ = 'America/Los_Angeles';
// Synthetic downtown-Portland coordinates for the venue and for worker homes.
const VENUE = { name: 'Maple & Rye', lat: 45.5231, lng: -122.6765, radiusM: 150 };

const args = new Set(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL ?? '';
const loopback = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(databaseUrl).hostname);
  } catch {
    return false;
  }
})();
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
if (!loopback && !args.has('--remote')) {
  console.error('Refusing to seed a non-local database without --remote.');
  process.exit(1);
}

const pool = new Pool(buildPoolConfig(databaseUrl, 'migrate'));
const db = drizzle(pool, { schema }) as unknown as Db;

type W = {
  name: string;
  email: string;
  skills: string[];
  reliability: number;
  acceptance: number;
  response: number;
  home: [number, number];
  certs: Array<{ cert: string; validUntil: string | null }>;
  /** [weekday list, start HH:MM, end HH:MM] windows, venue-local */
  avail: Array<[number[], string, string]>;
};

const ALL = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const yesterday = () => addDaysToDateString(localDateString(new Date(), TZ), -1);

const WORKERS: W[] = [
  {
    name: 'Maria Alvarez',
    email: 'maria.alvarez@example.com',
    skills: ['line_cook', 'prep_cook'],
    reliability: 0.96,
    acceptance: 0.9,
    response: 60,
    home: [45.5202, -122.6742],
    certs: [{ cert: 'food_handler', validUntil: '2027-06-30' }],
    avail: [[ALL, '06:00', '23:00']],
  },
  {
    name: 'Jordan Reyes',
    email: 'jordan.reyes@example.com',
    skills: ['server', 'host'],
    reliability: 0.91,
    acceptance: 0.8,
    response: 120,
    home: [45.5311, -122.6861],
    certs: [],
    avail: [[ALL, '10:00', '23:59']],
  },
  {
    name: 'Marcus Lee',
    email: 'marcus.lee@example.com',
    skills: ['bartender', 'bar_back', 'server', 'line_cook'],
    reliability: 0.88,
    acceptance: 0.75,
    response: 150,
    home: [45.5121, -122.6587],
    certs: [
      { cert: 'alcohol_service', validUntil: '2027-03-01' },
      { cert: 'food_handler', validUntil: '2027-01-15' },
    ],
    avail: [[ALL, '06:00', '23:59']],
  },
  {
    name: 'Chloe Dubois',
    email: 'chloe.dubois@example.com',
    skills: ['server', 'host', 'barista'],
    reliability: 0.93,
    acceptance: 0.85,
    response: 90,
    home: [45.5342, -122.6501],
    certs: [],
    avail: [[ALL, '06:00', '23:00']],
  },
  {
    name: 'Devon Brooks',
    email: 'devon.brooks@example.com',
    skills: ['line_cook', 'prep_cook', 'dishwasher'],
    reliability: 0.84,
    acceptance: 0.7,
    response: 240,
    home: [45.4981, -122.6402],
    certs: [{ cert: 'food_handler', validUntil: '2027-02-10' }],
    avail: [[ALL, '06:00', '23:00']],
  },
  {
    name: 'Aisha Khan',
    email: 'aisha.khan@example.com',
    skills: ['barista', 'server'],
    reliability: 0.9,
    acceptance: 0.82,
    response: 100,
    home: [45.5405, -122.6812],
    certs: [],
    avail: [[ALL, '05:30', '18:00']],
  },
  {
    name: 'Priya Nair',
    email: 'priya.nair@example.com',
    skills: ['line_cook', 'prep_cook'],
    reliability: 0.94,
    acceptance: 0.88,
    response: 75,
    home: [45.5233, -122.6611],
    certs: [{ cert: 'food_handler', validUntil: '2027-08-20' }],
    avail: [[ALL, '06:00', '23:00']],
  },
  {
    name: 'Sam Whitfield',
    email: 'sam.whitfield@example.com',
    skills: ['bar_back', 'bartender', 'event_staff'],
    reliability: 0.79,
    acceptance: 0.65,
    response: 300,
    home: [45.4902, -122.6902],
    certs: [{ cert: 'alcohol_service', validUntil: 'EXPIRED' }],
    avail: [
      [[5, 6, 0], '12:00', '23:59'],
      [[1, 2, 3, 4], '16:00', '23:59'],
    ],
  },
  {
    name: 'Lena Park',
    email: 'lena.park@example.com',
    skills: ['host', 'server', 'event_staff', 'line_cook'],
    reliability: 0.87,
    acceptance: 0.78,
    response: 130,
    home: [45.5112, -122.6712],
    certs: [{ cert: 'food_handler', validUntil: 'EXPIRED' }],
    avail: [[ALL, '08:00', '22:00']],
  },
  {
    name: 'Tom Okafor',
    email: 'tom.okafor@example.com',
    skills: ['dishwasher', 'line_cook', 'event_staff'],
    reliability: 0.82,
    acceptance: 0.72,
    response: 200,
    home: [45.5504, -122.6402],
    certs: [{ cert: 'food_handler', validUntil: '2027-04-05' }],
    avail: [[ALL, '06:00', '23:00']],
  },
];

const mins = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

async function reset() {
  const [org] = await db.select().from(orgs).where(eq(orgs.name, ORG_NAME));
  if (!org) return console.log('nothing to reset');
  await db.transaction(async (tx) => {
    const vs = await tx.select({ id: venues.id }).from(venues).where(eq(venues.orgId, org.id));
    const ws = await tx.select({ id: workers.id }).from(workers).where(eq(workers.orgId, org.id));
    const us = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.orgId, org.id));
    const slotIds = vs.length
      ? (
          await tx
            .select({ id: shiftSlots.id })
            .from(shiftSlots)
            .where(
              inArray(
                shiftSlots.venueId,
                vs.map((v) => v.id),
              ),
            )
        ).map((s) => s.id)
      : [];
    const payIds = slotIds.length
      ? (
          await tx
            .select({ id: payments.id })
            .from(payments)
            .where(inArray(payments.slotId, slotIds))
        ).map((p) => p.id)
      : [];
    const offerIds = slotIds.length
      ? (
          await tx.select({ id: offers.id }).from(offers).where(inArray(offers.slotId, slotIds))
        ).map((o) => o.id)
      : [];

    if (payIds.length) {
      // ledger_entries is append-only by trigger; the demo org's own rows are the one sanctioned delete.
      await tx.execute(
        sql`alter table ledger_entries disable trigger ledger_entries_no_update_delete`,
      );
      await tx.delete(ledgerEntries).where(inArray(ledgerEntries.paymentId, payIds));
      await tx.execute(
        sql`alter table ledger_entries enable trigger ledger_entries_no_update_delete`,
      );
      await tx.delete(payments).where(inArray(payments.id, payIds));
    }
    if (offerIds.length) await tx.delete(offers).where(inArray(offers.id, offerIds));
    if (slotIds.length) {
      await tx
        .update(shiftSlots)
        .set({ replacesSlotId: null })
        .where(inArray(shiftSlots.id, slotIds));
      await tx.delete(shiftSlots).where(inArray(shiftSlots.id, slotIds));
    }
    const entityIds = [
      ...slotIds,
      ...payIds,
      ...offerIds,
      ...ws.map((w) => w.id),
      ...us.map((u) => u.id),
    ];
    if (entityIds.length) await tx.delete(auditLog).where(inArray(auditLog.entityId, entityIds));
    const recipients = [
      ...ws.map((w) => `worker:${w.id}`),
      ...us.map((u) => `manager:${u.id}`),
      ...us.map((u) => `email:${u.email}`),
    ];
    if (recipients.length)
      await tx.delete(notifications).where(inArray(notifications.recipient, recipients));
    if (ws.length) {
      const ids = ws.map((w) => w.id);
      await tx.delete(workerAvailability).where(inArray(workerAvailability.workerId, ids));
      await tx.delete(workerCertifications).where(inArray(workerCertifications.workerId, ids));
      await tx.delete(pushSubscriptions).where(inArray(pushSubscriptions.workerId, ids));
      await tx.delete(workers).where(inArray(workers.id, ids));
    }
    if (vs.length)
      await tx.delete(venues).where(
        inArray(
          venues.id,
          vs.map((v) => v.id),
        ),
      );
    if (us.length) {
      await tx.delete(authUser).where(or(...us.map((u) => eq(authUser.email, u.email)))!); // cascades sessions/accounts
      await tx.delete(users).where(
        inArray(
          users.id,
          us.map((u) => u.id),
        ),
      );
    }
    await tx.delete(orgs).where(eq(orgs.id, org.id));
  });
  console.log('demo org removed');
}

async function seed() {
  const password = process.env.SEED_MANAGER_PASSWORD ?? '';
  if (password.length < 12) {
    console.error('SEED_MANAGER_PASSWORD must be set (at least 12 characters)');
    process.exit(1);
  }
  const env = getServerEnv();
  const [existing] = await db.select().from(orgs).where(eq(orgs.name, ORG_NAME));
  if (existing) {
    console.error(`Demo org already exists. Run: npm run seed:reset`);
    process.exit(1);
  }

  const [org] = await db.insert(orgs).values({ name: ORG_NAME }).returning();
  const [venue] = await db
    .insert(venues)
    .values({ orgId: org!.id, ...VENUE, timezone: TZ })
    .returning();

  const auth = createAuth({
    db,
    secret: env.SESSION_SECRET,
    baseURL: env.APP_BASE_URL,
    production: false,
    rateLimit: false,
  });
  await provisionManager(db, auth, {
    orgId: org!.id,
    email: MANAGER.email,
    name: MANAGER.name,
    password,
  });

  const byName = new Map<string, string>();
  for (const w of WORKERS) {
    const [row] = await db
      .insert(workers)
      .values({
        orgId: org!.id,
        name: w.name,
        email: w.email,
        paypalEmail: null,
        skills: w.skills,
        reliabilityScore: w.reliability,
        acceptanceRate: w.acceptance,
        avgResponseSeconds: w.response,
        homeLat: w.home[0],
        homeLng: w.home[1],
        status: 'active',
      })
      .returning();
    byName.set(w.name, row!.id);
    if (w.certs.length) {
      await db
        .insert(workerCertifications)
        .values(
          w.certs.map((c) => ({
            workerId: row!.id,
            cert: c.cert,
            validUntil: c.validUntil === 'EXPIRED' ? yesterday() : c.validUntil,
          })),
        );
    }
    await db
      .insert(workerAvailability)
      .values(
        w.avail.flatMap(([days, from, to]) =>
          days.map((weekday) => ({
            workerId: row!.id,
            weekday,
            startMinute: mins(from),
            endMinute: mins(to),
          })),
        ),
      );
  }

  // A realistic roster for TODAY (venue-local). Maria's 7:00-3:00 Line cook shift is the one that becomes the gap.
  const today = localDateString(new Date(), TZ);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const at = (day: number, hh: number, mm = 0) => zonedTimeToUtc(y, m, d + day, hh, mm, TZ);
  const roster: Array<[string, string, number, number, number, number, number, number]> = [
    // worker, role, startDay, startH, endDay, endH, base cents, premium %
    ['Maria Alvarez', 'line_cook', 0, 7, 0, 15, 2200, 20],
    ['Aisha Khan', 'barista', 0, 6, 0, 12, 1700, 15],
    ['Jordan Reyes', 'server', 0, 11, 0, 19, 1800, 20],
    ['Lena Park', 'host', 0, 10, 0, 18, 1600, 10],
    ['Chloe Dubois', 'server', 0, 17, 0, 23, 1800, 20],
    ['Sam Whitfield', 'bar_back', 0, 18, 1, 2, 1900, 20],
    // Marcus and Devon work tomorrow so they stay eligible for today's cover (rest rule).
    ['Marcus Lee', 'bartender', 1, 16, 1, 23, 2400, 25],
    ['Devon Brooks', 'dishwasher', 1, 10, 1, 18, 1600, 10],
  ];
  for (const [who, role, sd, sh, ed, eh, base, prem] of roster) {
    await db.insert(shiftSlots).values({
      venueId: venue!.id,
      role,
      startAt: at(sd, sh),
      endAt: at(ed, eh),
      workerId: byName.get(who)!,
      status: 'CONFIRMED',
      baseRateCents: base,
      maxPremiumPct: prem,
      version: 3,
    });
  }
  console.log(
    `seeded org "${ORG_NAME}": 1 manager, ${WORKERS.length} workers, ${roster.length} roster shifts for ${today}`,
  );
  console.log(`manager login: ${MANAGER.email} (password from SEED_MANAGER_PASSWORD)`);
}

(async () => {
  try {
    if (args.has('--reset')) await reset();
    else await seed();
  } finally {
    await pool.end();
  }
})().catch((e: unknown) => {
  console.error('seed failed:', e instanceof Error ? e.message : 'unknown error');
  process.exit(1);
});
