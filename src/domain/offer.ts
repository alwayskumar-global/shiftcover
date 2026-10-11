import { defineMachine } from './machine';
import type { OfferState } from './states';

/**
 * Section 5 offer machine. A claim needs the offer to be OPENED first (a GET marks it opened
 * without consuming the token). CLAIMED -> WITHDRAWN frees the slot's single confirmed offer
 * when the worker cancels after claiming.
 */
export const offerMachine = defineMachine<OfferState>('offer', {
  SENT: ['OPENED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'],
  OPENED: ['CLAIMED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'],
  CLAIMED: ['WITHDRAWN'],
  DECLINED: [],
  EXPIRED: [],
  WITHDRAWN: [],
});

export const transitionOffer = offerMachine.transition;
