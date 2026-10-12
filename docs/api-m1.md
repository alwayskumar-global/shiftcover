# M1 API (headless core loop)

All bodies are JSON. Money is integer cents (USD). Timestamps are ISO-8601 UTC. Every request and response
shape lives in [`src/api/dto.ts`](../src/api/dto.ts) (Zod); handlers are in [`src/api/handlers.ts`](../src/api/handlers.ts).

**Errors** always use `{ "error": { "code": string, "message": string } }`. Common codes: `unauthenticated` (401),
`forbidden` (403), `bad_origin` (403), `not_found` (404), `unsupported_media_type` (415), `invalid_request` (400),
`invalid_input` (422), `payment_not_authorized` / `invalid_state` (409), `rate_limited` (429).

**Auth**

- _Manager_: Better Auth session cookie (httpOnly, SameSite=Lax, Secure in production). Manager `POST`s also need
  `Origin` = our `APP_BASE_URL` and `Content-Type: application/json` (CSRF).
- _Worker_: the offer link token (`/c/<token>`) is the credential. `GET /api/c/<token>` sets an httpOnly
  `sc_worker` cookie (HMAC-signed, 12 h). `POST .../claim` requires `Origin` = `APP_BASE_URL`; if the cookie is present
  it must belong to the offer's worker.

