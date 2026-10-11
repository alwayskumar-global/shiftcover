import { describe, expect, it } from 'vitest';
import { handlers, JOB_NAMES, SCHEDULES } from './index';

describe('jobs', () => {
  it('has a handler for every Section 8 job name', () => {
    expect([...JOB_NAMES].sort()).toEqual(
      ['expire_offer', 'fill_deadline', 'notify', 'process_webhook', 'reconcile_payments', 'send_wave'].sort(),
    );
    for (const n of JOB_NAMES) expect(typeof handlers[n]).toBe('function');
  });

  it('schedules reconciliation every 2 to 5 minutes', () => {
    expect(SCHEDULES.reconcile_payments).toMatch(/^\*\/[2-5] /);
  });
});
