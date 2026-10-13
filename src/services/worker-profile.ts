import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { auditLog, workerEmailChanges, workers } from '../db/schema';
import { isShiftRole, type ShiftRole } from '../domain/roles';
import type { NotifyChannel } from './notifier';
import { ServiceError, type DbLike, type ServiceDeps } from './types';

/**
 * The worker's own profile (G2-W5): skills, home area, notification choices and the payout email.
 * Every function takes the authenticated worker id; nothing here reads another worker's row.
 */
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
export const HOME_AREA_MAX = 60;

export const NOTIFY_KEYS = ['offers_email', 'offers_push', 'pay_email'] as const;
export type NotifyPrefs = Record<(typeof NOTIFY_KEYS)[number], boolean>;
export const DEFAULT_PREFS: NotifyPrefs = {
  offers_email: true,
  offers_push: true,
  pay_email: true,
};

export function readPrefs(raw: unknown): NotifyPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    offers_email: o.offers_email !== false,
    offers_push: o.offers_push !== false,
    pay_email: o.pay_email !== false,
  };
}

/** The channels a worker wants for a message kind; in-app is always on. Unknown workers get every channel. */
export async function workerChannels(
  h: DbLike,
  workerId: string,
  kind: 'offer' | 'worker_paid',
): Promise<NotifyChannel[]> {
  const [w] = await h
    .select({ prefs: workers.notifyPrefs })
    .from(workers)
    .where(eq(workers.id, workerId));
  const p = readPrefs(w?.prefs);
  const out: NotifyChannel[] = ['in_app'];
  if (kind === 'offer' ? p.offers_email : p.pay_email) out.push('email');
  if (kind === 'offer' ? p.offers_push : true) out.push('push');
  return out;
}

export async function getProfile(h: DbLike, workerId: string) {
  const [w] = await h.select().from(workers).where(eq(workers.id, workerId));
  if (!w) throw new ServiceError('not_found', 'worker not found');
  return {
    id: w.id,
    name: w.name,
    email: w.email,
    paypalEmail: w.paypalEmail,
    skills: w.skills.filter(isShiftRole),
    homeArea: w.homeArea,
    prefs: readPrefs(w.notifyPrefs),
  };
}

export interface ProfilePatch {
  skills?: ShiftRole[];
  homeArea?: string;
  prefs?: Partial<NotifyPrefs>;
}

export async function updateProfile(h: DbLike, workerId: string, patch: ProfilePatch) {
  const cur = await getProfile(h, workerId);
  const set: Partial<typeof workers.$inferInsert> = {};
  if (patch.skills) {
    const skills = [...new Set(patch.skills)];
    if (skills.length === 0) throw new ServiceError('invalid_input', 'pick at least one skill');
    // Keep any non-role skill tags the worker already has; only the role skills are edited here.
    const [row] = await h
      .select({ skills: workers.skills })
      .from(workers)
      .where(eq(workers.id, workerId));
    set.skills = [...(row?.skills ?? []).filter((s) => !isShiftRole(s)), ...skills];
  }
  if (patch.homeArea !== undefined) {
    const area = patch.homeArea.trim();
    if (area.length > HOME_AREA_MAX) throw new ServiceError('invalid_input', 'area is too long');
    set.homeArea = area;
  }
  if (patch.prefs) set.notifyPrefs = { ...cur.prefs, ...patch.prefs };
  if (Object.keys(set).length > 0) await h.update(workers).set(set).where(eq(workers.id, workerId));
  return getProfile(h, workerId);
}

const emailSchema = z.email().max(254);
const hashCode = (code: string, pepper: string) =>
  createHash('sha256').update(`${code}:${pepper}`).digest('hex');
const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2');

/**
 * Step 1 of the payout-email change: validate the new address, store the hash of a fresh 6-digit code and send the
 * code through the notifier (the sandbox Outbox in this phase). The code is never logged and never returned.
 */
export async function startEmailChange(deps: ServiceDeps, workerId: string, newEmailRaw: string) {
  const parsed = emailSchema.safeParse(newEmailRaw.trim().toLowerCase());
  if (!parsed.success) throw new ServiceError('invalid_input', 'enter a valid email address');
  const newEmail = parsed.data;
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const [w] = await tx.select().from(workers).where(eq(workers.id, workerId)).for('update');
    if (!w) throw new ServiceError('not_found', 'worker not found');
    if (w.paypalEmail?.toLowerCase() === newEmail)
      throw new ServiceError('invalid_input', 'that is already your payout email');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
    const row = {
      newEmail,
      codeHash: hashCode(code, deps.config.tokenPepper),
      expiresAt,
      attempts: 0,
      createdAt: now,
    };
    await tx
      .insert(workerEmailChanges)
      .values({ workerId, ...row })
      .onConflictDoUpdate({ target: workerEmailChanges.workerId, set: row });
    await deps.notifier(tx).send({
      recipient: `email:${newEmail}`,
      channels: ['email'],
      kind: 'payout_email_code',
      payload: { workerId, code, expiresAt: expiresAt.toISOString() },
    });
    return { newEmail, expiresInSeconds: Math.floor(CODE_TTL_MS / 1000) };
  });
}

export type VerifyResult =
  | { ok: true; paypalEmail: string }
  | { ok: false; reason: 'none' | 'expired' | 'wrong' | 'locked'; attemptsLeft: number };

/** Step 2: check the code. Five wrong tries lock the request; an expired or missing request must be restarted. */
export async function verifyEmailChange(
  deps: ServiceDeps,
  workerId: string,
  code: string,
): Promise<VerifyResult> {
  const now = deps.now();
  return deps.db.transaction(async (tx): Promise<VerifyResult> => {
    const [c] = await tx
      .select()
      .from(workerEmailChanges)
      .where(eq(workerEmailChanges.workerId, workerId))
      .for('update');
    if (!c) return { ok: false, reason: 'none', attemptsLeft: 0 };
    if (c.expiresAt <= now) {
      await tx.delete(workerEmailChanges).where(eq(workerEmailChanges.workerId, workerId));
      return { ok: false, reason: 'expired', attemptsLeft: 0 };
    }
    if (c.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: 'locked', attemptsLeft: 0 };
    const a = Buffer.from(hashCode(code.trim(), deps.config.tokenPepper));
    const b = Buffer.from(c.codeHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      const attempts = c.attempts + 1;
      await tx
        .update(workerEmailChanges)
        .set({ attempts })
        .where(eq(workerEmailChanges.workerId, workerId));
      return {
        ok: false,
        reason: attempts >= MAX_CODE_ATTEMPTS ? 'locked' : 'wrong',
        attemptsLeft: Math.max(0, MAX_CODE_ATTEMPTS - attempts),
      };
    }
    const [w] = await tx.select().from(workers).where(eq(workers.id, workerId)).for('update');
    await tx.update(workers).set({ paypalEmail: c.newEmail }).where(eq(workers.id, workerId));
    await tx.delete(workerEmailChanges).where(eq(workerEmailChanges.workerId, workerId));
    await tx.insert(auditLog).values({
      actor: `worker:${workerId}`,
      action: 'worker.payout_email_changed',
      entity: 'worker',
      entityId: workerId,
      before: { paypal_email: w?.paypalEmail ? maskEmail(w.paypalEmail) : null },
      after: { paypal_email: maskEmail(c.newEmail) },
    });
    return { ok: true, paypalEmail: c.newEmail };
  });
}
