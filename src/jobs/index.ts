import { PgBoss } from 'pg-boss';
import { getPool } from '../db/client';
import { buildPoolConfig } from '../db/connection';
import { JOB_NAMES, SCHEDULES, type JobName } from './names';

export { JOB_NAMES, SCHEDULES } from './names';
export type { JobName } from './names';

/**
 * Job handlers. M0 ships stubs only: they log the job name and id, never payloads.
 * Real handlers arrive with M1 (waves, expiry, deadline), M2 (webhook, reconcile), M3 (notify).
 * Rule (Section 9.3): no LLM calls inside webhook handlers or per-item loops.
 */
export type JobHandler = (job: { id: string; data: unknown }) => Promise<void>;

const stub =
  (name: JobName): JobHandler =>
  async (job) => {
    console.log(`[job:${name}] stub handler id=${job.id}`);
  };

type Query = (sql: string) => Promise<unknown>;

/** Cheapest possible activity on the database. Throws on failure so pg-boss records and retries it. */
export function makeDbHeartbeat(query: Query): JobHandler {
  return async () => {
    await query('select 1');
    console.log('[job:db_heartbeat] ok');
  };
}

/** Stub (no business logic yet): logs only the event type and id. */
export const processWebhookStub: JobHandler = async (job) => {
  const d = (job.data ?? {}) as { eventId?: string; eventType?: string };
  console.log(
    `[job:process_webhook] type=${d.eventType ?? 'unknown'} id=${d.eventId ?? 'unknown'}`,
  );
};

export const handlers: Record<JobName, JobHandler> = {
  send_wave: stub('send_wave'),
  expire_offer: stub('expire_offer'),
  fill_deadline: stub('fill_deadline'),
  reconcile_payments: stub('reconcile_payments'),
  process_webhook: processWebhookStub,
  notify: stub('notify'),
  db_heartbeat: makeDbHeartbeat((sql) => getPool().query(sql)),
};

/** Worker-side pg-boss: same Supabase session-pooler URL, small pool (see src/db/connection.ts budget). */
export function createBoss(databaseUrl: string): PgBoss {
  const { connectionString, max, ssl } = buildPoolConfig(databaseUrl, 'boss');
  const boss = new PgBoss({ connectionString, max, ssl });
  boss.on('error', (err: Error) => console.error('[pg-boss] error:', err.message));
  return boss;
}

/** Starts pg-boss, creates queues, schedules recurring jobs, registers handlers. */
export async function startJobs(
  boss: PgBoss,
  overrides: Partial<Record<JobName, JobHandler>> = {},
): Promise<void> {
  await boss.start();
  const active = { ...handlers, ...overrides };
  for (const name of JOB_NAMES) {
    await boss.createQueue(name);
    await boss.work(name, async (jobs) => {
      for (const job of jobs) await active[name]({ id: job.id, data: job.data });
    });
  }
  for (const [name, cron] of Object.entries(SCHEDULES)) {
    await boss.schedule(name, cron);
  }
}

/** Enqueue helper for web/worker code. */
export async function enqueue(
  boss: PgBoss,
  name: JobName,
  data: object,
  options?: { singletonKey?: string; startAfter?: number },
): Promise<string | null> {
  return boss.send(name, data, options);
}
