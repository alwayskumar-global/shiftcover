# M1 API (headless core loop)

Public JSON follows **PLAN.md Section 10.6 exactly**: snake_case fields, lowercase status values, money as integer
cents (USD), timestamps ISO-8601 UTC. DTOs live in [`src/api/dto.ts`](../src/api/dto.ts) (Zod, `.strict()`), the
internal-to-public mapping in [`src/api/adapters.ts`](../src/api/adapters.ts) and
[`src/services/read-models.ts`](../src/services/read-models.ts). `test/contract-10-6.test.ts` reads Section 10.6 from
PLAN.md and fails if a DTO drifts or gains an unlisted field. Internal code keeps camelCase/UPPERCASE; only the
adapters produce the public shape.

**Errors** always use `{ "error": { "code": string, "message": string } }`: `unauthenticated` 401, `forbidden` /
`bad_origin` 403, `not_found` 404, `unsupported_media_type` 415, `invalid_request` 400, `invalid_input` 422,
`payment_not_authorized` / `invalid_state` 409, `rate_limited` 429.

**Auth**

- _Manager_: Better Auth session cookie (httpOnly, SameSite=Lax, Secure in production). Manager `POST`s also need
  `Origin` = `APP_BASE_URL` and `Content-Type: application/json` (CSRF).
- _Worker_: the offer link token is the credential. `GET /api/c/<token>` sets an httpOnly `sc_worker` cookie
  (HMAC-signed, 12 h). `POST .../claim` requires `Origin` = `APP_BASE_URL`; if the cookie is present it must belong to the
  offer's worker.

## Shared shapes (Section 10.6)

- **Slot**: `id, role, venue_name, venue_area, start_at, end_at, hours, status, worker {id, name, role} | null,
base_rate_cents, max_premium_pct, offered_rate_cents, fill_by`. `status` is one of planned, open, offering, confirmed,
  in_progress, pending_approval, settling, settled, unfilled, cancelled, no_show. `role` is the role id
  (`line_cook`, ...); display labels come from `src/domain/roles.ts`. `worker.role` is the worker's primary role.
  `hours` is decimal (7.5).
- **Offer**: `id, worker {name, role}, wave (1-3), rate_cents, status, sent_at, opened_at, claimed_at, expires_at`;
  status: sent, opened, claimed, declined, expired, withdrawn.
- **Wave summary**: `wave, sent_at, audience_count, rate_cents, capped`. `capped` is true when the slot's
  `max_premium_pct` clamped the wave's planned premium (+0/+10/+20 %).
- **Payment**: `status, authorized_cents, captured_cents, worker_pay_cents, platform_fee_cents,
paypal_references {order, authorization, capture, payout}, last_error`. Status: none, awaiting_approval, authorized,
  captured, payout_pending, paid, voided, capture_declined, payout_failed. `paypal_references.payout` is the payout batch id.
- **Worker-facing offer**: `role, venue_name, venue_area, start_at, end_at, hours, distance_mi, rate_cents,
pay_total_cents, expires_at, state`. For `invalid` every field except `state` is `null`.
  `pay_total_cents` is the full-shift pay at this rate; `distance_mi` is straight-line miles from the worker's home.

## Manager

### `GET /api/manager/roster?date=YYYY-MM-DD`

Auth: manager. `date` is venue-local, default today. Response: `{ date, timezone, resources[], events[], summary }`.
`resources[]` = `{id, name, role, initials}`; `events[]` = **Slot** (`worker = null` is an open gap; cancelled slots are included with
`status: "cancelled"`); `summary` = `{open_gaps, offering, shifts_today}`. Screen: _Manager, roster_.

### `POST /api/manager/gaps/parse`

Auth: manager (+CSRF). Request `{ text }` (3-500 chars). Rules parser only; Gemini arrives in M3.
Response (Section 10.6 _Parse result_): `source ("rules"), role, date (YYYY-MM-DD), start (HH:MM), end (HH:MM), venue {id, name},
base_rate_cents, max_premium_pct, worker_pay_at_cap_cents, platform_fee_cents, total_hold_cents` plus the additive fields below.
Money fields are `null` until role, times and rate are known. If the text names a worker with a confirmed shift in that window,
`replaces_slot_id` is set and a missing rate is borrowed from that shift.

