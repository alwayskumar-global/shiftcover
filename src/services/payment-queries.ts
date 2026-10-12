import { desc, eq } from 'drizzle-orm';
import { payments } from '../db/schema';
import type { DbLike } from './types';

/** A slot can have several payment attempts (a voided hold is replaced after a re-open); the latest one is current. */
export async function latestPayment(h: DbLike, slotId: string) {
  const [p] = await h
    .select()
    .from(payments)
    .where(eq(payments.slotId, slotId))
    .orderBy(desc(payments.attempt))
    .limit(1);
  return p;
}
