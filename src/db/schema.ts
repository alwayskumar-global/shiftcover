import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { SHIFT_ROLES } from '../domain/roles';
import { OFFER_STATES, PAYMENT_STATES, SLOT_STATES } from '../domain/states';

/**
 * Section 6 data model. Money is integer cents plus currency = 'USD'. Never floats.
 * State changes go through src/domain transition functions, never ad-hoc updates.
 */

export const slotStatus = pgEnum('slot_status', SLOT_STATES);
export const offerStatus = pgEnum('offer_status', OFFER_STATES);
export const paymentStatus = pgEnum('payment_status', PAYMENT_STATES);
export const userRole = pgEnum('user_role', ['manager']);
export const workerStatus = pgEnum('worker_status', ['invited', 'active', 'inactive']);
export const ledgerEntryType = pgEnum('ledger_entry_type', [
  'AUTHORIZED',
  'CAPTURED',
  'VOIDED',
  'PAYOUT_SENT',
  'PAID',
  'PAYOUT_FAILED',
  'RETURNED',
  'PLATFORM_FEE',
  'PAYPAL_CAPTURE_FEE',
  'PAYPAL_PAYOUT_FEE',
]);
export const notificationChannel = pgEnum('notification_channel', ['in_app', 'email', 'push']);
export const notificationStatus = pgEnum('notification_status', ['pending', 'sent', 'failed']);

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const orgs = pgTable('orgs', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    email: text('email').notNull(),
    role: userRole('role').notNull().default('manager'),
    // Auth is out of scope for M0; nullable placeholders for the chosen auth library.
    authProvider: text('auth_provider'),
    authSubject: text('auth_subject'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    index('users_org_idx').on(t.orgId),
    uniqueIndex('users_auth_uq')
      .on(t.authProvider, t.authSubject)
      .where(sql`${t.authSubject} is not null`),
  ],
);

export const venues = pgTable(
  'venues',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    radiusM: integer('radius_m').notNull().default(150),
    /** IANA zone; availability windows and "today" are evaluated in venue local time. */
    timezone: text('timezone').notNull().default('America/Los_Angeles'),
    createdAt: createdAt(),
  },
  (t) => [index('venues_org_idx').on(t.orgId), check('venues_radius_ck', sql`${t.radiusM} > 0`)],
);

export const workers = pgTable(
  'workers',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    email: text('email').notNull(),
    paypalEmail: text('paypal_email'),
    skills: text('skills')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    certs: text('certs')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    homeLat: doublePrecision('home_lat'),
    homeLng: doublePrecision('home_lng'),
    /** 0..1 */
    reliabilityScore: doublePrecision('reliability_score').notNull().default(0.5),
    /** 0..1, share of offers claimed. Feeds ranking. */
    acceptanceRate: doublePrecision('acceptance_rate').notNull().default(0.5),
    /** Mean seconds from offer sent to opened. Feeds ranking. */
    avgResponseSeconds: integer('avg_response_seconds').notNull().default(300),
    status: workerStatus('status').notNull().default('invited'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('workers_org_email_uq').on(t.orgId, t.email),
    index('workers_org_status_idx').on(t.orgId, t.status),
    check('workers_reliability_ck', sql`${t.reliabilityScore} between 0 and 1`),
    check('workers_acceptance_ck', sql`${t.acceptanceRate} between 0 and 1`),
  ],
);

