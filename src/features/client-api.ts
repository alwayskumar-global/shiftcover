import type {
  CreateGapRequest,
  CreateGapResponse,
  GapDetailResponse,
  MeResponse,
  ParseResultDto,
  RosterResponse,
  SlotDto,
  WorkerOfferDto,
} from '@/api/dto';

/** Thin typed fetch wrappers used by the client components. Same-origin, cookie-authenticated. */

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class NetworkFailure extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new NetworkFailure('network');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // empty body
  }
  return { status: res.status, body: body as T };
}

const post = (path: string, data: unknown = {}) =>
  call<never>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });

function ok<T>(r: { status: number; body: T }): T {
  if (r.status >= 200 && r.status < 300) return r.body;
  const e = (r.body as unknown as { error?: { code: string; message: string } })?.error;
  throw new ApiFailure(r.status, e?.code ?? 'error', e?.message ?? 'Request failed');
}

// ---- worker (token) ----
export const fetchOffer = async (token: string): Promise<WorkerOfferDto> =>
  (await call<WorkerOfferDto>(`/api/c/${encodeURIComponent(token)}`)).body;
export const claimOffer = async (token: string): Promise<WorkerOfferDto> =>
  (await post(`/api/c/${encodeURIComponent(token)}/claim`)).body as WorkerOfferDto;
export const declineOffer = async (token: string): Promise<WorkerOfferDto> =>
  (await post(`/api/c/${encodeURIComponent(token)}/decline`)).body as WorkerOfferDto;
export const resendLink = async (email: string) =>
  ok(await post('/api/offer-link/resend', { email }));

// ---- manager ----
export const fetchMe = async () => ok(await call<MeResponse>('/api/manager/me'));
export const fetchRoster = async (date?: string, days: 1 | 7 = 1) =>
  ok(
    await call<RosterResponse>(
      `/api/manager/roster?${new URLSearchParams({ ...(date ? { date } : {}), days: String(days) })}`,
    ),
  );
export const parseGap = async (text: string) =>
  ok(await post('/api/manager/gaps/parse', { text })) as ParseResultDto;
export const createGap = async (body: CreateGapRequest) =>
  ok(await post('/api/manager/gaps', body)) as CreateGapResponse;
export const fetchGap = async (id: string) =>
  ok(await call<GapDetailResponse>(`/api/manager/gaps/${id}`));
export const startOffering = async (id: string) =>
  ok(await post(`/api/manager/gaps/${id}/start-offering`)) as { slot: SlotDto };
export const stubAuthorize = async (id: string) =>
  ok(await post(`/api/manager/gaps/${id}/stub-authorize`));
export const widenRadius = async (id: string, search_radius_mi: number) =>
  ok(await post(`/api/manager/gaps/${id}/widen-radius`, { search_radius_mi }));
export const cancelGap = async (id: string, reason?: string) =>
  ok(await post(`/api/manager/gaps/${id}/cancel`, reason ? { reason } : {}));

// ---- M2 money (PayPal button path)
export const orderForGap = async (id: string) =>
  ok(await post(`/api/manager/gaps/${id}/order`)) as { order_id: string };
export const authorizeGap = async (id: string, orderId: string) =>
  ok(await post(`/api/manager/gaps/${id}/authorize`, { order_id: orderId }));

// ---- G2 worker My shifts (worker session cookie; no token in the URL)
export type WorkerShiftsDto = import('zod').infer<typeof import('@/api/dto').WorkerShiftsResponse>;
export type WorkerEarningsDto = import('zod').infer<
  typeof import('@/api/dto').WorkerEarningsResponse
>;
export type ApprovalsDto = import('zod').infer<typeof import('@/api/dto').ApprovalsResponse>;
export type ApproveAndPayDto = import('zod').infer<
  typeof import('@/api/dto').ApproveAndPayResponse
>;
export type ShiftDayDto = import('zod').infer<typeof import('@/api/dto').ShiftDayResponse>;

export const fetchWorkerShifts = async () => ok(await call<WorkerShiftsDto>('/api/w/shifts'));
export const fetchWorkerEarnings = async () =>
  ok(await call<WorkerEarningsDto>('/api/w/earnings'));
export const arriveShift = async (id: string) =>
  ok(await post(`/api/w/shifts/${id}/arrive`)) as ShiftDayDto;
export const finishShift = async (id: string) =>
  ok(await post(`/api/w/shifts/${id}/finish`)) as ShiftDayDto;

// ---- G2 manager approvals
export const fetchApprovals = async () => ok(await call<ApprovalsDto>('/api/manager/approvals'));
export const approveAndPay = async (id: string, approvedHours: number) =>
  ok(
    await post(`/api/manager/shifts/${id}/approve-and-pay`, { approved_hours: approvedHours }),
  ) as ApproveAndPayDto;
