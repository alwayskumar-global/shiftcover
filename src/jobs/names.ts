/** Section 8 pg-boss job names. */
export const JOB_NAMES = [
  'send_wave',
  'expire_offer',
  'fill_deadline',
  'reconcile_payments',
  'process_webhook',
  'notify',
  // Daily trivial query so a free Supabase project is not paused for inactivity (PLAN.md 6A).
  'db_heartbeat',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** Recurring jobs: pg-boss cron (5-field). Reconcile every 3 minutes (Section 7.7: 2 to 5). */
export const SCHEDULES: Partial<Record<JobName, string>> = {
  reconcile_payments: '*/3 * * * *',
  db_heartbeat: '0 6 * * *', // daily, 06:00 UTC
};
