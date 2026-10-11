import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from './errors';
import { offerMachine, transitionOffer } from './offer';
import { paymentMachine, transitionPayment } from './payment';
import { slotMachine, transitionSlot } from './slot';
import { OFFER_STATES, PAYMENT_STATES, SLOT_STATES } from './states';

const ctx = { entityId: 'e1', actor: 'system:test' };

function walk<S extends string>(
  transition: (from: S, to: S, c: typeof ctx) => { to: S },
  path: S[],
) {
  for (let i = 0; i < path.length - 1; i++) {
    expect(transition(path[i]!, path[i + 1]!, ctx).to).toBe(path[i + 1]);
  }
}

describe('slot machine', () => {
  it('walks the happy path', () => {
    walk(transitionSlot, [
      'PLANNED',
      'OPEN',
      'OFFERING',
      'CONFIRMED',
      'IN_PROGRESS',
      'PENDING_APPROVAL',
      'SETTLING',
      'SETTLED',
    ]);
  });

  it('supports side states and recovery paths', () => {
    expect(slotMachine.canTransition('OFFERING', 'UNFILLED')).toBe(true);
    expect(slotMachine.canTransition('CONFIRMED', 'OFFERING')).toBe(true); // worker cancels
    expect(slotMachine.canTransition('CONFIRMED', 'NO_SHOW')).toBe(true);
    expect(slotMachine.canTransition('NO_SHOW', 'OFFERING')).toBe(true); // re-offer
    expect(slotMachine.canTransition('UNFILLED', 'OPEN')).toBe(true); // widen and re-approve
  });

  it.each([
    ['PLANNED', 'CONFIRMED'],
    ['OPEN', 'SETTLED'],
    ['OFFERING', 'IN_PROGRESS'],
    ['IN_PROGRESS', 'SETTLED'],
    ['PENDING_APPROVAL', 'CONFIRMED'],
    ['SETTLED', 'OPEN'],
    ['CANCELLED', 'OPEN'],
    ['SETTLING', 'PENDING_APPROVAL'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => transitionSlot(from, to, ctx)).toThrow(InvalidTransitionError);
  });

  it('rejects self-transitions and defines every state', () => {
    for (const s of SLOT_STATES) {
      expect(slotMachine.allowedFrom(s)).toBeDefined();
      expect(() => transitionSlot(s, s, ctx)).toThrow(InvalidTransitionError);
    }
  });
});

describe('offer machine', () => {
  it('walks SENT -> OPENED -> CLAIMED', () => {
    walk(transitionOffer, ['SENT', 'OPENED', 'CLAIMED']);
  });

  it('allows expiry, decline, withdrawal', () => {
    for (const to of ['DECLINED', 'EXPIRED', 'WITHDRAWN'] as const) {
      expect(offerMachine.canTransition('OPENED', to)).toBe(true);
      expect(offerMachine.canTransition('SENT', to)).toBe(true);
    }
  });

  it('frees the confirmed offer when the worker cancels after claiming', () => {
    expect(offerMachine.canTransition('CLAIMED', 'WITHDRAWN')).toBe(true);
  });

  it('cannot claim without opening, and terminal states are final', () => {
    expect(() => transitionOffer('SENT', 'CLAIMED', ctx)).toThrow(InvalidTransitionError);
    for (const s of ['DECLINED', 'EXPIRED', 'WITHDRAWN'] as const) {
      for (const to of OFFER_STATES) {
        expect(() => transitionOffer(s, to, ctx)).toThrow(InvalidTransitionError);
      }
    }
    expect(() => transitionOffer('CLAIMED', 'EXPIRED', ctx)).toThrow(InvalidTransitionError);
  });
});

describe('payment machine', () => {
  it('walks the happy path', () => {
    walk(transitionPayment, [
      'NONE',
      'AUTH_PENDING_APPROVAL',
      'AUTHORIZED',
      'CAPTURED',
      'PAYOUT_PENDING',
      'PAID',
    ]);
  });

  it('handles void, declined capture, and payout failure paths', () => {
    expect(paymentMachine.canTransition('AUTHORIZED', 'VOIDED')).toBe(true);
    expect(paymentMachine.canTransition('AUTHORIZED', 'CAPTURE_DECLINED')).toBe(true);
    expect(paymentMachine.canTransition('CAPTURE_DECLINED', 'CAPTURED')).toBe(true);
    expect(paymentMachine.canTransition('PAYOUT_PENDING', 'PAYOUT_FAILED')).toBe(true);
    expect(paymentMachine.canTransition('PAYOUT_FAILED', 'PAYOUT_PENDING')).toBe(true); // retry
    expect(paymentMachine.canTransition('PAYOUT_PENDING', 'PAYOUT_UNCLAIMED')).toBe(true);
    expect(paymentMachine.canTransition('PAYOUT_UNCLAIMED', 'RETURNED')).toBe(true);
  });

  it.each([
    ['NONE', 'AUTHORIZED'],
    ['AUTHORIZED', 'PAYOUT_PENDING'],
    ['AUTHORIZED', 'PAID'],
    ['CAPTURED', 'VOIDED'],
    ['CAPTURED', 'PAID'],
    ['VOIDED', 'AUTHORIZED'],
    ['PAID', 'PAYOUT_PENDING'],
    ['RETURNED', 'PAID'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => transitionPayment(from, to, ctx)).toThrow(InvalidTransitionError);
  });

  it('defines every state', () => {
    for (const s of PAYMENT_STATES) expect(paymentMachine.allowedFrom(s)).toBeDefined();
  });
});

describe('audit entries', () => {
  it('returns an audit row for each valid transition', () => {
    const r = transitionSlot('OFFERING', 'CONFIRMED', {
      entityId: 'slot-1',
      actor: 'worker:w1',
      meta: { offerId: 'o1' },
    });
    expect(r.audit).toEqual({
      actor: 'worker:w1',
      action: 'shift_slot.OFFERING->CONFIRMED',
      entity: 'shift_slot',
      entityId: 'slot-1',
      before: { status: 'OFFERING' },
      after: { status: 'CONFIRMED', offerId: 'o1' },
    });
  });

  it('does not return audit data for a rejected transition', () => {
    expect(() => transitionPayment('NONE', 'PAID', ctx)).toThrow(/NONE -> PAID/);
  });
});