export const shiftSlots = pgTable(
  'shift_slots',
  {
    id: id(),
    venueId: uuid('venue_id')
      .notNull()
      .references(() => venues.id),
    role: text('role').notNull(),
    startAt: ts('start_at').notNull(),
    endAt: ts('end_at').notNull(),
    workerId: uuid('worker_id').references(() => workers.id),
    status: slotStatus('status').notNull().default('PLANNED'),
    baseRateCents: integer('base_rate_cents').notNull(),
    /** Whole percent, 0..100. */
    maxPremiumPct: integer('max_premium_pct').notNull().default(0),
    offeredRateCents: integer('offered_rate_cents'),
    /** The shift this gap replaces (a worker called in sick); that worker is never offered the cover. */
    replacesSlotId: uuid('replaces_slot_id'),
    /** Defaults to start_at minus 30 min when the gap is posted. */
    fillBy: ts('fill_by'),
    /** Optimistic-lock counter; incremented on every state change. */
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('slots_venue_start_idx').on(t.venueId, t.startAt),
    index('slots_status_idx').on(t.status),
    index('slots_worker_start_idx').on(t.workerId, t.startAt),
    check('slots_time_ck', sql`${t.endAt} > ${t.startAt}`),
    check('slots_role_ck', sql.raw(`role in (${SHIFT_ROLES.map((r) => `'${r}'`).join(', ')})`)),
    check('slots_rate_ck', sql`${t.baseRateCents} >= 0`),
    check('slots_premium_ck', sql`${t.maxPremiumPct} between 0 and 100`),
    check(
      'slots_offered_rate_ck',
      sql`${t.offeredRateCents} is null or ${t.offeredRateCents} >= 0`,
    ),
  ],
);

export const offers = pgTable(
  'offers',
  {
    id: id(),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => shiftSlots.id),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id),
    wave: smallint('wave').notNull(),
    rateCents: integer('rate_cents').notNull(),
    /** sha256(token + CLAIM_TOKEN_PEPPER); the raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    status: offerStatus('status').notNull().default('SENT'),
    openedAt: ts('opened_at'),
    claimedAt: ts('claimed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('offers_token_hash_uq').on(t.tokenHash),
    uniqueIndex('offers_slot_worker_wave_uq').on(t.slotId, t.workerId, t.wave),
    // Integrity rule: a slot has at most one confirmed (claimed) offer.
    uniqueIndex('offers_one_claimed_per_slot_uq')
      .on(t.slotId)
      .where(sql`${t.status} = 'CLAIMED'`),
    index('offers_slot_status_idx').on(t.slotId, t.status),
    index('offers_worker_status_idx').on(t.workerId, t.status),
    index('offers_expires_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} in ('SENT', 'OPENED')`),
    check('offers_wave_ck', sql`${t.wave} between 1 and 3`),
    check('offers_rate_ck', sql`${t.rateCents} >= 0`),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => shiftSlots.id),
    /** Re-approval after a void creates a new attempt; invoice_id = slot_id-attempt. */
    attempt: integer('attempt').notNull().default(1),
    currency: text('currency').notNull().default('USD'),
    paypalOrderId: text('paypal_order_id'),
    authorizationId: text('authorization_id'),
    captureId: text('capture_id'),
    payoutBatchId: text('payout_batch_id'),
    payoutItemId: text('payout_item_id'),
    senderBatchId: text('sender_batch_id'),
    authorizedCents: integer('authorized_cents').notNull().default(0),
    capturedCents: integer('captured_cents').notNull().default(0),
    workerPayCents: integer('worker_pay_cents').notNull().default(0),
    platformFeeCents: integer('platform_fee_cents').notNull().default(0),
    status: paymentStatus('status').notNull().default('NONE'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payments_slot_attempt_uq').on(t.slotId, t.attempt),
    uniqueIndex('payments_order_uq')
      .on(t.paypalOrderId)
      .where(sql`${t.paypalOrderId} is not null`),
    uniqueIndex('payments_auth_uq')
      .on(t.authorizationId)
      .where(sql`${t.authorizationId} is not null`),
    uniqueIndex('payments_capture_uq')
      .on(t.captureId)
      .where(sql`${t.captureId} is not null`),
    uniqueIndex('payments_sender_batch_uq')
      .on(t.senderBatchId)
      .where(sql`${t.senderBatchId} is not null`),
    index('payments_status_idx').on(t.status),
    check('payments_currency_ck', sql`${t.currency} = 'USD'`),
    check(
      'payments_cents_ck',
      sql`${t.authorizedCents} >= 0 and ${t.capturedCents} >= 0 and ${t.workerPayCents} >= 0 and ${t.platformFeeCents} >= 0`,
    ),
    // Server-side guard: capture can never exceed the authorization.
    check('payments_capture_le_auth_ck', sql`${t.capturedCents} <= ${t.authorizedCents}`),
  ],
);

