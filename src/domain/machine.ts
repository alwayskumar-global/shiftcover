import type { TransitionContext, TransitionResult } from './audit';
import { InvalidTransitionError } from './errors';

export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export interface Machine<S extends string> {
  readonly entity: string;
  canTransition(from: S, to: S): boolean;
  allowedFrom(from: S): readonly S[];
  /** Throws InvalidTransitionError; otherwise returns the new state and the audit row to write. */
  transition(from: S, to: S, ctx: TransitionContext): TransitionResult<S>;
}

export function defineMachine<S extends string>(
  entity: string,
  table: TransitionTable<S>,
): Machine<S> {
  const allowedFrom = (from: S): readonly S[] => table[from] ?? [];
  const canTransition = (from: S, to: S) => allowedFrom(from).includes(to);

  return {
    entity,
    canTransition,
    allowedFrom,
    transition(from, to, ctx) {
      if (!canTransition(from, to)) throw new InvalidTransitionError(entity, from, to);
      return {
        from,
        to,
        audit: {
          actor: ctx.actor,
          action: `${entity}.${from}->${to}`,
          entity,
          entityId: ctx.entityId,
          before: { status: from },
          after: { status: to, ...ctx.meta },
        },
      };
    },
  };
}
