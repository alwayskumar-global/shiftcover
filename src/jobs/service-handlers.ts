import { z } from 'zod';
import { expireOffer, fillDeadline, recoverDispatch, sendWave } from '../services/offers';
import { reconcilePayments } from '../services/payments';
import { processPaypalEvent, reenqueueStaleEvents } from '../services/paypal-events';
import type { ServiceDeps } from '../services/types';
import type { JobHandler } from './index';
import type { JobName } from './names';

const waveJob = z.object({
  slotId: z.uuid(),
  wave: z.number().int().min(1).max(3),
  reoffer: z.boolean().optional(),
});
const offerJob = z.object({ offerId: z.uuid() });
const slotJob = z.object({ slotId: z.uuid() });
const webhookJob = z.object({ eventId: z.string().min(1), eventType: z.string().optional() });

/**
 * M1 job handlers. Payloads are validated; the services are idempotent and safe to re-run, so a
 * pg-boss retry or duplicate delivery changes nothing. Logs carry job name and counts only.
 */
export function serviceHandlers(deps: ServiceDeps): Partial<Record<JobName, JobHandler>> {
  return {
    send_wave: async (job) => {
      const r = await sendWave(deps, waveJob.parse(job.data));
      console.log(`[job:send_wave] id=${job.id} sent=${r.sent} reason=${r.reason}`);
    },
    expire_offer: async (job) => {
      const expired = await expireOffer(deps, offerJob.parse(job.data));
      console.log(`[job:expire_offer] id=${job.id} expired=${expired}`);
    },
    recover_dispatch: async (job) => {
      const r = await recoverDispatch(deps);
      if (r.slots > 0)
        console.log(`[job:recover_dispatch] id=${job.id} slots=${r.slots} enqueued=${r.enqueued}`);
    },
    process_webhook: async (job) => {
      const { eventId } = webhookJob.parse(job.data);
      const outcome = await processPaypalEvent(deps, eventId);
      console.log(`[job:process_webhook] id=${job.id} event=${eventId} outcome=${outcome}`);
    },
    reconcile_payments: async (job) => {
      // (a) events stored but never processed, then (b) payments that PayPal has moved on without telling us
      const events = await reenqueueStaleEvents(deps);
      const r = await reconcilePayments(deps);
      console.log(
        `[job:reconcile_payments] id=${job.id} requeued=${events} checked=${r.checked} advanced=${r.advanced}`,
      );
    },
    fill_deadline: async (job) => {
      const unfilled = await fillDeadline(deps, slotJob.parse(job.data));
      console.log(`[job:fill_deadline] id=${job.id} unfilled=${unfilled}`);
    },
  };
}