/** Append-only (UPDATE/DELETE blocked by trigger, see custom migration). */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: id(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    type: ledgerEntryType('type').notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    ref: text('ref'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_payment_idx').on(t.paymentId, t.createdAt),
    check('ledger_currency_ck', sql`${t.currency} = 'USD'`),
  ],
);

export const paypalEvents = pgTable(
  'paypal_events',
  {
    id: id(),
    /** PayPal's event id; unique so a replayed webhook is processed once. */
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    rawJson: jsonb('raw_json').notNull(),
    verified: boolean('verified').notNull().default(false),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: ts('processed_at'),
  },
  (t) => [
    uniqueIndex('paypal_events_event_id_uq').on(t.eventId),
    index('paypal_events_unprocessed_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    recipient: text('recipient').notNull(),
    channel: notificationChannel('channel').notNull(),
    payload: jsonb('payload').notNull(),
    status: notificationStatus('status').notNull().default('pending'),
    createdAt: createdAt(),
    sentAt: ts('sent_at'),
  },
  (t) => [
    index('notifications_recipient_idx').on(t.recipient, t.createdAt),
    index('notifications_status_idx').on(t.status),
  ],
);

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: id(),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id),
    endpoint: text('endpoint').notNull(),
    keys: jsonb('keys').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('push_endpoint_uq').on(t.endpoint), index('push_worker_idx').on(t.workerId)],
);

/**
 * Spend guard (Section 9.3). One row per (hour, user, component, model); the daily cap sums by `day`,
 * the per-user hourly cap sums by (`hourStart`, `userKey`). `userKey` is '' for system calls.
 */
export const llmUsage = pgTable(
  'llm_usage',
  {
    id: id(),
    day: date('day', { mode: 'string' }).notNull(),
    hourStart: timestamp('hour_start', { withTimezone: true }).notNull(),
    userKey: text('user_key').notNull().default(''),
    component: text('component').notNull(),
    model: text('model').notNull(),
    calls: integer('calls').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
  },
  (t) => [
    uniqueIndex('llm_usage_bucket_uq').on(t.hourStart, t.userKey, t.component, t.model),
    index('llm_usage_day_idx').on(t.day),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_entity_idx').on(t.entity, t.entityId, t.at)],
);

/** Weekly availability windows in venue-local time. weekday 0 = Sunday. Minutes since local midnight. */
export const workerAvailability = pgTable(
  'worker_availability',
  {
    id: id(),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id),
    weekday: smallint('weekday').notNull(),
    startMinute: integer('start_minute').notNull(),
    endMinute: integer('end_minute').notNull(),
  },
  (t) => [
    uniqueIndex('worker_availability_uq').on(t.workerId, t.weekday, t.startMinute),
    index('worker_availability_worker_idx').on(t.workerId),
    check('worker_availability_weekday_ck', sql`${t.weekday} between 0 and 6`),
    check(
      'worker_availability_minutes_ck',
      sql`${t.startMinute} >= 0 and ${t.endMinute} <= 1440 and ${t.endMinute} > ${t.startMinute}`,
    ),
  ],
);

/** Certifications with validity. validUntil null = does not expire. */
export const workerCertifications = pgTable(
  'worker_certifications',
  {
    id: id(),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id),
    cert: text('cert').notNull(),
    validUntil: date('valid_until', { mode: 'string' }),
  },
  (t) => [
    uniqueIndex('worker_certifications_uq').on(t.workerId, t.cert),
    index('worker_certifications_worker_idx').on(t.workerId),
  ],
);

/**
 * Better Auth tables (manager sign-in only). Field names follow Better Auth's core schema for
 * email+password and the magic-link plugin. Linked to our `users` row via users.auth_subject = auth_user.id.
 */
export const authUser = pgTable('auth_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
});

export const authSession = pgTable(
  'auth_session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    userId: text('userId')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
  },
  (t) => [index('auth_session_user_idx').on(t.userId)],
);

export const authAccount = pgTable(
  'auth_account',
  {
    id: text('id').primaryKey(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: text('userId')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: timestamp('accessTokenExpiresAt', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_account_user_idx').on(t.userId)],
);

export const authVerification = pgTable(
  'auth_verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_verification_identifier_idx').on(t.identifier)],
);
