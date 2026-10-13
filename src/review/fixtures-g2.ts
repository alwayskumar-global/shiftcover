import type { ApprovalsDto, WorkerShiftsDto } from '@/features/client-api';
import { maxApprovableHours } from '@/domain/money';

/** G2 review fixtures (worker My shifts, manager Approvals). API-shaped data; nothing in the product imports this file. */

const TZ = 'America/Los_Angeles';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** 6:55 AM Pacific on Mon 12 Oct 2026. */
export const G2_NOW = '2026-10-12T13:55:00.000Z';
const at = (hhmm: string, day = '12') => `2026-10-${day}T${hhmm}:00.000Z`;

export type ShiftStep = 'notArrived' | 'onShift' | 'finished';

type S = WorkerShiftsDto['shifts'][number];
const base = (n: number, over: Partial<S>): S => ({
  offer_id: U(500 + n),
  offer_status: 'claimed',
  rate_cents: 2200,
  expires_at: at('14:00'),
  slot_id: U(600 + n),
  slot_status: 'confirmed',
  role: 'line_cook',
  start_at: at('14:00'),
  end_at: at('22:00'),
  venue_name: 'Maple & Rye',
  is_mine: true,
  venue_area: 'Portland, OR',
  venue_tz: TZ,
  venue_address: '1021 NW Everett St, Portland, OR 97209',
  manager_name: 'Dana Whitfield',
  hours: 8,
  offered_rate_cents: 2200,
  check_in_at: null,
  check_out_at: null,
  approved_hours: null,
  payment_status: 'authorized',
  worker_pay_cents: 0,
  ...over,
});

export function workerShifts(step: ShiftStep = 'notArrived'): WorkerShiftsDto {
  const active: Partial<S> =
    step === 'notArrived'
      ? { slot_status: 'confirmed' }
      : step === 'onShift'
        ? { slot_status: 'in_progress', check_in_at: at('13:58') }
        : { slot_status: 'pending_approval', check_in_at: at('13:58'), check_out_at: at('22:02') };
  return {
    server_time: G2_NOW,
    shifts: [
      base(1, { ...active, offered_rate_cents: 2420, rate_cents: 2420 }),
      base(2, { start_at: at('14:00', '16'), end_at: at('22:00', '16') }),
      base(3, { start_at: at('23:00', '17'), end_at: at('05:00', '18'), hours: 6 }),
      base(4, {
        slot_status: 'settling',
        payment_status: 'payout_pending',
        start_at: at('14:00', '10'),
        end_at: at('22:00', '10'),
        approved_hours: 8,
        worker_pay_cents: 17600,
      }),
      base(5, {
        slot_status: 'settling',
        payment_status: 'captured',
        start_at: at('14:00', '09'),
        end_at: at('22:00', '09'),
        approved_hours: 7.5,
        worker_pay_cents: 16500,
      }),
      base(6, {
        slot_status: 'settled',
        payment_status: 'paid',
        start_at: at('14:00', '08'),
        end_at: at('22:00', '08'),
        approved_hours: 8,
        worker_pay_cents: 17600,
      }),
      base(7, {
        slot_status: 'cancelled',
        payment_status: 'voided',
        start_at: at('23:00', '05'),
        end_at: at('05:00', '06'),
        hours: 6,
      }),
      // an offer that was not claimed: never shown on My shifts
      base(8, { is_mine: false, slot_status: 'confirmed', offer_status: 'withdrawn' }),
    ],
  };
}
export const WORKER_SHIFTS_EMPTY: WorkerShiftsDto = { server_time: G2_NOW, shifts: [] };

type A = ApprovalsDto['items'][number];
const FEE_BPS = 500;
const approval = (n: number, over: Partial<A> & Pick<A, 'rate_cents' | 'authorized_cents'>): A => ({
  slot_id: U(700 + n),
  slot_status: 'pending_approval',
  worker: { name: 'Jordan Reyes', initials: 'JR', avatar_tint: 3 },
  role: 'line_cook',
  venue_tz: TZ,
  start_at: at('14:00'),
  end_at: at('22:00'),
  scheduled_hours: 8,
  check_in_at: at('13:58'),
  check_out_at: at('22:02'),
  actual_hours: 8.07,
  approved_hours: null,
  max_hours: maxApprovableHours({
    rateCents: over.rate_cents,
    authorizedCents: over.authorized_cents,
    feeBps: FEE_BPS,
  }),
  payment_status: 'authorized',
  last_error: null,
  capture_reference: null,
  ...over,
});

export function approvals(over: { fixedFeeCents?: number; declined?: boolean } = {}): ApprovalsDto {
  const fixed = over.fixedFeeCents ?? 0;
  return {
    server_time: '2026-10-12T22:10:00.000Z',
    fee_bps: FEE_BPS,
    fixed_fee_cents: fixed,
    items: [
      approval(
        1,
        over.declined
          ? {
              rate_cents: 2420,
              authorized_cents: 22176,
              slot_status: 'settling',
              payment_status: 'capture_declined',
              approved_hours: 8,
              capture_reference: '2GH65173LA904418C',
            }
          : { rate_cents: 2420, authorized_cents: 22176 },
      ),
      approval(2, {
        rate_cents: 1500,
        authorized_cents: 2835,
        worker: { name: 'Sam Whitfield', initials: 'SW', avatar_tint: 2 },
        role: 'bar_back',
        start_at: at('12:00'),
        end_at: at('13:30'),
        scheduled_hours: 1.5,
        check_in_at: at('12:02'),
        check_out_at: at('13:31'),
        actual_hours: 1.48,
      }),
      approval(3, {
        rate_cents: 1600,
        authorized_cents: 11088,
        worker: { name: 'Aisha Khan', initials: 'AK', avatar_tint: 4 },
        role: 'server',
        start_at: at('17:00'),
        end_at: at('23:00'),
        scheduled_hours: 6,
        check_in_at: at('17:00'),
        check_out_at: at('23:15'),
        actual_hours: 6.25,
      }),
    ],
  };
}
