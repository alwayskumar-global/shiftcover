import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Auth } from '../auth';
import { requireManager } from '../auth/guards';
import {
  createWorkerSession,
  parseCookie,
  readWorkerSession,
  requireWorker,
  WORKER_COOKIE,
  workerCookieHeader,
} from '../auth/worker-session';
import {
  GAP_DATE_LIMITS,
  MAGIC_LINK_TTL_MINUTES,
  PREMIUM_RANGE,
  ROLE_DEFAULT_RATE_CENTS,
} from '../config/business';
import { orgs } from '../db/schema';
import { maxAuthorization } from '../domain/money';
import { isShiftRole, type ShiftRole } from '../domain/roles';
import { localDateString, localDayBounds, localParts } from '../lib/time';
import { rulesGapParser } from '../llm/fallback';
import { claimOffer, declineOffer, viewOffer } from '../services/claim';
import { cancelGap, createGap, startOffering, widenRadius } from '../services/gaps';
import { resendOfferLink } from '../services/offer-link';
import { stubAuthorize } from '../services/payments-stub';
import { listApprovals } from '../services/approvals';
import { listOutbox } from '../services/outbox';
import { approveAndPay, authorizePayment, ensureOrder } from '../services/payments';
import { arrive, finish, managerConfirmTimes, markNoShow } from '../services/shift-day';
import {
  findRecognisedSlot,
  gapDetail,
  paymentDto,
  primaryVenue,
  roster,
  slotDto,
} from '../services/read-models';
import type { ServiceDeps } from '../services/types';
import { workerShifts } from '../services/worker-data';
import { workerEarnings } from '../services/worker-earnings';
import { publicPaymentStatus, toWorkerOfferDto } from './adapters';
import {
  CancelGapRequest,
  CancelGapResponse,
  ClaimResponse,
  CreateGapRequest,
  CreateGapResponse,
  GapDetailResponse,
  MeResponse,
  ParseGapRequest,
  ParseResultDto,
  ResendLinkRequest,
  ResendLinkResponse,
  RosterQuery,
  RosterResponse,
  StartOfferingResponse,
  StubAuthorizeResponse,
  ApprovalsResponse,
  ApproveAndPayRequest,
  ApproveAndPayResponse,
  AuthorizeRequest,
  AuthorizeResponse,
  ConfirmTimesRequest,
  ConfirmTimesResponse,
  NoShowResponse,
  OrderResponse,
  OutboxResponse,
  ShiftDayResponse,
  WidenRadiusRequest,
  WidenRadiusResponse,
  WorkerOfferDto,
  WorkerEarningsResponse,
  WorkerShiftsResponse,
} from './dto';
import { assertSameOrigin, HttpError, noStore, parseBody } from './http';
import { clientIp, type RateLimiter } from './rate-limit';

export interface ApiDeps {
  svc: ServiceDeps;
  auth: Auth;
  limiter: RateLimiter;
  /** SESSION_SECRET: signs the worker cookie. */
  sessionSecret: string;
  production: boolean;
  paymentsMode: 'paypal' | 'stub';
  /** PAYPAL_ENV. The sandbox Outbox page and API exist only when this is 'sandbox'. */
  paypalEnv: string;
  /** Public PayPal client id for the browser SDK (PAYPAL_CLIENT_ID; public by design). */
  paypalClientId?: string;
  maxPremiumPctDefault: number;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  Response.json(body, { ...init, headers: { ...noStore, ...(init.headers ?? {}) } });

const mgr = (d: ApiDeps, req: Request) => requireManager(d.auth, d.svc.db, req.headers);
const managerPost = (d: ApiDeps, req: Request) => assertSameOrigin(req, d.svc.config.appBaseUrl);

const hhmm = (date: Date, tz: string) => {
  const p = localParts(date, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

const slotId = (id: string) => {
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) throw new HttpError(404, 'not_found');
  return uuid.data;
};

// ---------------------------------------------------------------- manager: me (nav + form config)
export async function buildMe(d: ApiDeps, ctx: { orgId: string; email: string; name: string }) {
  const venue = await primaryVenue(d.svc.db, ctx.orgId);
  const [org] = await d.svc.db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, ctx.orgId));
  return MeResponse.parse({
    manager: { email: ctx.email, name: ctx.name, role: 'manager' },
    org: { name: org?.name ?? '' },
    venue: {
      id: venue.id,
      name: venue.name,
      area: venue.area,
      address: venue.address,
      timezone: venue.timezone,
    },
    config: {
      platform_fee_pct: d.svc.config.platformFeeBps / 100,
      platform_fixed_fee_cents: d.svc.config.platformFixedFeeCents ?? 0,
      premium_min_pct: PREMIUM_RANGE.minPct,
      premium_max_pct: PREMIUM_RANGE.maxPct,
      max_days_ahead: GAP_DATE_LIMITS.maxDaysAhead,
      link_ttl_minutes: MAGIC_LINK_TTL_MINUTES,
      role_default_rate_cents: ROLE_DEFAULT_RATE_CENTS,
      paypal_env: 'sandbox',
      paypal_client_id: d.paypalClientId ?? null,
      payments_mode: d.paymentsMode,
    },
  });
}

