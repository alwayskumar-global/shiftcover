/** Row to insert into audit_log. Every state transition returns one; the caller persists it. */
export interface AuditEntry {
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface TransitionContext {
  entityId: string;
  /** Who caused it: 'user:<id>', 'worker:<id>', 'system:<job>', 'paypal:webhook'. */
  actor: string;
  /** Extra facts to record on the audit row (reason, ids). Never secrets. */
  meta?: Record<string, unknown>;
}

export interface TransitionResult<S extends string> {
  from: S;
  to: S;
  audit: AuditEntry;
}
