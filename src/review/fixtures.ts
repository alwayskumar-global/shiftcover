import type {
  CreateGapResponse,
  GapDetailResponse,
  MeResponse,
  OfferDto,
  ParseResultDto,
  PaymentDto,
  RosterResponse,
  SlotDto,
  WaveSummaryDto,
  WorkerOfferDto,
} from '@/api/dto';

/**
 * Review fixtures: every screen and state of Gate 1 as plain API-shaped data (no database).
 * Used by the /review harness (UI_REVIEW=true only), the component tests and the axe/visual runs.
 * Nothing in the product imports this file.
 */

export const TZ = 'America/Los_Angeles';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** 6:49 AM Pacific on Mon 12 Oct 2026, the moment the design's "offering" state is drawn at. */
export const NOW = '2026-10-12T13:49:00.000Z';
const at = (hhmm: string) => `2026-10-12T${hhmm}:00.000Z`; // UTC; 13:42Z = 6:42 AM PDT

export const ME: MeResponse = {
  manager: { email: 'dana.whitfield@example.com', name: 'Dana Whitfield', role: 'manager' },
  org: { name: 'Maple & Rye' },
  venue: {
    id: U(1),
    name: 'Maple & Rye',
    area: 'Portland, OR',
    address: '1201 SE Division St, Portland, OR',
    timezone: TZ,
  },
  config: {
    platform_fee_pct: 5,
    platform_fixed_fee_cents: 0,
    premium_min_pct: 0,
    premium_max_pct: 50,
    max_days_ahead: 14,
    link_ttl_minutes: 15,
    role_default_rate_cents: { line_cook: 2200, prep_cook: 1900, server: 1600, bartender: 1800 },
    paypal_env: 'sandbox',
    paypal_client_id: null,
    payments_mode: 'stub',
  },
};

/** PAYMENTS_MODE=paypal without a usable SDK client id: the PayPal slot cannot load, so the error state shows. */
export const ME_PAYPAL: MeResponse = {
  ...ME,
  config: { ...ME.config, payments_mode: 'paypal', paypal_client_id: null },
};

// ------------------------------------------------------------------------------------------ worker (W1, W2)
const baseOffer: WorkerOfferDto = {
  role: 'line_cook',
  venue_name: 'Maple & Rye',
  venue_area: 'Portland, OR',
  start_at: at('14:00'),
  end_at: at('22:00'),
  hours: 8,
  distance_mi: 2.4,
  rate_cents: 2420,
  pay_total_cents: 19360,
  expires_at: '2026-10-12T14:04:00.000Z',
  state: 'available',
  wave: 2,
  server_time: NOW,
  venue_tz: TZ,
  venue_address: '1201 SE Division St, Portland, OR',
  venue_lat: 45.5051,
  venue_lng: -122.6531,
  first_offered_rate_cents: 2200,
  other_open_offers_count: 0,
  payout_ready: true,
};
const offerIn = (patch: Partial<WorkerOfferDto>): WorkerOfferDto => ({ ...baseOffer, ...patch });

export const WORKER_OFFERS = {
  available: offerIn({
    rate_cents: 2200,
    first_offered_rate_cents: 2200,
    pay_total_cents: 17600,
    wave: 1,
  }),
  'available-rising': offerIn({}),
  'available-urgent': offerIn({ expires_at: '2026-10-12T13:50:20.000Z' }),
  'available-no-payout': offerIn({ payout_ready: false }),
  'available-other-offers': offerIn({ other_open_offers_count: 2 }),
  booked: offerIn({ state: 'claimed' }),
  taken: offerIn({ state: 'taken', other_open_offers_count: 1 }),
  expired: offerIn({ state: 'expired' }),
  withdrawn: offerIn({ state: 'withdrawn' }),
  declined: offerIn({ state: 'declined' }),
  invalid: {
    ...baseOffer,
    state: 'invalid',
    role: null,
    venue_name: null,
    venue_area: null,
    start_at: null,
    end_at: null,
    hours: null,
    distance_mi: null,
    rate_cents: null,
    pay_total_cents: null,
    expires_at: null,
    wave: null,
    server_time: null,
    venue_tz: null,
    venue_address: null,
    venue_lat: null,
    venue_lng: null,
    first_offered_rate_cents: null,
    other_open_offers_count: null,
    payout_ready: null,
  } satisfies WorkerOfferDto,
} as const satisfies Record<string, WorkerOfferDto>;
export type WorkerOfferKey = keyof typeof WORKER_OFFERS;