export async function getMe(d: ApiDeps, req: Request) {
  return json(await buildMe(d, await mgr(d, req)));
}

// ---------------------------------------------------------------- manager: roster
export async function getRoster(d: ApiDeps, req: Request) {
  const ctx = await mgr(d, req);
  const sp = new URL(req.url).searchParams;
  const q = RosterQuery.parse({
    date: sp.get('date') ?? undefined,
    days: sp.get('days') ?? undefined,
  });
  const data = await roster(d.svc.db, ctx.orgId, q.date, d.svc.now(), q.days === '7' ? 7 : 1);
  return json(RosterResponse.parse(data));
}

// ---------------------------------------------------------------- manager: parse
export async function postParseGap(d: ApiDeps, req: Request) {
  const ctx = await mgr(d, req);
  managerPost(d, req);
  const { text } = await parseBody(req, ParseGapRequest);
  const venue = await primaryVenue(d.svc.db, ctx.orgId);
  const now = d.svc.now();
  const p = rulesGapParser.parse(text, { now, timezone: venue.timezone });
  if (!p || (!p.role && !p.startAt && p.baseRateCents === null && !p.calledOutName)) {
    // Nothing usable was found: the UI shows "We couldn't read that note" and fills nothing in.
    throw new HttpError(422, 'parse_failed', 'Nothing could be read from that note');
  }

  const today = localDateString(now, venue.timezone);
  const day = localDayBounds(
    p.startAt ? localDateString(p.startAt, venue.timezone) : today,
    venue.timezone,
  );
  const replaced = p.calledOutName
    ? await findRecognisedSlot(
        d.svc.db,
        ctx.orgId,
        venue.id,
        p.calledOutName,
        p.startAt && p.endAt ? { start: p.startAt, end: p.endAt } : null,
        day,
      )
    : null;

  const role: ShiftRole | null =
    p.role ?? (replaced && isShiftRole(replaced.role) ? replaced.role : null);
  // Rate: stated in the text, else the replaced shift's, else the role default (tagged so the UI can say so).
  let baseRateCents = p.baseRateCents;
  let baseRateSource: 'text' | 'replaced_shift' | 'role_default' | null =
    baseRateCents !== null ? 'text' : null;
  if (baseRateCents === null && replaced) {
    baseRateCents = replaced.baseRateCents;
    baseRateSource = 'replaced_shift';
  }
  if (baseRateCents === null && role) {
    baseRateCents = ROLE_DEFAULT_RATE_CENTS[role];
    baseRateSource = 'role_default';
  }
  const missing: Array<'role' | 'time' | 'base_rate'> = [];
  if (!role) missing.push('role');
  if (!p.startAt || !p.endAt) missing.push('time');
  if (baseRateCents === null) missing.push('base_rate');

  const maxPremiumPct = Math.min(p.maxPremiumPct ?? d.maxPremiumPctDefault, PREMIUM_RANGE.maxPct);
  const minutes =
    p.startAt && p.endAt ? Math.round((p.endAt.getTime() - p.startAt.getTime()) / 60_000) : 0;
  const hold =
    role && p.startAt && p.endAt && baseRateCents !== null
      ? maxAuthorization({
          baseRateCents,
          maxPremiumPct,
          minutes,
          feeBps: d.svc.config.platformFeeBps,
        })
      : null;

  return json(
    ParseResultDto.parse({
      source: 'rules',
      role,
      date: p.startAt ? localDateString(p.startAt, venue.timezone) : null,
      start: p.startAt ? hhmm(p.startAt, venue.timezone) : null,
      end: p.endAt ? hhmm(p.endAt, venue.timezone) : null,
      venue: { id: venue.id, name: venue.name },
      base_rate_cents: baseRateCents,
      base_rate_source: baseRateSource,
      max_premium_pct: maxPremiumPct,
      worker_pay_at_cap_cents: hold?.maxWorkerPayCents ?? null,
      platform_fee_cents: hold?.maxFeeCents ?? null,
      total_hold_cents: hold?.authorizedCents ?? null,
      missing,
      replaces_slot_id: replaced?.id ?? null,
      called_out_name: p.calledOutName,
      gap_reason: /\bsick\b/i.test(text) ? 'called_in_sick' : null,
      start_at: p.startAt?.toISOString() ?? null,
      end_at: p.endAt?.toISOString() ?? null,
    }),
  );
}