### `POST /api/manager/gaps`

Auth: manager (+CSRF). Request: `{ venue_id, role, start_at, end_at, base_rate_cents, max_premium_pct, replaces_slot_id? }` (unknown keys are rejected).
Response 201: `{ slot: Slot, payment: Payment, hold: {worker_pay_at_cap_cents, platform_fee_cents, total_hold_cents} }`.
The hold is `hours x base x (1 + max premium) x (1 + platform fee)` with the existing rounding. Errors: 400, 404 (venue or replaced slot
not in your org), 422.

### `GET /api/manager/gaps/[id]`

Auth: manager (org-scoped; other orgs get 404). Response `{ slot: Slot, waves: Wave summary[], offers: Offer[], payment: Payment | null }`.

### `POST /api/manager/gaps/[id]/start-offering`

Auth: manager (+CSRF). Requires payment `authorized` (else 409 `payment_not_authorized`). Moves the slot to offering and
dispatches wave 1 and the fill deadline (recoverable, see Jobs). Safe to repeat. Response `{ slot }`.

### `POST /api/manager/gaps/[id]/stub-authorize` (dev/test only)

**404 unless `PAYMENTS_MODE=stub`** (env validation rejects that in production). Response `{ payment }`.

## Worker

### `GET /api/c/[token]`

Never consumes the token and never writes. Headers: `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`,
`Cache-Control: no-store`; sets `sc_worker` for a valid offer. Response: **Worker-facing offer** with
`state`: available, taken, expired, withdrawn, invalid (404) and the additive `claimed`. Rate limit 60/min/IP.

### `POST /api/c/[token]/claim`

CSRF: `Origin` = `APP_BASE_URL`, body `{}`. Atomic first-claim-wins; the response is the Worker-facing offer with the _final_ state:
`claimed` (this worker won, or won earlier), `taken` (another worker won), `expired`, `withdrawn` (deadline or cancellation). Never a 500.
Rate limit 10/min/IP.

### `GET /api/w/shifts` (not a Gate 1 screen; not itemised in 10.6)

Auth: `sc_worker` cookie. `{ shifts: [{offer_id, offer_status, rate_cents, expires_at, slot_id, slot_status, role, start_at, end_at, venue_name, is_mine}] }`
for the calling worker only.

## Deviations from Section 10.6 (all additive, none removes or renames a listed field)

| Where                       | Addition                                                                 | Why                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Worker-facing offer `state` | extra value `claimed`                                                    | PLAN 10.5 lists _claimed_ as a claim-card state; 10.6's state list omits it                           |
| Parse result                | `missing[]`, `replaces_slot_id`, `called_out_name`, `start_at`, `end_at` | the manager must see what is incomplete; creating the gap needs the replaced shift and exact instants |
| Roster                      | top-level `date`, `timezone`                                             | UTC timestamps need the venue day and zone to render                                                  |
| Payment `status`            | `PAYOUT_UNCLAIMED` and `RETURNED` (DB) map to `payout_failed`            | 10.6 does not list them; lossy until the contract does                                                |
| Envelopes                   | `{slot, payment, hold}`, `{slot}`, `{payment}`, `{shifts}` wrappers      | 10.6 defines shapes, not endpoint envelopes                                                           |
| Schema                      | `venues.area` column (migration 0006)                                    | source for `venue_area`; empty string when unset                                                      |

## Jobs (pg-boss, worker process)

`send_wave {slotId, wave}`, `expire_offer {offerId}`, `fill_deadline {slotId}`, `recover_dispatch` (every minute),
`db_heartbeat`, `process_webhook` (stub), `reconcile_payments` (stub), `notify` (stub). All are idempotent.
`recover_dispatch` re-dispatches any offering slot whose `send_wave`/`fill_deadline` was never enqueued (for example
`startOffering` committed and the process stopped before dispatch).
