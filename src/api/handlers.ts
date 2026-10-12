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
import { ROLE_LABELS, isShiftRole, type ShiftRole } from '../domain/roles';
import { addDaysToDateString, localDateString, localDayBounds } from '../lib/time';
import { rulesGapParser } from '../llm/fallback';
import { claimOffer, viewOffer, type OfferView } from '../services/claim';
import { createGap, startOffering } from '../services/gaps';
import { stubAuthorize } from '../services/payments-stub';
import { findRecognisedSlot, gapDetail, primaryVenue, roster } from '../services/read-models';
import { workerShifts } from '../services/worker-data';
import { ServiceError, type ServiceDeps } from '../services/types';
import {
  ClaimResponse,
  CreateGapRequest,
  CreateGapResponse,
  GapDetailResponse,
  OfferViewResponse,
  ParseGapRequest,
  ParsedCardDto,
  RosterQuery,
  RosterResponse,
  StartOfferingResponse,
  StubAuthorizeResponse,
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
  const missing = p.missing.filter(
    (m) => !(m === 'baseRate' && baseRateCents !== null) && !(m === 'role' && role !== null),
  );
  const maxPremiumPct = p.maxPremiumPct ?? d.maxPremiumPctDefault;
  const complete = role && p.startAt && p.endAt && baseRateCents !== null;
  const minutes =
    p.startAt && p.endAt ? Math.round((p.endAt.getTime() - p.startAt.getTime()) / 60_000) : 0;
  const hold = complete
    ? maxAuthorization({
        baseRateCents,
        maxPremiumPct,
        minutes,
        feeBps: d.svc.config.platformFeeBps,
      })
    : null;

  const card = ParsedCardDto.parse({
    source: 'rules',
    role,
    roleLabel: role ? ROLE_LABELS[role] : null,
    startAt: p.startAt?.toISOString() ?? null,
    endAt: p.endAt?.toISOString() ?? null,
    baseRateCents,
    baseRateSource: p.baseRateCents !== null ? 'text' : replaced ? 'replaced_shift' : 'missing',
    maxPremiumPct,
    maxPremiumSource: p.maxPremiumPct !== null ? 'text' : 'default',
    calledOutName: p.calledOutName,
    replacesSlotId: replaced?.id ?? null,
    venueId: venue.id,
    missing,
    hold: hold && { currency: 'USD', ...hold },
  });
  return json(card);
}

// ---------------------------------------------------------------- manager: create gap
export async function postCreateGap(d: ApiDeps, req: Request) {
  const ctx = await mgr(d, req);
  managerPost(d, req);
  const body = await parseBody(req, CreateGapRequest);
  const startAt = new Date(body.startAt);
  const endAt = new Date(body.endAt);
  const r = await createGap(
    d.svc,
    { orgId: ctx.orgId, userId: ctx.userId },
    {
      venueId: body.venueId,
      role: body.role,
      startAt,
      endAt,
      baseRateCents: body.baseRateCents,
      maxPremiumPct: body.maxPremiumPct,
      replacesSlotId: body.replacesSlotId,
    },
  );
  const detail = await gapDetail(d.svc.db, ctx.orgId, r.slot.id);
  return json(
    CreateGapResponse.parse({
      slot: detail.slot,
      hold: { currency: 'USD', ...r.hold },
      payment: detail.payment,
      card: {
        role: body.role,
        roleLabel: ROLE_LABELS[body.role],
        startAt: body.startAt,
        endAt: body.endAt,
        durationMinutes: r.minutes,
        baseRateCents: body.baseRateCents,
        maxPremiumPct: body.maxPremiumPct,
      },
    }),
    { status: 201 },
  );
}

// ---------------------------------------------------------------- manager: gap detail + actions
export async function getGap(d: ApiDeps, req: Request, id: string) {
  const ctx = await mgr(d, req);
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) throw new HttpError(404, 'not_found');
  return json(GapDetailResponse.parse(await gapDetail(d.svc.db, ctx.orgId, uuid.data)));
}

export async function postStartOffering(d: ApiDeps, req: Request, id: string) {
  const ctx = await mgr(d, req);
  managerPost(d, req);
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) throw new HttpError(404, 'not_found');
  await startOffering(d.svc, { orgId: ctx.orgId, userId: ctx.userId }, uuid.data);
  const detail = await gapDetail(d.svc.db, ctx.orgId, uuid.data);
  return json(StartOfferingResponse.parse({ slot: detail.slot }));
}

/** Development/test only. 404 unless PAYMENTS_MODE=stub, which env.ts refuses in production. */
export async function postStubAuthorize(d: ApiDeps, req: Request, id: string) {
  if (d.paymentsMode !== 'stub' || d.production) throw new HttpError(404, 'not_found');
  const ctx = await mgr(d, req);
  managerPost(d, req);
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) throw new HttpError(404, 'not_found');
  // Org scoping: the slot must belong to the manager's organisation.
  await gapDetail(d.svc.db, ctx.orgId, uuid.data);
  await stubAuthorize(d.svc.db, d.paymentsMode, uuid.data, `user:${ctx.userId}`);
  const detail = await gapDetail(d.svc.db, ctx.orgId, uuid.data);
  return json(StubAuthorizeResponse.parse({ payment: detail.payment }));
}

// ---------------------------------------------------------------- worker: offer link
const WORKER_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

function offerResponse(view: OfferView & { slotId?: string }, withSlot: boolean) {
  const { offer, state } = view;
  const dto = offer
    ? {
        role: offer.role,
        roleLabel: offer.roleLabel,
        venueName: offer.venueName,
        startAt: offer.startAt,
        endAt: offer.endAt,
        rateCents: offer.rateCents,
        estimatedPayCents: offer.estimatedPayCents,
        distanceKm: offer.distanceKm,
        expiresAt: offer.expiresAt,
        wave: offer.wave,
      }
    : null;
  return withSlot
    ? ClaimResponse.parse({ state, offer: dto, slotId: view.slotId ?? null })
    : OfferViewResponse.parse({ state, offer: dto });
}

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
  return json(offerResponse(view, false), {
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
  const status = result.state === 'invalid' ? 404 : 200;
  return json(offerResponse(result, true), { status, headers: WORKER_HEADERS });
}

export async function getWorkerShifts(d: ApiDeps, req: Request) {
  const workerId = requireWorker(req.headers, d.sessionSecret, d.svc.now());
  const shifts = await workerShifts(d.svc.db, workerId);
  return json(WorkerShiftsResponse.parse({ shifts }), { headers: WORKER_HEADERS });
}
