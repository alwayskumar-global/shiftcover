import type { z } from 'zod';
import type { WorkerShiftsResponse } from '@/api/dto';
import { payForMinutesCents } from '@/domain/money';
import { SHIFT_DAY } from '@/config/business';

export type WorkerShift = z.infer<typeof WorkerShiftsResponse>['shifts'][number];
export type Section = 'active' | 'upcoming' | 'past';
export type StepKey = 'arrive' | 'finish' | null;

export interface Badge {
  tone: string;
  icon: string;
  label: string;
}

export interface ShiftView {
  shift: WorkerShift;
  section: Section;
  badge: Badge;
  payLabel: string;
  /** Cents the worker is owed / was paid for this shift. */
  amountCents: number;
  /** Hours the amount is based on. */
  payHours: number;
  formulaSuffix: string;
  note: string;
  step: StepKey;
}

const PAST_DAYS = 14;

const B = {
  confirmed: { tone: 'st-confirmed', icon: 'i-check', label: 'Booked' },
  in_progress: { tone: 'st-progress', icon: 'i-play', label: 'On shift' },
  pending: { tone: 'st-pending', icon: 'i-hourglass', label: 'Waiting for approval' },
  captured: { tone: 'm-captured', icon: 'i-check', label: 'Approved' },
  paying: { tone: 'm-captured', icon: 'i-send', label: 'Paying' },
  paid: { tone: 'm-paid', icon: 'i-wallet', label: 'Paid' },
  cancelled: { tone: 'st-cancelled sc-badge--dashed', icon: 'i-ban', label: 'Cancelled' },
  noshow: { tone: 'st-noshow', icon: 'i-user-x', label: 'No-show' },
} as const satisfies Record<string, Badge>;

const PAY_LABEL: Record<keyof typeof B, string> = {
  confirmed: "You'll earn",
  in_progress: "You'll earn",
  pending: 'Estimated pay',
  captured: 'Approved pay',
  paying: 'Paying you',
  paid: 'Paid to you',
  cancelled: 'No pay due',
  noshow: 'No pay due',
};

const NOTE: Partial<Record<keyof typeof B, string>> = {
  pending: "Your manager is checking your hours. You're paid after they approve.",
  paying: 'Your payout is on its way to your PayPal account.',
  cancelled: 'Maple & Rye cancelled this shift. Nothing is owed and nothing was charged.',
  noshow: 'This shift was marked as a no-show. Nothing is owed.',
};

function key(s: WorkerShift): keyof typeof B {
  switch (s.slot_status) {
    case 'confirmed':
      return 'confirmed';
    case 'in_progress':
      return 'in_progress';
    case 'pending_approval':
      return 'pending';
    case 'cancelled':
      return 'cancelled';
    case 'no_show':
      return 'noshow';
    case 'settled':
      return 'paid';
    case 'settling':
      switch (s.payment_status) {
        case 'captured':
          return 'captured';
        case 'payout_pending':
        case 'payout_failed':
          return 'paying';
        case 'paid':
          return 'paid';
        default:
          return 'pending'; // authorized, capture declined: still waiting on the manager's side
      }
    default:
      return 'confirmed';
  }
}

/** Splits the worker's booked shifts into Active now / Upcoming / Past, judged by the SERVER clock. */
export function buildViews(data: { server_time: string; shifts: WorkerShift[] }): ShiftView[] {
  const now = Date.parse(data.server_time);
  const early = SHIFT_DAY.arriveEarlyMinutes * 60_000;
  const views: ShiftView[] = [];
  for (const s of data.shifts) {
    if (!s.is_mine) continue; // offers that were not claimed are not "my shifts"
    const start = Date.parse(s.start_at);
    const end = Date.parse(s.end_at);
    const k = key(s);
    let section: Section;
    if (s.slot_status === 'in_progress' || s.slot_status === 'pending_approval') section = 'active';
    else if (s.slot_status === 'confirmed') {
      if (now > end) section = 'past';
      else if (now >= start - early) section = 'active';
      else section = 'upcoming';
    } else {
      if (now - end > PAST_DAYS * 86_400_000) continue;
      section = 'past';
    }
    const noPay = k === 'cancelled' || k === 'noshow';
    const payHours = s.approved_hours ?? s.hours;
    const amountCents = noPay
      ? 0
      : s.worker_pay_cents > 0
        ? s.worker_pay_cents
        : payForMinutesCents(s.offered_rate_cents ?? 0, Math.round(payHours * 60));
    let suffix = '';
    if (k === 'pending') suffix = ' · final amount set when approved';
    if (k === 'captured' && s.approved_hours !== null)
      suffix = ` · ${s.approved_hours} of ${s.hours} h approved`;
    const note =
      k === 'confirmed' && section === 'active'
        ? "Tap I've arrived when you're at the door. That starts your shift."
        : k === 'in_progress'
          ? 'Tap Finished when you leave.'
          : k === 'captured' && s.approved_hours !== null
            ? `Your manager approved ${s.approved_hours} of ${s.hours} h. Your payout is being prepared.`
            : (NOTE[k] ?? '');
    views.push({
      shift: s,
      section,
      badge: B[k],
      payLabel: PAY_LABEL[k],
      amountCents,
      payHours,
      formulaSuffix: suffix,
      note,
      step:
        k === 'confirmed' && section === 'active'
          ? 'arrive'
          : k === 'in_progress'
            ? 'finish'
            : null,
    });
  }
  const order: Record<Section, number> = { active: 0, upcoming: 1, past: 2 };
  return views.sort(
    (a, b) =>
      order[a.section] - order[b.section] ||
      (a.section === 'past'
        ? Date.parse(b.shift.start_at) - Date.parse(a.shift.start_at)
        : Date.parse(a.shift.start_at) - Date.parse(b.shift.start_at)),
  );
}
