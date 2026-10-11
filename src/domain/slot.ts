import { defineMachine } from './machine';
import type { SlotState } from './states';

/** Section 5 slot machine. */
export const slotMachine = defineMachine<SlotState>('shift_slot', {
  PLANNED: ['OPEN', 'CANCELLED'],
  OPEN: ['OFFERING', 'CANCELLED'],
  OFFERING: ['CONFIRMED', 'UNFILLED', 'CANCELLED'],
  // CONFIRMED -> OFFERING: worker cancels after claim.
  CONFIRMED: ['IN_PROGRESS', 'OFFERING', 'NO_SHOW', 'CANCELLED'],
  IN_PROGRESS: ['PENDING_APPROVAL'],
  PENDING_APPROVAL: ['SETTLING'],
  SETTLING: ['SETTLED'],
  SETTLED: [],
  // UNFILLED -> OPEN: manager widens cap or radius and re-approves.
  UNFILLED: ['OPEN', 'CANCELLED'],
  CANCELLED: [],
  // NO_SHOW -> OFFERING: auto re-offer if time remains.
  NO_SHOW: ['OFFERING', 'CANCELLED'],
});

export const transitionSlot = slotMachine.transition;
