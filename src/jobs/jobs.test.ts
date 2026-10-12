import { describe, expect, it, vi } from 'vitest';
import { handlers, JOB_NAMES, makeDbHeartbeat, processWebhookStub, SCHEDULES } from './index';

describe('jobs', () => {
  it('has a handler for every job name', () => {
    expect([...JOB_NAMES].sort()).toEqual(
      [
        'db_heartbeat',
        'expire_offer',
        'fill_deadline',
        'notify',
        'process_webhook',
        'reconcile_payments',
        'recover_dispatch',
        'send_wave',
      ].sort(),
    );
    for (const n of JOB_NAMES) expect(typeof handlers[n]).toBe('function');
  });

  it('schedules reconciliation every 2 to 5 minutes', () => {
    expect(SCHEDULES.reconcile_payments).toMatch(/^\*\/[2-5] /);
  });

  it('schedules the heartbeat once a day', () => {
    expect(SCHEDULES.db_heartbeat).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});

describe('db_heartbeat', () => {
  it('runs a trivial query', async () => {
    const query = vi.fn(async () => ({}));
    await makeDbHeartbeat(query)({ id: 'j1', data: null });
    expect(query).toHaveBeenCalledExactlyOnceWith('select 1');
  });

  it('propagates database errors so the job fails visibly', async () => {
    const query = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(makeDbHeartbeat(query)({ id: 'j1', data: null })).rejects.toThrow('db down');
  });
});

describe('process_webhook stub', () => {
  it('only logs the event type and id', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await processWebhookStub({
      id: 'j1',
      data: { eventId: 'WH-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', secret: 'nope' },
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[job:process_webhook] type=PAYMENT.CAPTURE.COMPLETED id=WH-1',
    );
    log.mockRestore();
  });
});
