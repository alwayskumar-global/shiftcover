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
import { localDateString } from '../src/lib/time';
import {
  DEMO_ROSTER,
  DEMO_WORKERS,
  hhmmToMinutes,
  MANAGER,
  ORG_NAME,
  resolveValidUntil,
  rosterInstants,
  TZ,
  VENUE,
} from './lib/demo-data';

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
  const today = localDateString(new Date(), TZ);
  for (const w of DEMO_WORKERS) {
    const [row] = await db
      .insert(workers)
      .values({
        orgId: org!.id,
        name: w.name,
        email: w.email,
        paypalEmail: w.email, // synthetic; real sandbox payout accounts come with M2
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
      await db.insert(workerCertifications).values(
        w.certs.map((c) => ({
          workerId: row!.id,
          cert: c.cert,
          validUntil: resolveValidUntil(c.validUntil, today),
        })),
      );
    }
    await db.insert(workerAvailability).values(
      w.avail.flatMap(([days, from, to]) =>
        days.map((weekday) => ({
          workerId: row!.id,
          weekday,
          startMinute: hhmmToMinutes(from),
          endMinute: hhmmToMinutes(to),
        })),
      ),
    );
  }

  // A realistic roster for TODAY (venue-local). Maria's 7:00-3:00 Line cook shift is the one that becomes the gap.
  for (const spec of DEMO_ROSTER) {
    const { startAt, endAt } = rosterInstants(today, spec);
    await db.insert(shiftSlots).values({
      venueId: venue!.id,
      role: spec[1],
      startAt,
      endAt,
      workerId: byName.get(spec[0])!,
      status: 'CONFIRMED',
      baseRateCents: spec[6],
      maxPremiumPct: spec[7],
      version: 3,
    });
  }
  console.log(
    `seeded org "${ORG_NAME}": 1 manager, ${DEMO_WORKERS.length} workers, ${DEMO_ROSTER.length} roster shifts for ${today}`,
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
