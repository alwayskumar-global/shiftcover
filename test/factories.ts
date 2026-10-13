import { randomUUID } from 'node:crypto';
import type { Db } from '../src/db/client';
import {
  orgs,
  users,
  venues,
  workerAvailability,
  workerCertifications,
  workers,
} from '../src/db/schema';
import type { ServiceDeps } from '../src/services/types';
import { outboxNotifier } from '../src/services/notifier';

export const PEPPER = 'test-pepper-0123456789abcdef0123456789abcdef';

export interface RecordedJob {
  name: string;
  data: Record<string, unknown>;
  options?: { singletonKey?: string; startAfter?: number };
}

export function testDeps(db: Db, over: Partial<ServiceDeps['config']> & { now?: () => Date } = {}) {
  const jobs: RecordedJob[] = [];
  const deps: ServiceDeps = {
    db,
    notifier: outboxNotifier,
    enqueue: async (name, data, options) => {
      jobs.push({ name, data: data as Record<string, unknown>, options });
    },
    now: over.now ?? (() => new Date()),
    config: {
      appBaseUrl: 'https://app.example.test',
      tokenPepper: PEPPER,
      offerTtlSeconds: 900,
      waveIntervalSeconds: 300,
      platformFeeBps: 500,
      ...over,
    },
  };
  return { deps, jobs };
}

export async function makeOrg(db: Db) {
  const [org] = await db
    .insert(orgs)
    .values({ name: `Test Org ${randomUUID()}` })
    .returning();
  const [venue] = await db
    .insert(venues)
    .values({
      orgId: org!.id,
      name: 'Test Venue',
      lat: 45.5231,
      lng: -122.6765,
      radiusM: 150,
      timezone: 'America/Los_Angeles',
    })
    .returning();
  const [manager] = await db
    .insert(users)
    .values({ orgId: org!.id, email: `mgr-${randomUUID()}@example.com`, role: 'manager' })
    .returning();
  return { org: org!, venue: venue!, manager: manager! };
}

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 0,
  endMinute: 1440,
}));

export async function makeWorker(
  db: Db,
  orgId: string,
  over: Partial<{
    name: string;
    skills: string[];
    reliability: number;
    acceptance: number;
    avgResponse: number;
    lat: number;
    lng: number;
    status: 'invited' | 'active' | 'inactive';
    certs: Array<{ cert: string; validUntil: string | null }>;
    availability: Array<{ weekday: number; startMinute: number; endMinute: number }>;
  }> = {},
) {
  const email = `w-${randomUUID()}@example.com`;
  const [w] = await db
    .insert(workers)
    .values({
      orgId,
      name: over.name ?? `Worker ${randomUUID().slice(0, 6)}`,
      email: email,
      paypalEmail: email,
      skills: over.skills ?? ['line_cook'],
      reliabilityScore: over.reliability ?? 0.8,
      acceptanceRate: over.acceptance ?? 0.7,
      avgResponseSeconds: over.avgResponse ?? 200,
      homeLat: over.lat ?? 45.53,
      homeLng: over.lng ?? -122.68,
      status: over.status ?? 'active',
    })
    .returning();
  const certs = over.certs ?? [{ cert: 'food_handler', validUntil: '2030-01-01' }];
  if (certs.length) {
    await db.insert(workerCertifications).values(certs.map((c) => ({ workerId: w!.id, ...c })));
  }
  const av = over.availability ?? ALL_DAY;
  if (av.length)
    await db.insert(workerAvailability).values(av.map((a) => ({ workerId: w!.id, ...a })));
  return w!;
}
