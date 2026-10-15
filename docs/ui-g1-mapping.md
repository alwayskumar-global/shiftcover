# Gate 1 UI mapping: screens and states to API fields

Every screen reads the public API shapes in [`api-m1.md`](api-m1.md) (the contract in `api-contract-10-6.md` plus the listed additive fields). No screen
holds a money figure of its own: amounts come from the API or are recomputed with the same integer functions
(`src/domain/money.ts`) from `GET /api/manager/me` config. Status styling goes through one table, `STATUS` in
[`roster-model.ts`](../src/features/manager/roster-model.ts). States below are the `/review` scene ids
([`src/review/fixtures.ts`](../src/review/fixtures.ts)).

## W1 claim card and W2 booked (`/c/[token]`, `ClaimExperience.tsx`)

Reads `GET /api/c/[token]` (never consumes the token); writes `POST .../claim`, `POST .../decline`, `POST /api/offer-link/resend`.
The token leaves the address bar after the first open (`history.replaceState` to `/c`, kept in `sessionStorage`).

| State (scene)               | Source                                                                 | Fields                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| available (`w1-available`)  | `state = available`                                                    | `role, venue_name, venue_area, distance_mi, start_at, end_at, venue_tz, hours, rate_cents, pay_total_cents, expires_at, server_time` |
| rate rising (`-rising`)     | `rate_cents > first_offered_rate_cents`                                | banner "Rate increased to ..." = `rate_cents`, `first_offered_rate_cents`, difference x `hours`                                      |
| urgent (`-urgent`)          | `expires_at - server_time <= 120 s`                                    | countdown runs on `server_time`, not the device clock                                                                                |
| payout not set up           | `payout_ready = false`                                                 | payout notice                                                                                                                        |
| other open offers           | `other_open_offers_count > 0`                                          | link line on the taken screen                                                                                                        |
| claiming / claim error      | `POST .../claim` in flight / network failure                           | button busy, then "Your claim didn't go through"; claim lock prevents a double submit                                                |
| booked, W2 (`w1-booked`)    | `state = claimed`                                                      | `role, venue_name, venue_address, venue_lat/lng` (Maps link), `start_at, end_at, venue_tz, hours, rate_cents, pay_total_cents`       |
| taken / expired / withdrawn | `state` of the same name (an expired countdown also flips locally)     | `other_open_offers_count`; resend-link form on expired/invalid                                                                       |
| declined                    | `state = declined` after `POST .../decline` (two-step "Not available") | none                                                                                                                                 |
| invalid (404)               | `state = invalid`                                                      | all other fields `null`; resend form                                                                                                 |
| could not load              | fetch rejected                                                         | retry                                                                                                                                |

## M1 sign in (`/app/login`, `LoginExperience.tsx`)

Better Auth endpoints: `POST /api/auth/sign-in/email`, `POST /api/auth/sign-in/magic-link`. States: default, validation, wrong
password (401, also shown for 429), signing in, link form / sending / sent. `proxy.ts` redirects `/app/*` without a session cookie
to here; the console layout re-checks the session on the server.

## M2 roster (`/app/roster`, `RosterScreen.tsx`, `RosterScheduler.tsx`)

Reads `GET /api/manager/me` (shell, venue) and `GET /api/manager/roster?date&days` every 3 s while the tab is visible.

| Element                     | Field                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Venue and user in nav       | `me.venue.name/area`, `me.manager.name`                                                                                                     |
| Summary tiles               | `summary.open_gaps, offering, shifts_today`; pending approval counts `events[].status = pending_approval or settling`                       |
| Date label, Today/prev/next | `date`, `end_date`, `timezone`, `server_time` (today and the "now" line)                                                                    |
| Rows                        | `resources[]` (`name, role, initials, avatar_tint`); a gap sits on the replaced worker's row (`replaces_worker.id`) or an "Open shifts" row |
| Blocks                      | `events[]`: `status` -> class and icon via `STATUS`, `start_at/end_at` shown in venue wall-clock, `worker.name`, `role`                     |
| Block click                 | open, offering, unfilled -> `/app/gaps/[id]`; others select only                                                                            |
| States                      | populated (`m2-loaded`, `-open-gap`), no gaps (`-no-gaps`, banner), loading (`-loading`), error (`-error`)                                  |

