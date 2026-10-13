import { eq } from 'drizzle-orm';
import { users, venues } from '../db/schema';
import type { Tx } from './types';

/** Managers of the org that owns this venue, for notifications. */
export async function managersForVenue(tx: Tx, venueId: string) {
  const [v] = await tx.select({ orgId: venues.orgId }).from(venues).where(eq(venues.id, venueId));
  if (!v) return [];
  return tx.select({ id: users.id }).from(users).where(eq(users.orgId, v.orgId));
}