// ---------------------------------------------------------------- manager: create gap
export async function postCreateGap(d: ApiDeps, req: Request) {
  const ctx = await mgr(d, req);
  managerPost(d, req);
  const body = await parseBody(req, CreateGapRequest);
  const r = await createGap(
    d.svc,
    { orgId: ctx.orgId, userId: ctx.userId },
    {
      venueId: body.venue_id,
      role: body.role,
      startAt: new Date(body.start_at),
      endAt: new Date(body.end_at),
      baseRateCents: body.base_rate_cents,
      maxPremiumPct: body.max_premium_pct,
      replacesSlotId: body.replaces_slot_id,
      gapReason: body.gap_reason,
    },
  );
  return json(
    CreateGapResponse.parse({
      slot: await slotDto(d.svc.db, ctx.orgId, r.slot.id),
      payment: await paymentDto(d.svc.db, r.slot.id),
      hold: {
        worker_pay_at_cap_cents: r.hold.maxWorkerPayCents,
        platform_fee_cents: r.hold.maxFeeCents,
        total_hold_cents: r.hold.authorizedCents,
      },
    }),
    { status: 201 },
  );
}

// ---------------------------------------------------------------- manager: gap detail + actions
export async function getGap(d: ApiDeps, req: Request, id: string) {
  const ctx = await mgr(d, req);
  return json(
    GapDetailResponse.parse(await gapDetail(d.svc.db, ctx.orgId, slotId(id), d.svc.now())),
  );
}

export async function postStartOffering(d: ApiDeps, req: Request, id: string) {
  const ctx = await mgr(d, req);
  managerPost(d, req);
  const sid = slotId(id);
  await startOffering(d.svc, { orgId: ctx.orgId, userId: ctx.userId }, sid);
  return json(StartOfferingResponse.parse({ slot: await slotDto(d.svc.db, ctx.orgId, sid) }));
}

export async function postWidenRadius(d: ApiDeps, req: Request, id: string) {
  const ctx = await mgr(d, req);
  managerPost(d, req);
  const sid = slotId(id);
  const body = await parseBody(req, WidenRadiusRequest);
  const r = await widenRadius(
    d.svc,
    { orgId: ctx.orgId, userId: ctx.userId },
    sid,
    body.search_radius_mi,
  );
  return json(
    WidenRadiusResponse.parse({
      slot: await slotDto(d.svc.db, ctx.orgId, sid),
      reopened: r.reopened,
    }),
  );
}

export async function postCancelGap(d: ApiDeps, req: Request, id: string) {
  const ctx = await mgr(d, req);
  managerPost(d, req);
  const sid = slotId(id);
  const body = await parseBody(req, CancelGapRequest);
  await cancelGap(d.svc, { orgId: ctx.orgId, userId: ctx.userId }, sid, body.reason);
  return json(CancelGapResponse.parse({ slot: await slotDto(d.svc.db, ctx.orgId, sid) }));
}

/** Development/test only. 404 unless PAYMENTS_MODE=stub, which env.ts refuses in production. */
export async function postStubAuthorize(d: ApiDeps, req: Request, id: string) {
  if (d.paymentsMode !== 'stub' || d.production) throw new HttpError(404, 'not_found');
  const ctx = await mgr(d, req);
  managerPost(d, req);
  const sid = slotId(id);
  await slotDto(d.svc.db, ctx.orgId, sid); // org scoping: 404 for other organisations' slots
  await stubAuthorize(d.svc.db, d.paymentsMode, sid, `user:${ctx.userId}`);
  return json(StubAuthorizeResponse.parse({ payment: await paymentDto(d.svc.db, sid) }));
}