Design-state references use the Claude Design screen states listed in PLAN.md 10.4/10.5 (the `design/g1/` inventory
pages were not available in the repo when M1 was built, so DTOs follow the plan's screen descriptions).

## Better Auth (`/api/auth/*`)

Mounted from `app/api/auth/[...all]/route.ts`. Sign-up is disabled; managers are provisioned by the seed/admin path.

| Endpoint                                               | Purpose                                                                                       | Limit  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------ |
| `POST /api/auth/sign-in/email` `{email,password}`      | password sign-in                                                                              | 5/min  |
| `POST /api/auth/sign-in/magic-link` `{email}`          | request a link; the link is written to `notifications` (channel `email`, kind `sign_in_link`) | 3/min  |
| `GET  /api/auth/magic-link/verify?token=`              | consume the link (single use, 10 min) and set the session                                     | 10/min |
| `POST /api/auth/sign-out`, `GET /api/auth/get-session` | standard                                                                                      | 60/min |

Screen: _Manager, login_ (all states: idle, submitting, error, link-sent).

## Manager

### `GET /api/manager/roster?date=YYYY-MM-DD`

Auth: manager. `date` is venue-local, default today.
Response `RosterResponse`: `{ date, timezone, venue{id,name}, summary{openGaps,offering,shiftsToday}, resources[], events[] }`.

- `resources[]`: workers `{id, kind:'worker', name, initials, roles[], reliabilityScore}`.
- `events[]`: slots overlapping the day `{id, resourceId|null, workerName|null, role, roleLabel, status, isGap, startDate, endDate, baseRateCents, offeredRateCents|null}`.
  `resourceId = null` means an open gap; the UI shows these on its "open gaps" row. `isGap` is true for OPEN, OFFERING, UNFILLED. Cancelled slots are included with `status: CANCELLED` (the UI may hide them).
  Errors: 401. Screen: _Manager, roster_ (Bryntum Scheduler data + summary strip).

### `POST /api/manager/gaps/parse`

Auth: manager (+CSRF). Request `{ text }` (3-500 chars). **Rules parser only** (`source: "rules"`); Gemini arrives in M3.
Response `ParsedCardDto`: `{ source, role, roleLabel, startAt, endAt, baseRateCents, baseRateSource: text|replaced_shift|missing, maxPremiumPct, maxPremiumSource: text|default, calledOutName, replacesSlotId, venueId, missing[], hold|null }`.
If the text names a worker who has a confirmed shift in that window ("Maria called in sick ..."), `replacesSlotId` is set and a missing rate is borrowed from that shift. `hold` is present only when the card is complete.
Errors: 400/415/422. Screen: _New gap, parsed card_ (states: complete, incomplete with `missing[]`).

### `POST /api/manager/gaps`

Auth: manager (+CSRF). Request `CreateGapRequest`: `{ venueId, role, startAt, endAt, baseRateCents, maxPremiumPct, replacesSlotId? }`.
Creates the slot OPEN and a payment `AUTH_PENDING_APPROVAL` holding the computed maximum authorization
(`hours x base x (1 + max premium) x (1 + platform fee)`, existing rounding rules). `replacesSlotId` cancels that shift
and the worker who held it is never offered the cover. Response 201 `CreateGapResponse`: `{ slot, hold, payment, card }`.
Errors: 400 (shape), 404 (venue/replaced slot not in your org), 422 (role, length, rate, premium).
Screen: _New gap, "Approve max cost"_ (hold amounts).

### `GET /api/manager/gaps/[id]`

Auth: manager (org-scoped; other orgs get 404). Response `GapDetailResponse`:
`{ slot{... venueName, worker|null}, waves[{wave, rateCents, sent, opened, claimed, expired, withdrawn, declined, sentAt}], offers[{id, workerId, workerName, wave, rateCents, status, expiresAt, openedAt, claimedAt}], payment{status, authorizedCents, capturedCents, workerPayCents, platformFeeCents}|null }`.
Screen: _Gap detail_ (wave timeline, offers list, money timeline).

### `POST /api/manager/gaps/[id]/start-offering`

Auth: manager (+CSRF). Requires payment `AUTHORIZED` (else 409 `payment_not_authorized`). Moves the slot to OFFERING and
enqueues `send_wave` (wave 1) and `fill_deadline`. Safe to repeat. Response `{ slot }`.

### `POST /api/manager/gaps/[id]/stub-authorize` (dev/test only)

Auth: manager (+CSRF). **404 unless `PAYMENTS_MODE=stub`**, which `env.ts` rejects in production. Marks the payment
`AUTHORIZED` with a fake authorization id and writes a ledger entry. Replaced by the real PayPal flow in M2.

## Worker

### `GET /api/c/[token]`

Auth: the token. **Never consumes the token and never writes.** Headers: `Referrer-Policy: no-referrer`,
`X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`; sets the `sc_worker` cookie for a valid offer.
Response `OfferViewResponse`: `{ state: available|claimed|taken|expired|withdrawn|invalid, offer: {role, roleLabel, venueName, startAt, endAt, rateCents, estimatedPayCents, distanceKm|null, expiresAt, wave} | null }`.
`invalid` answers 404. Rate limit 60/min/IP. Screen: _Worker, claim card_ (loading is client-side; all other states here).

### `POST /api/c/[token]/claim`

Auth: the token (+ cookie, if present, must match). CSRF: `Origin` must equal `APP_BASE_URL`; body `{}`.
Atomic first-claim-wins in one transaction; losers get `state: "taken"` (HTTP 200, never a 500). Same worker claiming again
returns `claimed`. Response `ClaimResponse` = `OfferViewResponse` + `slotId`. Rate limit 10/min/IP.
Screen: _Worker, claim card_, then _post-claim confirmation_.

### `GET /api/w/shifts`

Auth: `sc_worker` cookie (401 otherwise). Returns only the calling worker's own offers/shifts
`{ shifts[{offerId, offerStatus, rateCents, expiresAt, slotId, slotStatus, role, startAt, endAt, venueName, isMine}] }`.

## Jobs (pg-boss, worker process)

`send_wave {slotId, wave}`, `expire_offer {offerId}`, `fill_deadline {slotId}`, plus `db_heartbeat`, `process_webhook`
(stub), `reconcile_payments` (stub), `notify` (stub). All are idempotent (unique offers per slot/worker/wave, singleton
keys on follow-ups). Offer and sign-in links are delivered through the `Notifier` (Outbox rows in `notifications`).
