import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { auditLog, venues, workerAvailability, workerCertifications, workers } from '../db/schema';
import { isShiftRole, type ShiftRole } from '../domain/roles';
import { addDaysToDateString, localDateString } from '../lib/time';
import { avatarTint, initialsOf } from '../api/adapters';
import { ServiceError, type ServiceDeps } from './types';

/**
 * The manager's worker directory (G2-M7): who is on the team, with skills, certifications and expiry, a plain-words
 * availability summary and the reliability score; plus invite-by-email. Everything is scoped to the manager's org.
 */
export type CertState = 'valid' | 'expiring' | 'expired' | 'no_expiry';
export type Tier = 'reliable' | 'good' | 'review';
export const CERT_WARN_DAYS = 30;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
// Monday first, as a week reads for a manager.
const ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const clock = (min: number) => {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h24 < 12 || min === 1440 ? 'AM' : 'PM'}`;
};

/** "Mon–Fri 6 AM–2 PM", "Any time", "Not set". Days with the same window are grouped; runs of days are collapsed. */
export function availabilitySummary(
  windows: Array<{ weekday: number; startMinute: number; endMinute: number }>,
): string {
  if (windows.length === 0) return 'Not set';
  const byWindow = new Map<string, number[]>();
  for (const w of windows) {
    const k = `${w.startMinute}-${w.endMinute}`;
    byWindow.set(k, [...(byWindow.get(k) ?? []), w.weekday]);
  }
  const parts: string[] = [];
  for (const [k, days] of byWindow) {
    const [s, e] = k.split('-').map(Number) as [number, number];
    const ordered = ORDER.filter((d) => days.includes(d));
    const runs: number[][] = [];
    for (const d of ordered) {
      const last = runs.at(-1);
      if (
        last &&
        ORDER.indexOf(d as (typeof ORDER)[number]) ===
          ORDER.indexOf(last.at(-1) as (typeof ORDER)[number]) + 1
      )
        last.push(d);
      else runs.push([d]);
    }
    const dayText =
      ordered.length === 7
        ? 'Every day'
        : runs
            .map((r) =>
              r.length >= 3
                ? `${DAY_NAMES[r[0]!]}–${DAY_NAMES[r.at(-1)!]}`
                : r.map((d) => DAY_NAMES[d]).join(', '),
            )
            .join(', ');
    parts.push(
      s === 0 && e === 1440 ? `${dayText}, any time` : `${dayText} ${clock(s)}–${clock(e)}`,
    );
  }
  return parts.join(' · ');
}

export const tierOf = (score: number): Tier => {
  const pct = Math.round(score * 100);
  return pct >= 90 ? 'reliable' : pct >= 75 ? 'good' : 'review';
};

export async function listWorkers(deps: ServiceDeps, orgId: string) {
  const ws = await deps.db
    .select()
    .from(workers)
    .where(eq(workers.orgId, orgId))
    .orderBy(asc(workers.name));
  const ids = ws.map((w) => w.id);
  const [certs, avail, [venue]] = await Promise.all([
    ids.length
      ? deps.db
          .select()
          .from(workerCertifications)
          .where(inArray(workerCertifications.workerId, ids))
      : [],
    ids.length
      ? deps.db.select().from(workerAvailability).where(inArray(workerAvailability.workerId, ids))
      : [],
    deps.db.select({ tz: venues.timezone }).from(venues).where(eq(venues.orgId, orgId)).limit(1),
  ]);
  // "Today" for expiry is the date at the venue, judged by the server clock.
  const today = localDateString(deps.now(), venue?.tz ?? 'America/Los_Angeles');
  const warnUntil = addDaysToDateString(today, CERT_WARN_DAYS);
  const daysBetween = (a: string, b: string) =>
    Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

  let expiring = 0;
  const items = ws.map((w) => {
    const cs = certs
      .filter((c) => c.workerId === w.id)
      .sort((a, b) => a.cert.localeCompare(b.cert))
      .map((c) => {
        let state: CertState = 'no_expiry';
        let daysLeft: number | null = null;
        if (c.validUntil) {
          daysLeft = daysBetween(today, c.validUntil);
          state =
            c.validUntil < today ? 'expired' : c.validUntil <= warnUntil ? 'expiring' : 'valid';
        }
        return { cert: c.cert, validUntil: c.validUntil, state, daysLeft };
      });
    if (cs.some((c) => c.state === 'expired' || c.state === 'expiring')) expiring++;
    return {
      id: w.id,
      name: w.name,
      initials: initialsOf(w.name),
      tint: avatarTint(w.id),
      email: w.email,
      status: w.status,
      skills: w.skills.filter((s): s is ShiftRole => isShiftRole(s)),
      certs: cs,
      availability: availabilitySummary(avail.filter((a) => a.workerId === w.id)),
      reliabilityPct: Math.round(w.reliabilityScore * 100),
      tier: tierOf(w.reliabilityScore),
    };
  });
  return {
    summary: {
      total: items.length,
      active: items.filter((i) => i.status === 'active').length,
      invited: items.filter((i) => i.status === 'invited').length,
      certsNeedingAttention: expiring,
    },
    items,
  };
}

const emailSchema = z.email().max(254);
const nameFromEmail = (email: string) =>
  email
    .split('@')[0]!
    .split(/[._+\-]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(' ')
    .slice(0, 60) || 'New worker';

export type InviteResult =
  | { kind: 'sent'; workerId: string; email: string }
  | { kind: 'exists'; status: 'invited' | 'active' | 'inactive'; name: string; email: string };

/**
 * Invite a worker by email: a worker record in 'invited' status, and an email through the notifier (the sandbox Outbox
 * in this phase). An address already on the team returns 'exists' and sends nothing.
 */
export async function inviteWorker(
  deps: ServiceDeps,
  ctx: { orgId: string; userId: string },
  rawEmail: string,
): Promise<InviteResult> {
  const parsed = emailSchema.safeParse(rawEmail.trim().toLowerCase());
  if (!parsed.success) throw new ServiceError('invalid_input', 'enter a valid email address');
  const email = parsed.data;
  return deps.db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(workers)
      .where(and(eq(workers.orgId, ctx.orgId), eq(workers.email, email)));
    if (existing)
      return { kind: 'exists', status: existing.status, name: existing.name, email } as const;
    const [created] = await tx
      .insert(workers)
      .values({
        orgId: ctx.orgId,
        name: nameFromEmail(email),
        email,
        status: 'invited',
        skills: [],
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      // lost a race with a concurrent invite of the same address
      return { kind: 'exists', status: 'invited', name: nameFromEmail(email), email } as const;
    }
    await deps.notifier(tx).send({
      recipient: `email:${email}`,
      channels: ['email'],
      kind: 'worker_invite',
      payload: { workerId: created.id },
    });
    await tx.insert(auditLog).values({
      actor: `user:${ctx.userId}`,
      action: 'worker.invited',
      entity: 'worker',
      entityId: created.id,
      after: { status: 'invited' },
    });
    return { kind: 'sent', workerId: created.id, email } as const;
  });
}
