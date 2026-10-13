import { desc, eq, inArray } from 'drizzle-orm';
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
  return rows
    .map((r) => {
      const p = (r.payload ?? {}) as { kind?: unknown; link?: unknown };
      return {
        id: r.id,
        channel: r.channel,
        kind: typeof p.kind === 'string' ? p.kind : 'unknown',
        recipient: r.recipient,
        recipientLabel: labels.get(r.recipient) ?? r.recipient,
        createdAt: r.createdAt,
        status: r.status,
        link: typeof p.link === 'string' ? p.link : null,
      };
    })
    .filter((i) => i.kind !== 'sign_in_link')
    .slice(0, limit);
}
