import { eq } from 'drizzle-orm';
import { shiftSlots } from '../db/schema';
import { isShiftRole } from '../domain/roles';
import { createWhyService, type WhyService } from '../llm/why-worker';
import { matchWithFacts } from '../services/candidates';
import type { DbLike } from '../services/types';
import { avatarTint, initialsOf, KM_PER_MILE } from './adapters';
import type { GapDetailResponse } from './dto';

const TOP_N = 5;
const SOURCING = ['OPEN', 'OFFERING', 'UNFILLED'];

/**
 * The top ranked candidates for a gap with one reason each. The order and who is eligible come from the deterministic
 * ranking; the reason is cached model text or the template (src/llm/why-worker.ts). Never blocks on Gemini.
 */
export async function bestMatches(
  h: DbLike,
  why: WhyService | undefined,
  userKey: string,
  slotId: string,
): Promise<GapDetailResponse['best_matches']> {
  const [slot] = await h.select().from(shiftSlots).where(eq(shiftSlots.id, slotId));
  if (!slot || !SOURCING.includes(slot.status) || !isShiftRole(slot.role)) return [];
  const { result, facts } = await matchWithFacts(h, slot);
  const top = result.ranked.slice(0, TOP_N);
  const role = slot.role;
  const whyFacts = top.map((r, i) => {
    const c = facts.get(r.workerId)!;
    return {
      workerId: r.workerId,
      rank: i + 1,
      role,
      skills: c.skills.filter(isShiftRole),
      distanceMi: r.distanceKm === null ? null : r.distanceKm / KM_PER_MILE,
      shiftsHere: c.priorShiftsAtVenue,
      reliability: c.reliability,
      parts: r.parts,
    };
  });
  // Without a service (tests, scripts) the reasons are still the deterministic templates.
  const svc = why ?? createWhyService({});
  const reasons = svc.get(slotId, userKey, whyFacts);
  return top.map((r, i) => ({
    rank: i + 1,
    worker: {
      name: r.name,
      initials: initialsOf(r.name),
      avatar_tint: avatarTint(r.workerId),
      role,
    },
    reason: reasons.get(r.workerId)!.text,
    reason_source: reasons.get(r.workerId)!.source,
  }));
}
