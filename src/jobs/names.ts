/** Section 8 pg-boss job names. */
export const JOB_NAMES = [
  'send_wave',
  'expire_offer',
  'fill_deadline',
  'reconcile_payments',
  'process_webhook',
  'notify',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** Recurring jobs: pg-boss cron (5-field). Reconcile every 3 minutes (Section 7.7: 2 to 5). */
export const SCHEDULES: Partial<Record<JobName, string>> = {
  reconcile_payments: '*/3 * * * *',
};