// ------------------------------------------------------------------------------------------ roster (M2)
const resource = (n: number, name: string, role: SlotDto['role'], tint: number) => ({
  id: U(100 + n),
  name,
  role,
  initials: name
    .split(' ')
    .map((p) => p[0])
    .join(''),
  avatar_tint: tint,
});
export const RESOURCES = [
  resource(1, 'Maria Alvarez', 'line_cook', 1),
  resource(2, 'Marcus Lee', 'line_cook', 2),
  resource(3, 'Chloe Dubois', 'prep_cook', 3),
  resource(4, 'Priya Nair', 'bartender', 4),
  resource(5, 'Devon Brooks', 'server', 5),
];
const ref = (r: (typeof RESOURCES)[number]) => ({ ...r });

const slot = (n: number, patch: Partial<SlotDto>): SlotDto => ({
  id: U(200 + n),
  role: 'line_cook',
  venue_name: 'Maple & Rye',
  venue_area: 'Portland, OR',
  start_at: at('14:00'),
  end_at: at('22:00'),
  hours: 8,
  status: 'confirmed',
  worker: null,
  base_rate_cents: 2200,
  max_premium_pct: 20,
  offered_rate_cents: null,
  fill_by: at('14:00'),
  venue_tz: TZ,
  gap_reason: null,
  replaces_worker: null,
  search_radius_mi: 5,
  current_wave: null,
  cancelled_at: null,
  cancelled_by: null,
  ...patch,
});

const rosterEvents = (gap: SlotDto['status'] | null): SlotDto[] => [
  slot(1, {
    role: 'line_cook',
    worker: ref(RESOURCES[1]!),
    status: 'confirmed',
    start_at: at('14:00'),
    end_at: at('22:00'),
  }),
  slot(2, {
    role: 'prep_cook',
    worker: ref(RESOURCES[2]!),
    status: 'in_progress',
    start_at: at('13:00'),
    end_at: at('21:00'),
  }),
  slot(3, {
    role: 'bartender',
    worker: ref(RESOURCES[3]!),
    status: 'confirmed',
    start_at: at('23:00'),
    end_at: '2026-10-13T07:00:00.000Z',
    hours: 8,
  }),
  slot(4, {
    role: 'server',
    worker: ref(RESOURCES[4]!),
    status: 'planned',
    start_at: at('18:00'),
    end_at: at('23:00'),
    hours: 5,
  }),
  ...(gap
    ? [
        slot(5, {
          role: 'line_cook',
          worker: null,
          status: gap,
          replaces_worker: { id: RESOURCES[0]!.id, name: 'Maria Alvarez' },
          current_wave: gap === 'offering' ? 2 : null,
          offered_rate_cents: null,
        }),
      ]
    : []),
];

const rosterBase = {
  date: '2026-10-12',
  end_date: '2026-10-12',
  timezone: TZ,
  server_time: NOW,
  resources: RESOURCES,
};
export const ROSTERS = {
  loaded: {
    ...rosterBase,
    events: rosterEvents('offering'),
    summary: { open_gaps: 0, offering: 1, shifts_today: 5 },
  },
  'open-gap': {
    ...rosterBase,
    events: rosterEvents('open'),
    summary: { open_gaps: 1, offering: 0, shifts_today: 5 },
  },
  'no-gaps': {
    ...rosterBase,
    events: rosterEvents(null),
    summary: { open_gaps: 0, offering: 0, shifts_today: 4 },
  },
} as const satisfies Record<string, RosterResponse>;
export type RosterKey = keyof typeof ROSTERS;