// ---------------------------------------------------------------- worker: offer link
const WORKER_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

/** GET never consumes or writes anything. A valid open upgrades to a session cookie. */
export async function getOffer(d: ApiDeps, req: Request, token: string) {
  if (!d.limiter.hit(`offer-get:${clientIp(req.headers)}`, 60, 60_000))
    throw new HttpError(429, 'rate_limited');
  const view = await viewOffer(d.svc, token);
  const headers: Record<string, string> = { ...WORKER_HEADERS };
  if (view.offer && view.state !== 'invalid') {
    headers['Set-Cookie'] = workerCookieHeader(
      createWorkerSession(view.offer.workerId, d.sessionSecret, d.svc.now()),
      d.production,
    );
  }
  return json(WorkerOfferDto.parse(toWorkerOfferDto(view)), {
    status: view.state === 'invalid' ? 404 : 200,
    headers,
  });
}

const cookieWorker = (d: ApiDeps, req: Request) =>
  readWorkerSession(
    parseCookie(req.headers.get('cookie'), WORKER_COOKIE),
    d.sessionSecret,
    d.svc.now(),
  ) ?? undefined;

export async function postClaim(d: ApiDeps, req: Request, token: string) {
  assertSameOrigin(req, d.svc.config.appBaseUrl); // CSRF
  if (!d.limiter.hit(`claim:${clientIp(req.headers)}`, 10, 60_000))
    throw new HttpError(429, 'rate_limited');
  await parseBody(req, z.object({}).strict());
  const result = await claimOffer(d.svc, token, { expectedWorkerId: cookieWorker(d, req) });
  return json(ClaimResponse.parse(toWorkerOfferDto(result)), {
    status: result.state === 'invalid' ? 404 : 200,
    headers: WORKER_HEADERS,
  });
}

/** "Not available". Records the skip; no reason is asked or stored. */
export async function postDecline(d: ApiDeps, req: Request, token: string) {
  assertSameOrigin(req, d.svc.config.appBaseUrl);
  if (!d.limiter.hit(`decline:${clientIp(req.headers)}`, 10, 60_000))
    throw new HttpError(429, 'rate_limited');
  await parseBody(req, z.object({}).strict());
  const result = await declineOffer(d.svc, token, { expectedWorkerId: cookieWorker(d, req) });
  return json(WorkerOfferDto.parse(toWorkerOfferDto(result)), {
    status: result.state === 'invalid' ? 404 : 200,
    headers: WORKER_HEADERS,
  });
}

/**
 * "Email me a new link". The answer is identical for known and unknown addresses; limits are keyed on the
 * submitted address and the caller's IP, never on whether the address exists.
 */
export async function postResendLink(d: ApiDeps, req: Request) {
  assertSameOrigin(req, d.svc.config.appBaseUrl);
  const body = await parseBody(req, ResendLinkRequest);
  const email = body.email.trim().toLowerCase();
  if (
    !d.limiter.hit(`resend-ip:${clientIp(req.headers)}`, 10, 3_600_000) ||
    !d.limiter.hit(`resend-email:${email}`, 3, 3_600_000)
  ) {
    throw new HttpError(429, 'rate_limited');
  }
  await resendOfferLink(d.svc, email);
  return json(ResendLinkResponse.parse({ ok: true }), { headers: WORKER_HEADERS });
}

