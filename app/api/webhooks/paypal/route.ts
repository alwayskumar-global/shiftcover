import { getServerEnv, requirePaypalEnv } from '@/config/env';
import { getDb } from '@/db/client';
import { paypalEvents } from '@/db/schema';
import { enqueueFromWeb } from '@/jobs/send-only';
import { createPaypalClient } from '@/paypal/client';
import { verifyWebhookSignature } from '@/paypal/webhooks';
import { handlePaypalWebhook, type WebhookDeps } from '@/webhooks/handle';

export const dynamic = 'force-dynamic';

function buildDeps(headers: Headers): WebhookDeps {
  const log = (m: string) => console.error(m);
  let verify: WebhookDeps['verify'];
  try {
    const env = requirePaypalEnv(getServerEnv());
    if (env.PAYPAL_WEBHOOK_ID) {
      const client = createPaypalClient({
        clientId: env.PAYPAL_CLIENT_ID,
        clientSecret: env.PAYPAL_CLIENT_SECRET,
        baseUrl: env.PAYPAL_API_BASE,
      });
      const webhookId = env.PAYPAL_WEBHOOK_ID;
      verify = ({ rawBody }) => verifyWebhookSignature(client, { headers, rawBody, webhookId });
    }
  } catch {
    // Config problem: handler answers 503 and logs; the response never names variables.
    verify = undefined;
  }
  return {
    verify,
    log,
    insertEvent: async ({ eventId, eventType, raw }) => {
      const rows = await getDb()
        .insert(paypalEvents)
        .values({ eventId, eventType, rawJson: raw, verified: true })
        .onConflictDoNothing({ target: paypalEvents.eventId })
        .returning({ id: paypalEvents.id });
      return rows.length > 0;
    },
    enqueue: async ({ eventId, eventType }) => {
      await enqueueFromWeb('process_webhook', { eventId, eventType }, { singletonKey: eventId });
    },
  };
}

export async function POST(request: Request) {
  const rawBody = await request.text(); // raw bytes as text: required for signature verification
  const result = await handlePaypalWebhook(buildDeps(request.headers), rawBody);
  return Response.json(result.body, { status: result.status });
}