// ------------------------------------------------------------------------------------------ report a gap (M3)
export const PARSE_RESULT = (date: string): ParseResultDto => ({
  source: 'rules',
  role: 'line_cook',
  date,
  start: '07:00',
  end: '15:00',
  venue: { id: ME.venue.id, name: ME.venue.name },
  base_rate_cents: 2200,
  base_rate_source: 'role_default',
  max_premium_pct: 20,
  worker_pay_at_cap_cents: 21120,
  platform_fee_cents: 1056,
  total_hold_cents: 22176,
  missing: [],
  replaces_slot_id: null,
  called_out_name: 'Maria',
  gap_reason: 'called_in_sick',
  start_at: null,
  end_at: null,
});

// ------------------------------------------------------------------------------------------ gap detail (M4)
const WORKERS = {
  marcus: ['Marcus Lee', 'line_cook', 2],
  chloe: ['Chloe Dubois', 'prep_cook', 3],
  sam: ['Sam Whitfield', 'bar_back', 4],
  jordan: ['Jordan Reyes', 'line_cook', 1],
  priya: ['Priya Nair', 'bartender', 5],
  devon: ['Devon Brooks', 'server', 2],
  aisha: ['Aisha Khan', 'server', 3],
  lena: ['Lena Park', 'host', 4],
} as const satisfies Record<string, readonly [string, OfferDto['worker']['role'], number]>;
type W = keyof typeof WORKERS;

let offerSeq = 0;
const offer = (
  w: W,
  wave: 1 | 2 | 3,
  status: OfferDto['status'],
  patch: Partial<OfferDto> = {},
): OfferDto => {
  const [name, role, tint] = WORKERS[w];
  const sent = wave === 1 ? at('13:42') : wave === 2 ? at('13:47') : at('13:52');
  return {
    id: U(300 + ++offerSeq),
    worker: {
      name,
      role,
      initials: name
        .split(' ')
        .map((p) => p[0])
        .join(''),
      avatar_tint: tint,
    },
    wave,
    rate_cents: wave === 1 ? 2200 : wave === 2 ? 2420 : 2640,
    status,
    sent_at: sent,
    opened_at: status === 'opened' ? at('13:44') : null,
    claimed_at: status === 'claimed' ? at('13:49') : null,
    expires_at: '2026-10-12T14:00:00.000Z',
    declined_at: status === 'declined' ? at('13:44') : null,
    expired_at: status === 'expired' ? at('14:00') : null,
    withdrawn_at: status === 'withdrawn' ? at('13:49') : null,
    ...patch,
  };
};

const wave = (n: 1 | 2 | 3, counts: Partial<WaveSummaryDto> = {}): WaveSummaryDto => ({
  wave: n,
  sent_at: n === 1 ? at('13:42') : n === 2 ? at('13:47') : at('13:52'),
  audience_count: n === 1 ? 3 : n === 2 ? 5 : 9,
  rate_cents: n === 1 ? 2200 : n === 2 ? 2420 : 2640,
  capped: false,
  opened_count: 0,
  declined_count: 0,
  expired_count: 0,
  withdrawn_count: 0,
  ...counts,
});

const pay = (patch: Partial<PaymentDto>): PaymentDto => ({
  status: 'authorized',
  authorized_cents: 22176,
  captured_cents: 0,
  worker_pay_cents: 0,
  platform_fee_cents: 0,
  paypal_references: {
    order: '5O190127TN364715T',
    authorization: '7MN40918RK225310X',
    capture: null,
    payout: null,
  },
  last_error: null,
  ...patch,
});

const jordan = (): SlotDto['worker'] => ({
  id: U(401),
  name: 'Jordan Reyes',
  role: 'line_cook',
  initials: 'JR',
  avatar_tint: 1,
});
const gapSlot = (patch: Partial<SlotDto>): SlotDto =>
  slot(5, {
    status: 'offering',
    worker: null,
    fill_by: at('14:00'),
    replaces_worker: { id: RESOURCES[0]!.id, name: 'Maria Alvarez' },
    current_wave: 2,
    ...patch,
  });

const detail = (
  s: SlotDto,
  waves: WaveSummaryDto[],
  offers: OfferDto[],
  payment: PaymentDto | null,
  now = NOW,
): GapDetailResponse => ({
  server_time: now,
  widen: { radius_mi: s.search_radius_mi, max_radius_mi: 25, preview_count: 4 },
  slot: s,
  waves,
  offers,
  payment,
});