export async function getWorkerShifts(d: ApiDeps, req: Request) {
  const workerId = requireWorker(req.headers, d.sessionSecret, d.svc.now());
  const shifts = await workerShifts(d.svc.db, workerId);
  return json(
    WorkerShiftsResponse.parse({
      server_time: d.svc.now().toISOString(),
      shifts: shifts.map((s) => ({
        offer_id: s.offerId,
        offer_status: s.offerStatus.toLowerCase(),
        rate_cents: s.rateCents,
        expires_at: s.expiresAt,
        slot_id: s.slotId,
        slot_status: s.slotStatus.toLowerCase(),
        role: s.role,
        start_at: s.startAt,
        end_at: s.endAt,
        venue_name: s.venueName,
        is_mine: s.isMine,
        venue_area: s.venueArea,
        venue_tz: s.venueTz,
        venue_address: s.venueAddress,
        manager_name: s.managerName,
        hours: s.hours,
        offered_rate_cents: s.offeredRateCents,
        check_in_at: s.checkInAt,
        check_out_at: s.checkOutAt,
        approved_hours: s.approvedHours,
        payment_status: s.paymentStatus ? publicPaymentStatus(s.paymentStatus) : null,
        worker_pay_cents: s.workerPayCents,
      })),
    }),
    { headers: WORKER_HEADERS },
  );
}

export async function getWorkerEarnings(d: ApiDeps, req: Request) {
  const workerId = requireWorker(req.headers, d.sessionSecret, d.svc.now());
  const now = d.svc.now();
  const e = await workerEarnings(d.svc.db, workerId, now);
  const tot = (t: typeof e.week) => ({
    total_cents: t.totalCents,
    paid_cents: t.paidCents,
    on_the_way_cents: t.onTheWayCents,
  });
  return json(
    WorkerEarningsResponse.parse({
      server_time: now.toISOString(),
      week: tot(e.week),
      month: tot(e.month),
      failed_cents: e.failedCents,
      items: e.items.map((r) => ({
        slot_id: r.slotId,
        role: r.role,
        venue_name: r.venueName,
        venue_tz: r.venueTz,
        start_at: r.startAt.toISOString(),
        end_at: r.endAt.toISOString(),
        approved_hours: r.approvedHours,
        rate_cents: r.rateCents,
        worker_pay_cents: r.workerPayCents,
        status: r.status,
        reference: r.reference,
      })),
    }),
    { headers: WORKER_HEADERS },
  );
}

// ---------------------------------------------------------------- M2: money
const sid = slotId;

/** The PayPal order for the hold (created with the gap; created here when that attempt failed). Idempotent. */
export async function postOrder(d: ApiDeps, req: Request, id: string) {
  const ctx = await mgr(d, req);
  managerPost(d, req);
  await parseBody(req, z.object({}).strict());
  const r = await ensureOrder(d.svc, { orgId: ctx.orgId, userId: ctx.userId }, sid(id));
  return json(OrderResponse.parse({ order_id: r.orderId }));
}

/** onApprove lands here. The server authorizes, verifies status and amount, then records the authorization. */
export async function postAuthorize(d: ApiDeps, req: Request, id: string) {
  const ctx = await mgr(d, req);
  managerPost(d, req);
  const body = await parseBody(req, AuthorizeRequest);
  const gapId = sid(id);
  await authorizePayment(d.svc, { orgId: ctx.orgId, userId: ctx.userId }, gapId, body.order_id);
  return json(
    AuthorizeResponse.parse({
      payment: await paymentDto(d.svc.db, gapId),
      slot: await slotDto(d.svc.db, ctx.orgId, gapId),
    }),
  );
}

export async function postApproveAndPay(d: ApiDeps, req: Request, id: string) {
  const ctx = await mgr(d, req);
  managerPost(d, req);
  const body = await parseBody(req, ApproveAndPayRequest);
  const shiftId = sid(id);
  const r = await approveAndPay(
    d.svc,
    { orgId: ctx.orgId, userId: ctx.userId },
    shiftId,
    body.approved_hours,
  );
  return json(
    ApproveAndPayResponse.parse({
      slot: await slotDto(d.svc.db, ctx.orgId, shiftId),
      payment: await paymentDto(d.svc.db, shiftId),
      capture_cents: r.captureCents,
      worker_pay_cents: r.workerPayCents,
      platform_fee_cents: r.platformFeeCents,
    }),
  );
}

export async function postNoShow(d: ApiDeps, req: Request, id: string) {
  const ctx = await mgr(d, req);
  managerPost(d, req);
  await parseBody(req, z.object({}).strict());
  const shiftId = sid(id);
  const r = await markNoShow(d.svc, { orgId: ctx.orgId, userId: ctx.userId }, shiftId);
  return json(
    NoShowResponse.parse({
      slot: await slotDto(d.svc.db, ctx.orgId, shiftId),
      reoffered: r.reoffered,
    }),
  );
}

