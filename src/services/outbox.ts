import { desc, eq, inArray, sql } from 'drizzle-orm';
import { notifications, users, workers } from '../db/schema';
import type { DbLike } from './types';

export interface OutboxItem {
  id: string;
  channel: string;
  kind: string;
  recipient: string;
  recipientLabel: string;
  createdAt: Date;
  status: string;
  /** The offer link carried by the notification, when it has one. Never logged. */
  link: string | null;
  /** The 6-digit payout-email code, for kind payout_email_code only (sandbox testing aid). Never logged. */
  code: string | null;
}

/**
 * Recent notifications addressed to this organisation's workers and managers (sandbox testing aid: the demo Outbox
 * stands in for real email/push). Sign-in links are excluded: they are credentials, not shift offers.
 */
export async function listOutbox(h: DbLike, orgId: string, limit = 50): Promise<OutboxItem[]> {
  const ws = await h
    .select({ id: workers.id, name: workers.name })
    .from(workers)
    .where(eq(workers.orgId, orgId));
  const us = await h
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.orgId, orgId));
  const labels = new Map<string, string>([
    ...ws.map((w) => [`worker:${w.id}`, w.name] as const),
    ...us.flatMap((u) => [
      [`manager:${u.id}`, u.email] as const,
      [`email:${u.email}`, u.email] as const,
    ]),
  ]);
  if (labels.size === 0) return [];
  const rows = await h
    .select()
    .from(notifications)
    .where(inArray(notifications.recipient, [...labels.keys()]))
    .orderBy(desc(notifications.createdAt))
    .limit(limit * 2);
  // Payout-email codes and worker invites go to an address that is not a known recipient: match them by worker.
  const codes = ws.length
    ? await h
        .select()
        .from(notifications)
        .where(
          sql`${notifications.recipient} like 'email:%' and ${notifications.payload}->>'kind' in ('payout_email_code', 'worker_invite') and ${notifications.payload}->>'workerId' in (${sql.join(
            ws.map((w) => sql`${w.id}`),
            sql`, `,
          )})`,
        )
        .orderBy(desc(notifications.createdAt))
        .limit(limit)
    : [];
  for (const c of codes) {
    const wid = (c.payload as { workerId?: string }).workerId;
    labels.set(
      c.recipient,
      `${ws.find((w) => w.id === wid)?.name ?? 'Worker'} · ${c.recipient.slice(6)}`,
    );
  }
  return [...rows, ...codes]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((r) => {
      const p = (r.payload ?? {}) as { kind?: unknown; link?: unknown; code?: unknown };
      return {
        id: r.id,
        channel: r.channel,
        kind: typeof p.kind === 'string' ? p.kind : 'unknown',
        recipient: r.recipient,
        recipientLabel: labels.get(r.recipient) ?? r.recipient,
        createdAt: r.createdAt,
        status: r.status,
        link: typeof p.link === 'string' ? p.link : null,
        code: p.kind === 'payout_email_code' && typeof p.code === 'string' ? p.code : null,
      };
    })
    .filter((i) => i.kind !== 'sign_in_link')
    .slice(0, limit);
}