const filledOffers = () => [
  offer('jordan', 2, 'claimed'),
  offer('marcus', 1, 'declined'),
  offer('chloe', 1, 'expired'),
  offer('sam', 1, 'expired'),
  offer('priya', 2, 'withdrawn'),
  offer('devon', 2, 'withdrawn'),
];
const filledWaves = () => [
  wave(1, { declined_count: 1, expired_count: 2 }),
  wave(2, { withdrawn_count: 2 }),
];
const filledSlot = (status: SlotDto['status']) =>
  gapSlot({ status, worker: jordan(), offered_rate_cents: 2420, current_wave: 2 });
const settled = (status: PaymentDto['status'], patch: Partial<PaymentDto> = {}) =>
  pay({
    status,
    captured_cents: status === 'capture_declined' ? 0 : 20328,
    worker_pay_cents: 19360,
    platform_fee_cents: 968,
    ...patch,
  });

export const GAP_DETAILS = {
  open: detail(
    gapSlot({ status: 'open', current_wave: null }),
    [],
    [],
    pay({
      status: 'awaiting_approval',
      paypal_references: { order: null, authorization: null, capture: null, payout: null },
    }),
  ),
  offering: detail(
    gapSlot({ status: 'offering', current_wave: 2 }),
    [wave(1, { declined_count: 1, opened_count: 1 }), wave(2, { opened_count: 1 })],
    [
      offer('marcus', 1, 'declined'),
      offer('chloe', 1, 'opened'),
      offer('sam', 1, 'sent'),
      offer('jordan', 2, 'opened'),
      offer('priya', 2, 'sent'),
      offer('devon', 2, 'sent'),
      offer('aisha', 2, 'sent'),
      offer('lena', 2, 'sent'),
    ],
    pay({}),
  ),
  filled: detail(filledSlot('confirmed'), filledWaves(), filledOffers(), pay({})),
  'in-progress': detail(
    filledSlot('in_progress'),
    filledWaves(),
    filledOffers(),
    pay({}),
    '2026-10-12T16:12:00.000Z',
  ),
  'pending-approval': detail(
    filledSlot('pending_approval'),
    filledWaves(),
    filledOffers(),
    pay({}),
    '2026-10-12T22:08:00.000Z',
  ),
  'capture-declined': detail(
    filledSlot('settling'),
    filledWaves(),
    filledOffers(),
    settled('capture_declined'),
    '2026-10-12T22:52:00.000Z',
  ),
  'payout-failed': detail(
    filledSlot('settling'),
    filledWaves(),
    filledOffers(),
    settled('payout_failed', {
      paypal_references: {
        order: '5O190127TN364715T',
        authorization: '7MN40918RK225310X',
        capture: '2GH65173LA904418C',
        payout: '9QX20381VD773952B',
      },
    }),
    '2026-10-12T22:54:00.000Z',
  ),
  unfilled: detail(
    gapSlot({ status: 'unfilled', current_wave: 3, search_radius_mi: 5 }),
    [
      wave(1, { declined_count: 1, expired_count: 2 }),
      wave(2, { declined_count: 1, expired_count: 4 }),
      wave(3, { expired_count: 9 }),
    ],
    [
      offer('marcus', 1, 'declined'),
      offer('chloe', 1, 'expired'),
      offer('sam', 1, 'expired'),
      offer('jordan', 2, 'expired'),
      offer('priya', 2, 'declined'),
      offer('devon', 2, 'expired'),
    ],
    pay({ status: 'voided' }),
    '2026-10-12T14:25:00.000Z',
  ),
  cancelled: detail(
    gapSlot({ status: 'cancelled', cancelled_at: at('13:55'), cancelled_by: 'user:manager' }),
    [wave(1, { declined_count: 1, withdrawn_count: 2 })],
    [
      offer('marcus', 1, 'declined'),
      offer('chloe', 1, 'withdrawn'),
      offer('sam', 1, 'withdrawn'),
      offer('jordan', 2, 'withdrawn'),
    ],
    pay({ status: 'voided' }),
    '2026-10-12T13:55:00.000Z',
  ),
} as const satisfies Record<string, GapDetailResponse>;
export type GapDetailKey = keyof typeof GAP_DETAILS;

