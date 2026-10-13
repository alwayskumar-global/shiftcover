import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { offers, shiftSlots, workers } from '../db/schema';
import { generateToken, hashToken } from '../lib/tokens';
import { offerLink } from './offers';
import type { ServiceDeps } from './types';

/**
 * "Email me a new link" (W1 invalid link). The caller always answers identically, whether or not the address
 * is known. For a known worker with a still-open offer on an offering slot, the offer's token is rotated (the
 * old link stops working), its expiry is renewed, and the new link goes through the Notifier. Nothing else
 * changes, and nothing is revealed to the requester.
 */
export async function resendOfferLink(
  deps: ServiceDeps,
  rawEmail: string,
): Promise<{ sent: boolean }> {
  const email = rawEmail.trim().toLowerCase();
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const ws = await tx
      .select({ id: workers.id })
      .from(workers)
      .where(and(eq(workers.email, email), ne(workers.status, 'inactive')));
    if (ws.length === 0) return { sent: false };
    const [row] = await tx
      .select({ offer: offers, slot: shiftSlots })
      .from(offers)
      .innerJoin(shiftSlots, eq(shiftSlots.id, offers.slotId))
      .where(
        and(
          inArray(
            offers.workerId,
            ws.map((w) => w.id),
          ),
          inArray(offers.status, ['SENT', 'OPENED']),
          eq(shiftSlots.status, 'OFFERING'),
        ),
      )
      .orderBy(desc(offers.createdAt))
      .limit(1)
      .for('update', { of: offers });
    if (!row) return { sent: false };

    const token = generateToken();
    const expiresAt = new Date(now.getTime() + deps.config.offerTtlSeconds * 1000);
    await tx
      .update(offers)
      .set({ tokenHash: hashToken(token, deps.config.tokenPepper), expiresAt })
      .where(eq(offers.id, row.offer.id));
    await deps.notifier(tx).send({
      recipient: `worker:${row.offer.workerId}`,
      channels: ['email'],
      kind: 'offer_link_resent',
      payload: {
        offerId: row.offer.id,
        slotId: row.slot.id,
        rateCents: row.offer.rateCents,
        expiresAt: expiresAt.toISOString(),
        link: offerLink(deps.config.appBaseUrl, token),
      },
    });
    return { sent: true };
  });
}
