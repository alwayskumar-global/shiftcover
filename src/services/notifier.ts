import { notifications } from '../db/schema';
import type { DbLike } from './types';

export type NotifyChannel = 'in_app' | 'email' | 'push';

export interface NotifyMessage {
  /** e.g. "worker:<id>", "manager:<userId>", "email:<address>". */
  recipient: string;
  channels: readonly NotifyChannel[];
  /** Machine-readable kind: offer, claim_won, claim_manager, gap_unfilled, sign_in_link, ... */
  kind: string;
  /** Rendered later by UI/email templates. Amounts are injected by code, never generated. */
  payload: Record<string, unknown>;
}

/** Notification seam (PLAN.md A5). M1 only has the Outbox; real email/push providers plug in later. */
export interface Notifier {
  send(message: NotifyMessage): Promise<void>;
}

/** Writes one row per channel to `notifications` (status pending). No real sending yet. */
export class OutboxNotifier implements Notifier {
  constructor(private readonly handle: DbLike) {}

  async send(message: NotifyMessage): Promise<void> {
    if (message.channels.length === 0) return;
    await this.handle.insert(notifications).values(
      message.channels.map((channel) => ({
        recipient: message.recipient,
        channel,
        payload: { kind: message.kind, ...message.payload },
        status: 'pending' as const,
      })),
    );
  }
}

export const outboxNotifier = (h: DbLike): Notifier => new OutboxNotifier(h);