export const CREATE_GAP_RESPONSE: CreateGapResponse = {
  slot: GAP_DETAILS.open.slot,
  payment: pay({
    status: 'awaiting_approval',
    paypal_references: { order: null, authorization: null, capture: null, payout: null },
  }),
  hold: { worker_pay_at_cap_cents: 21120, platform_fee_cents: 1056, total_hold_cents: 22176 },
};

// ------------------------------------------------------------------------------------------ scene registry
export type Step =
  | { fill: string; value: string }
  | { click: string; force?: boolean }
  | { select: string; value: string }
  | { wait: number };

export type Scene = {
  id: string;
  group:
    'W1 claim card' | 'W2 booked' | 'M1 login' | 'M2 roster' | 'M3 report a gap' | 'M4 gap detail';
  label: string;
  /** What the harness renders. */
  render:
    | { kind: 'worker'; offer: WorkerOfferKey | 'network-error' }
    | { kind: 'login' }
    | { kind: 'roster'; roster: RosterKey | 'error' | 'pending' }
    | { kind: 'gap-new'; payments?: 'paypal' }
    | { kind: 'gap-detail'; detail: GapDetailKey };
  /** Interactions applied after load (shared by axe and screenshots). Selectors are Playwright text/CSS selectors. */
  steps?: Step[];
  viewport: { width: number; height: number };
  /** Matching design reference page and hash, when the design draws this state. */
  design?: { file: string; hash?: string };
};

const D = { width: 1440, height: 900 };
const M = { width: 390, height: 844 };
const NL = 'Maria called in sick, need a line cook 7 to 3 today';
const parseSteps: Step[] = [
  { fill: '#nl', value: NL },
  { click: 'button:has-text("Parse")' },
  { wait: 600 },
];
const confirmSteps: Step[] = [
  ...parseSteps,
  { click: 'button:has-text("Details are correct")' },
  { wait: 700 },
];

const w = (key: WorkerOfferKey, label: string, hash: string): Scene => ({
  id: `w1-${key}`,
  group: key === 'booked' ? 'W2 booked' : 'W1 claim card',
  label,
  render: { kind: 'worker', offer: key },
  viewport: M,
  design: { file: key === 'booked' ? 'W2-claimed.dc.html' : 'W1-claim-card.dc.html', hash },
});

