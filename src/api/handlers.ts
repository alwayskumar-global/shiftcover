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
import { maxAuthorization } from '../domain/money';
import { isShiftRole, type ShiftRole } from '../domain/roles';
import { localDateString, localDayBounds, localParts } from '../lib/time';
import { rulesGapParser } from '../llm/fallback';
import { claimOffer, viewOffer } from '../services/claim';
import { createGap, startOffering } from '../services/gaps';
import { stubAuthorize } from '../services/payments-stub';
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
import { toWorkerOfferDto } from './adapters';
import {
  ClaimResponse,
  CreateGapRequest,
  CreateGapResponse,
  GapDetailResponse,
  ParseGapRequest,
  ParseResultDto,
  RosterQuery,
  RosterResponse,
  StartOfferingResponse,
  StubAuthorizeResponse,
  WorkerOfferDto,
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

// ---------------------------------------------------------------- manager: roster
export async function getRoster(d: ApiDeps, req: Request) {
  const ctx = await mgr(d, req);
  const q = RosterQuery.parse({ date: new URL(req.url).searchParams.get('date') ?? undefined });
  const data = await roster(d.svc.db, ctx.orgId, q.date, d.svc.now());
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
  if (!p) throw new HttpError(422, 'unparseable');

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

  // Smallest safe defaults: borrow the replaced shift's rate and role; premium falls back to the org default.
  const role: ShiftRole | null =
    p.role ?? (replaced && isShiftRole(replaced.role) ? replaced.role : null);
  const baseRateCents = p.baseRateCents ?? replaced?.baseRateCents ?? null;
  const missing = p.missing
    .filter(
      (m) => !(m === 'baseRate' && baseRateCents !== null) && !(m === 'role' && role !== null),
    )
    .map((m) => (m === 'baseRate' ? ('base_rate' as const) : m));
  const maxPremiumPct = p.maxPremiumPct ?? d.maxPremiumPctDefault;
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
      max_premium_pct: maxPremiumPct,
      worker_pay_at_cap_cents: hold?.maxWorkerPayCents ?? null,
      platform_fee_cents: hold?.maxFeeCents ?? null,
      total_hold_cents: hold?.authorizedCents ?? null,
      missing,
      replaces_slot_id: replaced?.id ?? null,
      called_out_name: p.calledOutName,
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
    },
  );
  const payment = await paymentDto(d.svc.db, r.slot.id);
  return json(
    CreateGapResponse.parse({
      slot: await slotDto(d.svc.db, ctx.orgId, r.slot.id),
      payment,
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
const slotId = (id: string) => {
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) throw new HttpError(404, 'not_found');
  return uuid.data;
};

export async function getGap(d: ApiDeps, req: Request, id: string) {
  const ctx = await mgr(d, req);
  return json(GapDetailResponse.parse(await gapDetail(d.svc.db, ctx.orgId, slotId(id))));
}

export async function postStartOffering(d: ApiDeps, req: Request, id: string) {
  const ctx = await mgr(d, req);
  managerPost(d, req);
  const sid = slotId(id);
  await startOffering(d.svc, { orgId: ctx.orgId, userId: ctx.userId }, sid);
  return json(StartOfferingResponse.parse({ slot: await slotDto(d.svc.db, ctx.orgId, sid) }));
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

export async function postClaim(d: ApiDeps, req: Request, token: string) {
  assertSameOrigin(req, d.svc.config.appBaseUrl); // CSRF
  if (!d.limiter.hit(`claim:${clientIp(req.headers)}`, 10, 60_000))
    throw new HttpError(429, 'rate_limited');
  await parseBody(req, z.object({}).strict());
  const cookieWorker = readWorkerSession(
    parseCookie(req.headers.get('cookie'), WORKER_COOKIE),
    d.sessionSecret,
    d.svc.now(),
  );
  const result = await claimOffer(d.svc, token, { expectedWorkerId: cookieWorker ?? undefined });
  return json(ClaimResponse.parse(toWorkerOfferDto(result)), {
    status: result.state === 'invalid' ? 404 : 200,
    headers: WORKER_HEADERS,
  });
}

export async function getWorkerShifts(d: ApiDeps, req: Request) {
  const workerId = requireWorker(req.headers, d.sessionSecret, d.svc.now());
  const shifts = await workerShifts(d.svc.db, workerId);
  return json(
    WorkerShiftsResponse.parse({
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
      })),
    }),
    { headers: WORKER_HEADERS },
  );
}