export async function postConfirmTimes(d: ApiDeps, req: Request, id: string) {
  const ctx = await mgr(d, req);
  managerPost(d, req);
  const body = await parseBody(req, ConfirmTimesRequest);
  const shiftId = sid(id);
  await managerConfirmTimes(d.svc, { orgId: ctx.orgId, userId: ctx.userId }, shiftId, {
    checkInAt: new Date(body.check_in_at),
    checkOutAt: body.check_out_at ? new Date(body.check_out_at) : undefined,
  });
  return json(ConfirmTimesResponse.parse({ slot: await slotDto(d.svc.db, ctx.orgId, shiftId) }));
}

// ---------------------------------------------------------------- M2: worker shift day (worker session only)
function shiftDay(slot: {
  id: string;
  status: string;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  actualHours: string | null;
}) {
  return ShiftDayResponse.parse({
    slot_id: slot.id,
    status: slot.status.toLowerCase(),
    check_in_at: slot.checkInAt?.toISOString() ?? null,
    check_out_at: slot.checkOutAt?.toISOString() ?? null,
    actual_hours: slot.actualHours === null ? null : Number(slot.actualHours),
  });
}

export async function postArrive(d: ApiDeps, req: Request, id: string) {
  assertSameOrigin(req, d.svc.config.appBaseUrl);
  const workerId = requireWorker(req.headers, d.sessionSecret, d.svc.now());
  if (!d.limiter.hit(`shiftday:${workerId}`, 30, 60_000)) throw new HttpError(429, 'rate_limited');
  await parseBody(req, z.object({}).strict());
  return json(shiftDay(await arrive(d.svc, workerId, sid(id))), { headers: WORKER_HEADERS });
}

export async function postFinish(d: ApiDeps, req: Request, id: string) {
  assertSameOrigin(req, d.svc.config.appBaseUrl);
  const workerId = requireWorker(req.headers, d.sessionSecret, d.svc.now());
  if (!d.limiter.hit(`shiftday:${workerId}`, 30, 60_000)) throw new HttpError(429, 'rate_limited');
  await parseBody(req, z.object({}).strict());
  return json(shiftDay(await finish(d.svc, workerId, sid(id))), { headers: WORKER_HEADERS });
}

// ---------------------------------------------------------------- sandbox Outbox
/** Manager-only testing aid: 404 outside the PayPal sandbox (checked first, so it does not reveal itself). */
export async function getOutbox(d: ApiDeps, req: Request) {
  if (d.paypalEnv !== 'sandbox') throw new HttpError(404, 'not_found');
  const ctx = await mgr(d, req);
  const items = await listOutbox(d.svc.db, ctx.orgId);
  return json(
    OutboxResponse.parse({
      items: items.map((i) => ({
        id: i.id,
        channel: i.channel,
        kind: i.kind,
        recipient: i.recipient,
        recipient_label: i.recipientLabel,
        created_at: i.createdAt.toISOString(),
        status: i.status,
        link: i.link,
      })),
    }),
  );
}

// ---------------------------------------------------------------- M2/G2: approvals list
export async function getApprovals(d: ApiDeps, req: Request) {
  const ctx = await mgr(d, req);
  const r = await listApprovals(d.svc, ctx.orgId);
  return json(
    ApprovalsResponse.parse({
      server_time: r.serverTime.toISOString(),
      fee_bps: r.feeBps,
      fixed_fee_cents: r.fixedFeeCents,
      items: r.items.map((i) => ({
        slot_id: i.slotId,
        slot_status: i.slotStatus.toLowerCase(),
        worker: { name: i.workerName, initials: i.workerInitials, avatar_tint: i.workerTint },
        role: i.role,
        venue_tz: i.venueTz,
        start_at: i.startAt.toISOString(),
        end_at: i.endAt.toISOString(),
        scheduled_hours: i.scheduledHours,
        check_in_at: i.checkInAt?.toISOString() ?? null,
        check_out_at: i.checkOutAt?.toISOString() ?? null,
        actual_hours: i.actualHours,
        approved_hours: i.approvedHours,
        rate_cents: i.rateCents,
        authorized_cents: i.authorizedCents,
        max_hours: i.maxHours,
        payment_status: i.paymentStatus,
        last_error: i.lastError,
        capture_reference: i.captureReference,
      })),
    }),
  );
}