export const SCENES: Scene[] = [
  w('available', 'Available, wave 1', 'available'),
  w('available-rising', 'Available, rate has risen', 'rising'),
  w('available-urgent', 'Available, under two minutes', 'available'),
  w('available-no-payout', 'Available, payout not set up', 'available'),
  w('available-other-offers', 'Available, other open offers', 'available'),
  w('booked', 'Booked (W2)', ''),
  w('taken', 'Taken', 'taken'),
  w('expired', 'Expired', 'expired'),
  w('withdrawn', 'Withdrawn', 'withdrawn'),
  w('declined', 'Declined', 'declined'),
  w('invalid', 'Invalid link', 'invalid'),
  {
    id: 'w1-error-load',
    group: 'W1 claim card',
    label: 'Could not load',
    render: { kind: 'worker', offer: 'network-error' },
    viewport: M,
    design: { file: 'W1-claim-card.dc.html', hash: 'errorLoad' },
  },
  {
    id: 'm1-default',
    group: 'M1 login',
    label: 'Sign in',
    render: { kind: 'login' },
    viewport: D,
    design: { file: 'M1-login.dc.html', hash: 'default' },
  },
  {
    id: 'm1-validation',
    group: 'M1 login',
    label: 'Validation',
    render: { kind: 'login' },
    steps: [{ click: 'button[type="submit"]' }],
    viewport: D,
    design: { file: 'M1-login.dc.html', hash: 'validation' },
  },
  {
    id: 'm2-loaded',
    group: 'M2 roster',
    label: 'Roster with an offering gap',
    render: { kind: 'roster', roster: 'loaded' },
    viewport: D,
    design: { file: 'M2-roster.dc.html', hash: 'populated' },
  },
  {
    id: 'm2-open-gap',
    group: 'M2 roster',
    label: 'Roster with an open gap',
    render: { kind: 'roster', roster: 'open-gap' },
    viewport: D,
    design: { file: 'M2-roster.dc.html', hash: 'populated' },
  },
  {
    id: 'm2-no-gaps',
    group: 'M2 roster',
    label: 'No gaps',
    render: { kind: 'roster', roster: 'no-gaps' },
    viewport: D,
    design: { file: 'M2-roster.dc.html', hash: 'empty' },
  },
  {
    id: 'm2-loading',
    group: 'M2 roster',
    label: 'Loading',
    render: { kind: 'roster', roster: 'pending' },
    viewport: D,
    design: { file: 'M2-roster.dc.html', hash: 'loading' },
  },
  {
    id: 'm2-error',
    group: 'M2 roster',
    label: 'Could not load',
    render: { kind: 'roster', roster: 'error' },
    viewport: D,
    design: { file: 'M2-roster.dc.html', hash: 'error' },
  },
  {
    id: 'm3-empty',
    group: 'M3 report a gap',
    label: 'Empty',
    render: { kind: 'gap-new' },
    viewport: D,
    design: { file: 'M3-report-gap.dc.html', hash: 'empty' },
  },
  {
    id: 'm3-validation',
    group: 'M3 report a gap',
    label: 'Validation errors',
    render: { kind: 'gap-new' },
    steps: [
      { select: '#f-role', value: 'line_cook' },
      { fill: '#f-start', value: '15:00' },
      { fill: '#f-end', value: '07:00' },
      { fill: '#f-prem', value: '120' },
      { click: 'button:has-text("Details are correct")', force: true },
    ],
    viewport: D,
    design: { file: 'M3-report-gap.dc.html', hash: 'validation' },
  },
  {
    id: 'm3-parsed',
    group: 'M3 report a gap',
    label: 'Parsed, confirm',
    render: { kind: 'gap-new' },
    steps: parseSteps,
    viewport: D,
    design: { file: 'M3-report-gap.dc.html', hash: 'parsed' },
  },
  {
    id: 'm3-confirmed',
    group: 'M3 report a gap',
    label: 'Confirmed, awaiting hold',
    render: { kind: 'gap-new' },
    steps: confirmSteps,
    viewport: D,
    design: { file: 'M3-report-gap.dc.html', hash: 'confirmed' },
  },
  {
    id: 'm3-approved',
    group: 'M3 report a gap',
    label: 'Hold placed',
    render: { kind: 'gap-new' },
    steps: [...confirmSteps, { click: '[data-testid="stub-approve"]' }, { wait: 700 }],
    viewport: D,
    design: { file: 'M3-report-gap.dc.html', hash: 'paypalApproved' },
  },
  ...(
    [
      ['open', 'Open, hold needed', ''],
      ['offering', 'Offering, wave 2', 'offering'],
      ['filled', 'Filled', 'filled'],
      ['in-progress', 'In progress', 'inProgress'],
      ['pending-approval', 'Pending approval', 'pendingApproval'],
      ['capture-declined', 'Capture declined', 'captureDeclined'],
      ['payout-failed', 'Payout failed', 'payoutFailed'],
      ['unfilled', 'Unfilled', 'unfilled'],
      ['cancelled', 'Cancelled', 'cancelled'],
    ] as const
  ).map(([key, label, hash]): Scene => ({
    id: `m4-${key}`,
    group: 'M4 gap detail',
    label,
    render: { kind: 'gap-detail', detail: key },
    viewport: D,
    design: { file: 'M4-gap-detail.dc.html', hash },
  })),
  {
    id: 'm3-paypal-unavailable',
    group: 'M3 report a gap',
    label: 'PayPal button could not load (paypal mode)',
    render: { kind: 'gap-new', payments: 'paypal' },
    steps: confirmSteps,
    viewport: D,
    design: { file: 'M3-report-gap.dc.html', hash: 'paypalFailed' },
  },
  {
    id: 'm4-cancel-dialog',
    group: 'M4 gap detail',
    label: 'Cancel dialog',
    render: { kind: 'gap-detail', detail: 'offering' },
    steps: [{ click: 'button:has-text("Cancel gap")' }, { wait: 200 }],
    viewport: D,
    design: { file: 'M4-gap-detail.dc.html', hash: 'offering' },
  },
];

export const sceneById = (id: string) => SCENES.find((s) => s.id === id);