## M3 report a gap (`/app/gaps/new`, `ReportGapScreen.tsx`)

| Element / state                        | Source                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Parse (`m3-parsed`)                    | `POST /api/manager/gaps/parse`: `role, date, start, end, base_rate_cents, base_rate_source, max_premium_pct, replaces_slot_id, gap_reason` |
| "From your note" / "Role default" tags | field filled by the parser / `base_rate_source`                                                                                            |
| Can't read it (alert)                  | 422 `parse_failed`                                                                                                                         |
| Validation (`m3-validation`)           | client rules with the design's messages; premium bounds `me.config.premium_min_pct/max_pct`; date `max_days_ahead`                         |
| Money table, ladder, hold              | integer math from form + `me.config.platform_fee_pct`: `maxAuthorization` (same function the server uses); wave 2 = base x (1 + premium/2) |
| Confirmed (`m3-confirmed`)             | client state only; no gap exists yet, so editing after confirming creates nothing                                                          |
| PayPal slot                            | `#paypal-button-container` reserved for the SDK (M2). In stub mode and non-production builds only: a labelled test button                  |
| Hold placed (`m3-approved`)            | stub path: `POST /api/manager/gaps` -> `.../stub-authorize` -> `.../start-offering`; then links to `/app/gaps/[id]`                        |
| Hold failed                            | any step rejects: "PayPal couldn't place the hold"; retry reuses the created gap                                                           |

## M4 gap detail (`/app/gaps/[id]`, `GapDetailScreen.tsx`)

Reads `GET /api/manager/gaps/[id]` every 3 s while visible. Actions: `POST .../cancel`, `POST .../widen-radius`; in stub mode
`.../stub-authorize` + `.../start-offering` for an `awaiting_approval` payment.

| Element               | Field                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header, meta          | `slot.role, venue_name, start_at, end_at, venue_tz, hours, replaces_worker.name`                                                                                              |
| Status badge          | `slot.status` via `STATUS`                                                                                                                                                    |
| Money badge           | `payment.status`: authorized -> "$X on hold", voided -> "Hold released", captured/paid -> "Charged", capture_declined, payout_failed, awaiting_approval/none -> "Hold needed" |
| Key facts             | current rate = last `waves[].rate_cents` / `offered_rate_cents` / base; cap = `max_premium_pct` and `maxRateCents`; `fill_by`; `worker.name`                                  |
| Banner                | `slot.status`, `current_wave`, `offers[]` (claimed), `payment.status`                                                                                                         |
| A, wave timeline      | `waves[]` (`wave, sent_at, audience_count, rate_cents, capped`) + counts from `offers[]` by `wave`/`status`; unsent waves from the base rate and the wave plan                |
| B, offers             | `offers[]`: `worker, wave, status`, time = the matching `*_at` of the status, relative to `server_time`                                                                       |
| C, money timeline     | `payment`: `authorized_cents`, `captured_cents`, `worker_pay_cents`, `platform_fee_cents`, `paypal_references` (copy chips)                                                   |
| Recovery alert        | `payment.status` capture_declined / payout_failed (copy reference; retry arrives with M2)                                                                                     |
| Widen the radius      | `widen.radius_mi / max_radius_mi`; shown for `unfilled`; real call                                                                                                            |
| Cancel dialog         | real call; allowed while open, offering, confirmed                                                                                                                            |
| Widen / Raise the cap | present but inert: needs the extra PayPal hold (M2); the dialog is not built in Gate 1                                                                                        |
| States (scenes)       | `m4-open, -offering, -filled, -in-progress, -pending-approval, -capture-declined, -payout-failed, -unfilled, -cancelled, -cancel-dialog`                                      |
