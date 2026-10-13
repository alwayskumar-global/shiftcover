# ShiftCover Pay: Build Plan v0.5

PayPal AI Hackathon entry. Submission deadline **Nov 12, 2026 12:00 PM PST (= Nov 13, 01:30 AM IST)**. Target submit: **Nov 11 evening IST**.
Plan date: Oct 11, 2026. Build window: 31 days.
Repo: https://github.com/alwayskumar-global/shiftcover (**private now, public at submission**).
Hackathon: https://paypalaihackathon.devpost.com/

---

## Rules for the coding agent (read first; `CLAUDE.md` is gitignored, so these live here)

1. **Follow this file.** Do not change a locked decision (Section 0) or add scope beyond Section 3 "Must" and "Should". Ask Kumar before any architectural fork.
2. **Never design UI on your own.** The visual UI comes from Kumar (built in Claude Design). Work headless until a **UI Gate** (Section 10) opens, then stop and request the UI using the template there. Do not invent layouts, styles, colors, copy, icons, or screens.
3. **Never commit secrets.** `.env*` and `CLAUDE.md` are gitignored. Only `.env.example` is committed. Never paste a key into a file, log, issue, or commit message.
4. **Sandbox only.** Never call PayPal production endpoints. USD only.
5. **LLM spend guardrails are mandatory** (Section 9.3). No loop, job, or webhook handler may call the LLM unguarded.
6. **Small commits, green tests.** Run the acceptance tests (Section 14) as they become relevant.
7. If blocked on UI, secrets, or a decision, say so and re-sequence headless work. Do not fill the gap with improvised UI.
8. **Supabase is Postgres only** (Section 6A). Do not install `@supabase/supabase-js`, use Supabase Auth, Storage, Realtime, or Edge Functions, or use any anon, publishable, or service-role key. Schema changes go only through Drizzle migrations. If the Supabase MCP is available to you, use it read-only (advisors, list tables, logs); never `apply_migration` or `execute_sql` for schema or data changes. Never use the transaction pooler (port 6543).

---

## 0. Decisions

| ID | Decision | Status |
|----|----------|--------|
| A1 | Money model: **authorize, partial capture, instant payout**. Employer approves a max-cost PayPal authorization when a gap is posted; on completion we capture the actual amount, then pay the worker via Payouts. | **Confirmed** |
| A2 | Demo vertical: **hospitality** (restaurants, cafes, catering, event crews). | **Confirmed** |
| A3 | Manager roster uses **Bryntum Scheduler** (public trial npm packages). Wrapper: `@bryntum/scheduler-react` (no Vue). | **Confirmed** |
| A4 | One **Next.js (App Router, React, TypeScript)** app, **Postgres on Supabase** (database only, Section 6A), jobs via **pg-boss**. Host the web service and background worker on **Render**. | **Confirmed** |
| A5 | **No WhatsApp or SMS.** Notifications: in-app + email + Web Push behind a `Notifier` interface. Demo mode has an in-app **Outbox**. | Locked |
| A6 | **Sandbox only, USD only.** Payout recipients use `EMAIL` (PHONE is unsupported in sandbox). | Locked |
| A7 | License **Apache-2.0**, visible in repo About at submission. | Locked |
| A8 | **UI is supplied by Kumar from Claude Design**, delivered at three gates. The agent builds headless until each gate opens. | **Confirmed** |
| A9 | **AI provider: Google Gemini API** (Kumar's AI Studio account, USD 50 balance). **One model for every component: `gemini-3.5-flash-lite`** (cheapest). Strict spend guardrails (Section 9). | **Confirmed** |
| A10 | `CLAUDE.md` is **gitignored and never committed**. | **Confirmed** |
| A11 | Repo is **private until submission**, then flipped public after the pre-flip checklist (Section 15). | **Confirmed** |
| A12 | **WhatsApp, option B only:** per-worker offer links that the manager shares by hand from the sandbox Outbox (a `wa.me` deep link with the message pre-filled). No WhatsApp API or server-side sending; links are never logged or stored by the share button. Refines A5 (no automated WhatsApp or SMS). | **Confirmed** |
| A13 | **Widen the cap is deferred.** The control is shown disabled ("Coming soon"); no dialog and no API call until it is built. | **Confirmed** |
| A14 | **Gemini intake is planned after the demo.** The running app uses the rules parser only; no Gemini call is made. See `docs/after-demo.md`. | **Confirmed** |

---

## 1. Product

**One-liner:** When a shift gap appears, ShiftCover Pay fills it fast, guarantees the pay up front, and pays the worker the moment the shift is approved.

**Two surfaces, one backend:**
1. **Manager Console** (desktop-first, responsive, real login): plan the roster, report gaps, watch fills, approve hours, see money.
2. **Worker App** (mobile-first PWA, passwordless magic link): get offers, claim in one tap, check in and out, see earnings.

**Judging map (equal weights):**

| Criterion | What we show |
|-----------|--------------|
| Technological Implementation | Authorize, partial capture, Payouts, signed webhooks, idempotency, atomic claim, reconciliation, hybrid AI (code decides, LLM explains) |
| Design | One-tap claim card, live roster, money timeline per shift (design supplied via Claude Design) |
| Potential Impact | Last-minute-gap and no-show cost in hospitality; workers wait for pay today |
| Innovation | Pay guarantee as the lever for fill rate; surge bounded by an employer-set cap |
| Presentation | One story: gap at 6:40 AM, filled in minutes, worker paid at 3:05 PM |

---

## 2. Roles, access, routes

| Surface | Auth | Routes |
|---------|------|--------|
| Manager Console | Email + password or magic link (Auth.js or Better Auth). Real session. | `/app/roster`, `/app/gaps/new`, `/app/gaps/[id]`, `/app/workers`, `/app/money`, `/app/settings` |
| Worker App | **Private tokenized link** upgrading to an httpOnly session cookie. No password. | `/c/[token]`, `/w`, `/w/earnings`, `/w/profile` |
| Public | None | `/`, `/demo` (only when `DEMO_MODE=true`) |
| Webhooks | PayPal signature | `POST /api/webhooks/paypal` |
| Dev harness | Dev only | `/dev/*` (Section 10.2; excluded from production builds) |

**Magic link rules (non-negotiable):**
- GET renders only; it never consumes the token (email scanners prefetch URLs).
- The claim is a **POST** with CSRF protection; that is where the slot is reserved and the token consumed.
- Store only `sha256(token + CLAIM_TOKEN_PEPPER)`. Token = 256-bit random, short expiry (default 15 min), bound to one `offer_id`.
- After first valid open: set session cookie, redirect to a clean URL so the token leaves the address bar.
- `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, no third-party scripts on worker pages.
- Changing the payout email requires an emailed OTP plus a notice to the old address.

---

## 3. Scope

**Must (P0):**
1. Manager login, venue, roles, worker directory (seeded plus invite by email).
2. Roster in Bryntum Scheduler; open gaps highlighted.
3. Gap intake: structured form plus natural-language box.
4. Candidate filtering (hard constraints in code) and ranking.
5. Offer waves with expiry; worker claim card; **atomic first-claim-wins**.
6. PayPal: approve and authorize max cost, capture actual, payout, webhooks, ledger.
7. Check-in/out; manager approve-and-pay.
8. Notifications (in-app, email, Web Push) and the demo Outbox.
9. Demo mode: seeded data, persona switcher, fast-clock controls.

**Should (P1):** surge within cap; no-show path with void and re-offer; reliability score and "why this worker"; reconciliation job.

**Cut:** payroll and tax, multi-venue, SMS, WhatsApp, native apps, worker self-signup beyond invite, vaulted PayPal pre-approval (stretch only if Payouts and authorize are stable by Oct 26), disputes.

---

## 4. Core flows

### A. Plan the roster
Manager opens `/app/roster` (Bryntum Scheduler: resources = workers, events = shifts). Creating or dragging a shift writes `shift_slots`. A slot with no worker is a planned open slot.

### B. Report a gap and fill it
1. Manager types or fills the form. The LLM parses text into a structured gap (role, start, end, venue, base rate, max premium %). Manager confirms the parsed card.
2. **Max authorization** = `hours * base_rate * (1 + max_premium) * (1 + platform_fee)`.
3. Manager approves via the PayPal button (**intent AUTHORIZE**). Server authorizes the order and stores `authorization_id`. Slot becomes `OFFERING`.
4. Offer engine runs waves (Section 8). Each offer creates a worker-specific signed link and notifications.
5. Worker opens the link, sees the claim card, taps **Claim**. Server does the atomic claim; others see "Taken".
6. Slot becomes `CONFIRMED`; the roster updates live.

### C. Shift day
Worker taps **I've arrived** (optional geolocation within radius; fallback manager confirm), then **Finished**. Slot becomes `PENDING_APPROVAL`. Manager taps **Approve and pay** (hours adjustable within the authorized cap).

### D. Settlement
1. `POST /v2/payments/authorizations/{id}/capture` with the actual amount, `final_capture: true`, `invoice_id`, `PayPal-Request-Id`.
2. On capture success, create a Payouts batch to the worker (`recipient_type: EMAIL`, deterministic `sender_batch_id`).
3. Webhooks plus reconciliation advance the ledger to `PAID`. Worker app shows "Paid" with the PayPal reference.

### E. Failure paths (implement and test all)
| Case | Behavior |
|------|----------|
| Nobody claims by deadline | Slot `UNFILLED`, void authorization, notify manager, offer to widen cap or radius |
| Two workers claim at once | One wins (DB constraint); the other gets "Taken" |
| Worker cancels after claim | Slot back to `OFFERING`, new wave immediately, reliability penalty |
| No-show | Manager marks no-show; void authorization (no capture); auto re-offer if time remains |
| Capture declined or pending | Show state; block payout; alert manager |
| Payout item `FAILED` / `UNCLAIMED` / `RETURNED` / `ONHOLD` / `BLOCKED` | Ledger shows exact state and reason; retry path for retryable errors; notify manager and worker |
| Authorization voided or expired | Detect via webhook or reconcile; require a fresh approval |
| Webhook missed or delayed | Reconciliation job polls non-terminal payments |

---

## 5. State machines

**Slot:** `PLANNED` to `OPEN` to `OFFERING` to `CONFIRMED` to `IN_PROGRESS` to `PENDING_APPROVAL` to `SETTLING` to `SETTLED`. Side states: `UNFILLED`, `CANCELLED`, `NO_SHOW`.

**Offer:** `SENT` to `OPENED` to (`CLAIMED` | `DECLINED` | `EXPIRED` | `WITHDRAWN`).

**Payment:** `NONE` to `AUTH_PENDING_APPROVAL` to `AUTHORIZED` to `CAPTURED` to `PAYOUT_PENDING` to `PAID`. Side states: `VOIDED`, `CAPTURE_DECLINED`, `PAYOUT_FAILED`, `PAYOUT_UNCLAIMED`, `RETURNED`.

Every transition is a function that checks the current state and writes an audit row. No direct status updates elsewhere.

---

## 6. Data model (Postgres, Drizzle ORM)

Money is integer cents plus `currency = 'USD'`. Never floats.

| Table | Key columns |
|-------|-------------|
| `orgs` | id, name |
| `users` | id, org_id, email, role (`manager`), auth ids |
| `venues` | id, org_id, name, lat, lng, radius_m |
| `workers` | id, org_id, name, email, paypal_email, skills[], certs[], home_lat, home_lng, reliability_score, status |
| `shift_slots` | id, venue_id, role, start_at, end_at, worker_id nullable, status, base_rate_cents, max_premium_pct, offered_rate_cents, version |
| `offers` | id, slot_id, worker_id, wave, rate_cents, token_hash, expires_at, status, opened_at, claimed_at |
| `payments` | id, slot_id, paypal_order_id, authorization_id, capture_id, payout_batch_id, payout_item_id, sender_batch_id, authorized_cents, captured_cents, worker_pay_cents, platform_fee_cents, status, last_error |
| `ledger_entries` | id, payment_id, type, amount_cents, ref, created_at (append-only) |
| `paypal_events` | event_id (unique), event_type, raw_json, verified, processed_at |
| `notifications` | id, recipient, channel, payload, status, created_at (also powers the Outbox) |
| `push_subscriptions` | id, worker_id, endpoint, keys |
| `llm_usage` | id, day, component, model, calls, input_tokens, output_tokens (for the spend guard) |
| `audit_log` | id, actor, action, entity, entity_id, before, after, at |

**Integrity rules**
- Atomic claim: `UPDATE shift_slots SET status='CONFIRMED', worker_id=$w, version=version+1 WHERE id=$s AND status='OFFERING' RETURNING *`. Zero rows means "taken". Back it with a partial unique index so a slot has one confirmed offer.
- Webhook idempotency: `paypal_events.event_id` unique; process once.
- Payout idempotency: deterministic `sender_batch_id` plus `PayPal-Request-Id`. A duplicate `sender_batch_id` within 30 days is rejected by PayPal; a 5xx may be retried with the same id.

---

## 6A. Supabase database rules (verified against Supabase docs and the account, Oct 11, 2026)

**Scope:** Supabase provides **Postgres only**. App auth stays with Auth.js or Better Auth. No Supabase client library, Auth, Storage, Realtime, or Edge Functions.

**Project:** name `shiftcover`, in the organization "test@studioq.co.in's Org". Creating it costs $0 (checked with the Supabase MCP `get_cost`). The org already has one project, `triallensdb` (Mumbai, `ap-south-1`); **do not touch it**. The free plan allows 2 active projects, so this is the last free slot. Region: **`us-west-2` (West US, Oregon)**, created by Kumar and confirmed healthy via the Supabase MCP (Postgres 17). Paired with Render **Oregon**. Chosen for US-based judges; from India expect roughly 250 ms per query round trip in local dev, so keep dev loops query-light.

**Connections (Supabase "Connect to your database" doc):**
- Render web, Render worker, local dev, and migrations all use the **Shared pooler, session mode**: `postgres.[PROJECT-REF]@aws-…pooler.supabase.com:5432`. It is IPv4-compatible on every plan and supports prepared statements, advisory locks, and LISTEN/NOTIFY, which pg-boss needs.
- The **direct connection is IPv6-only** on free and paid plans unless the IPv4 add-on is enabled, so do not use it unless IPv6 is confirmed from the machine.
- **Never use transaction mode (port 6543)** for pg-boss, the worker, or migrations: it drops session state and does not support prepared statements.
- Copy the exact string from Dashboard, Connect, Session pooler. Never compose the host from the region. The username is `postgres.[PROJECT-REF]`. Percent-encode special characters in the password. Set SSL to `require` (`sslmode=require`).
- Keep total app connections small (target 10 or fewer across web, worker, and pg-boss) because the free plan's pooler pool is small. Confirm the pool size in Dashboard, Database settings.
- The database password is set or reset in the Dashboard and goes only into local `.env` and Render env vars. It never appears in chat, the repo, or logs.

**Security (mandatory before the first deploy and before the repo goes public):**
1. **Disable the Data API** in the Dashboard (Integrations, Data API, Enable Data API off). The app never uses it. Without this, new tables in `public` receive default grants for `anon`, `authenticated`, and `service_role` on existing projects.
2. Enable **RLS on every app table** in a Drizzle migration (no policies means deny-all for `anon` and `authenticated`). The app connects as `postgres`, which bypasses RLS, so this is defense in depth.
3. Revoke default privileges on `public` for `anon`, `authenticated`, `service_role` per Supabase's securing-your-API guide, and revoke existing grants on app tables. Make this migration **conditional** (only when those roles exist) so it also runs on plain Postgres.
4. Run `get_advisors` (security) after migrating. No ERROR-level findings. Re-run after every DDL change.
5. No anon, publishable, or service-role key anywhere in the repo or env.

**Free-plan limits that matter:** 500 MB database; **projects pause after 1 week of inactivity**; no automatic backups; 2 active projects per org. Judging runs Dec 1 to 15, so a paused project would break the hosted demo. Mitigations: a daily heartbeat job (a cheap query from the worker), a calendar reminder, and a decision by Nov 25 on upgrading the org to Pro (from $25/month; Pro projects never pause; additional projects from $10/month) for the judging window. A paused project can be restored from the Dashboard.

**Migrations and tests:** `db:migrate` runs from Kumar's machine with the session-pooler `DATABASE_URL`. Integration tests that need a clean database must use a throwaway schema (`test_<run>`) created and dropped by the harness, or a local Postgres if available. Never run tests, seeds, or experiments against the `public` data of the demo database.

---

## 7. PayPal integration spec

Base URL (sandbox): `https://api-m.sandbox.paypal.com`. Auth: client-credentials OAuth server-side; cache the token until expiry. Never put the secret in client code.

### 7.1 Accounts (Developer Dashboard, sandbox)
- 1 **Business** account = the platform (receives captures, funds payouts).
- 2 **Personal** accounts = manager/employer payers.
- 5 to 6 **Personal** accounts = workers (their emails become `paypal_email`).
- Payout receiver must not equal the platform account (`SELF_PAY_NOT_ALLOWED`). Guard with `PAYPAL_PLATFORM_EMAIL`.

### 7.2 Authorize (employer approval)
1. Server: create order, `intent: "AUTHORIZE"`, one purchase unit with `amount` = max authorization, `custom_id = slot_id`, `invoice_id = slot_id + "-" + attempt`.
2. Client: PayPal JS SDK v6 button; manager approves with a sandbox buyer. For redirect-style approval (the M0 spike script), create the order with `payment_source.paypal.experience_context` (`return_url`, `cancel_url`, `landing_page`, `shipping_preference`) and send the buyer to the approval link returned in the create-order response, never a hand-built `checkoutnow` URL. A hand-built link produced PayPal's generic error page in the first spike run.
3. Server: authorize the order, store `authorization_id`. Also handle webhook `PAYMENT.AUTHORIZATION.CREATED`.
4. PayPal's webhook docs state authorizations are supported for PayPal-account payments; use the PayPal button, not cards, for this flow.

### 7.3 Capture (actual amount)
`POST /v2/payments/authorizations/{authorization_id}/capture`, body `{ amount: { currency_code, value }, final_capture: true, invoice_id, note_to_payer }`, header `PayPal-Request-Id`. `final_capture: true` closes the authorization so the remainder is released. Capture must not exceed the authorized amount.

### 7.4 Void / reauthorize
- Void: `POST /v2/payments/authorizations/{id}/void` for unfilled and no-show cases.
- Per PayPal's Orders v2 docs (verified Oct 11, 2026): an authorized payment is best captured within **three days** (the honor period) and can be captured for up to **29 days**; after the three-day honor period the original authorization expires and must be reauthorized. `intent: AUTHORIZE` is not supported with more than one `purchase_unit`. Authorizations are auto-voided at the 30-day limit (webhook `PAYMENT.AUTHORIZATION.VOIDED`). We capture within hours, so the honor period should not bind. A reauthorize endpoint exists for shifts booked further out.

### 7.5 Payouts
- `POST /v1/payments/payouts`. Header `PayPal-Request-Id`. Body: `sender_batch_header { sender_batch_id, email_subject, email_message }`, `items[] { recipient_type: "EMAIL", receiver, amount { currency: "USD", value }, note, sender_item_id, purpose: "SERVICES" }`.
- Funded from the platform's **PayPal balance**. Production requires **requesting and getting Payouts access** and a verified business account. In sandbox you can build and test before approval.
- Batch statuses: `DENIED`, `PENDING`, `PROCESSING`, `SUCCESS`. Item statuses: `SUCCESS`, `FAILED`, `PENDING`, `UNCLAIMED`, `RETURNED`, `ONHOLD`, `BLOCKED`, `REFUNDED`, `REVERSED`.
- `PAYMENT.PAYOUTSBATCH.*` webhooks carry no item detail: follow the HATEOAS link or `GET /v1/payments/payouts/{batch_id}`.
- Unclaimed items return to the sender after 30 days.

### 7.6 Webhooks
- One URL for the sandbox app (up to 10 per app). Subscribe to: `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `CHECKOUT.ORDER.APPROVED`, `PAYMENT.PAYOUTSBATCH.DENIED/PROCESSING/SUCCESS`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED/FAILED/HELD/BLOCKED/UNCLAIMED/RETURNED/REFUNDED/CANCELED`.
- Handler: store raw body, **verify the signature** (verify-webhook-signature API with `PAYPAL_WEBHOOK_ID` and the transmission headers), return 2xx fast, process in a job. Non-2xx makes PayPal retry up to 25 times over 3 days.
- Use the Webhooks Simulator and Events dashboard for testing and manual resends.

### 7.7 Reconciliation job
Every 2 to 5 minutes, for non-terminal payments, GET the authorization, capture, or payout batch and advance state. Safety net for delayed or missing sandbox webhooks. It must also re-enqueue `paypal_events` rows whose `processed_at` is null and older than a few minutes (an event that was stored but whose enqueue failed, since the receiver still answers 200 in that case). The webhook route answers 503 until `PAYPAL_WEBHOOK_ID` is set; the app no longer requires it at boot.

### 7.8 Fee model
`platform_fee_cents = round(worker_pay_cents * PLATFORM_FEE_BPS / 10000)`. Employer pays `worker_pay + platform_fee`. The ledger also records PayPal's own capture and payout fees so margin is honest.

### 7.9 Fallback B (if authorize is flaky in sandbox)
Capture up front into the platform balance, hold as escrow in the ledger, refund the unused portion at settlement. Same user story, less elegant.

### 7.10 Production caveat (say it in the video and README)
Capture-then-payout makes the platform an intermediary holding worker funds. Production needs PayPal's marketplace/platform setup with seller onboarding, Payouts approval, worker classification, and tax handling. Out of scope here.

---

## 8. Matching and offer engine

**Hard filters (code only, no LLM):** role/skills match, valid certifications, availability, no overlapping shift, weekly hours under limit, minimum rest, venue allowed.

**Ranking (deterministic score):** reliability, acceptance rate, response speed, distance to venue, prior shifts at this venue. Weights in one config file.

**Waves** (interval `WAVE_INTERVAL_SECONDS`; 300 prod, ~15 demo):

| Wave | Audience | Rate |
|------|----------|------|
| 1 | Top 3 | base |
| 2 | Next 5 | base + 10% (if cap allows) |
| 3 | All eligible | base + 20% (if cap allows) |

Rate never exceeds `base * (1 + max_premium_pct)`. The authorization already covers the worst case, so a higher rate never needs new approval.

**Deadline:** if unfilled by `fill_by` (default start minus 30 min), mark `UNFILLED`, void authorization, notify.

Jobs (pg-boss): `send_wave`, `expire_offer`, `fill_deadline`, `reconcile_payments`, `process_webhook`, `notify`.

---

## 9. AI components (Gemini; code owns eligibility and money)

### 9.1 What the LLM does

| Component | Model env | Input | Output | Guardrails |
|-----------|-----------|-------|--------|------------|
| Gap intake | `LLM_MODEL` | Free text plus venue context | Zod-validated JSON (role, times, rate, cap) | Manager must confirm; reject invalid schema; no money action from parse alone |
| Ranking explanation | `LLM_MODEL` | Top-N candidates plus score parts | Short "why" per worker | Cannot change order or eligibility |
| Offer copy | `LLM_MODEL` | Gap plus rate | Short honest message | Rate and amounts injected by code, never generated |
| Shift recap | `LLM_MODEL` | Completed shift data | One-line recap | Read-only |

### 9.2 Provider facts (verified Oct 11, 2026 from Google's docs; re-check before locking)
- Model for this app: **`gemini-3.5-flash-lite` only** (stable, low-latency, cost-efficient). Its model page lists **structured outputs** and **thinking** as supported, with 1,048,576 input and 65,536 output token limits (page last updated July 2026).
- Paid-tier standard pricing for `gemini-3.5-flash-lite`: $0.30 in / $2.50 out per 1M tokens (Batch and Flex are half that but unsuitable for interactive calls). Thinking tokens bill as output.
- **Free tier content is used to improve Google products; paid tier content is not.** Use a project with billing linked (paid tier) and send only synthetic data regardless.
- Prepaid credits: when the balance hits $0, **all API keys on that billing account stop** (HTTP 402). Credits expire after 12 months and are non-refundable. Billing lags about 10 minutes, so small overages are possible.
- **Project spend caps** exist in AI Studio (Spend page, experimental, same 10-minute lag). Auto-reload is optional: **leave it off**, or set a Monthly Auto-Charge Limit if you enable it.
- Rough cost: an intake call (about 1.5k input, 0.5k output tokens) is about $0.002 on `gemini-3.5-flash-lite`. USD 50 covers roughly 25,000 calls. The real risk is loops, retries, and public abuse, not normal use.
- SDK: `@google/genai`. Current docs use the Interactions API for structured output (`response_format` with `mime_type: application/json` and a JSON Schema; Zod via `z.fromJSONSchema`). **Read the current Structured outputs doc before coding, pin the SDK version, and isolate all calls in `src/llm/gemini.ts`** so an API change touches one file.
- In the Oct 13 spike, run 20 seeded gap phrases through `gemini-3.5-flash-lite` with structured output and measure schema-valid rate and field accuracy. If quality is not good enough, **tell Kumar and propose options; never silently switch models.**

### 9.3 Spend and abuse guardrails (mandatory)
1. `GEMINI_API_KEY` is server-only. Never in client code, logs, `NEXT_PUBLIC_*`, or the repo.
2. Use a **dedicated AI Studio project and key** for this app. If possible use a dedicated billing account, because a $0 balance stops every key on the shared account.
3. Set a **project spend cap** in AI Studio and **do not enable auto-reload**.
4. `LLM_ENABLED` kill switch checked on every call.
5. Caps in code: `LLM_MAX_OUTPUT_TOKENS` per call, `LLM_DAILY_CALL_CAP` (app-wide), `LLM_PER_USER_HOURLY_CAP`. Track in `llm_usage`; refuse when exceeded.
6. At most one retry with backoff. No retry storms. No LLM calls inside webhook handlers or per-item loops. Cache offer copy per (gap, wave).
7. Only authenticated managers can hit the intake endpoint; demo mode adds per-session rate limits.
8. **Deterministic fallback:** when the LLM is disabled, capped, or failing, intake uses a rules-based parser that handles the seeded demo phrases, and explanations fall back to templates. The demo must never break on an AI outage.
9. Keep thinking effort low for these small tasks (thinking tokens are billed).
10. Treat all free text as untrusted data, never instructions. Log prompts and outputs (synthetic data only) for the transparency view.

Disclose in the Devpost submission: which Gemini models are used and for what.

---

## 10. UI: handoff from Claude Design

### 10.1 Rule
Kumar provides the UI. The agent builds headless (API, domain logic, DB, jobs, PayPal, tests, scripts) and **stops at each UI Gate to request the screens**. No improvised UI.

### 10.2 What is allowed before a gate
- API routes, server actions, domain code, tests, CLI scripts.
- A minimal **unstyled `/dev/*` harness** only where a browser is unavoidable (for example, the PayPal approval button or a claim POST). No CSS, no layout choices, no copywriting, clearly marked DEV ONLY, excluded from production builds, deleted when the real screen lands.

### 10.3 UI Gate protocol
At each gate the agent posts a **UI REQUEST** and waits:

```
UI GATE <n> REQUEST
Screens needed: <list>
States per screen: <loading / empty / error / success / edge states>
Data contract per screen: <fields and types the screen will receive>
Actions per screen: <buttons and the API each calls>
Constraints: mobile-first (worker), desktop-first (manager), accessibility, PWA needs
Bryntum: <theme/CSS-variable mapping needed, manager roster only>
Delivery format wanted: <HTML/CSS/React export, design tokens, screenshots, or spec>
Needed by: <date>
```

On receipt: apply design tokens first, then components, then screens. Implement faithfully; do not restyle. If the design conflicts with the data or flow, ask a question rather than redesigning. Log every deviation.

### 10.4 Gates
| Gate | Needed by | Screens |
|------|-----------|---------|
| **G1** | **Oct 16** | Manager: login, roster (Bryntum host area), new gap (NL box, form, parsed card, "Approve max cost with PayPal"), gap detail (wave timeline, offers, money timeline). Worker: claim card (all states), post-claim confirmation |
| **G2** | **Oct 22** | Worker: My shifts (upcoming, active with arrived and finished, past), Earnings, Profile. Manager: Approvals, Money/ledger, Workers directory and invite |
| **G3** | **Oct 30** | Outbox, demo persona switcher and clock controls, empty/loading/error states, notification permission prompt, landing page, **HTML email templates**, PWA icons and splash |

If a gate is late, keep building headless work from later milestones. Never substitute improvised UI.

### 10.5 Screens that exist (what, not how they look)
**Worker (mobile-first, no install):** Claim card (pay amount, role, venue, time, distance, expiry, single Claim button; states: loading, available, taken, expired, claimed); My shifts; Earnings with status per shift (Approved, Paying, Paid) and PayPal reference; Profile (skills, home area, payout email with OTP to change, notification permission).

**Manager (desktop-first, responsive):** Roster (Bryntum Scheduler, gap rows highlighted, live fills); New gap (NL box and form, parsed card, PayPal approval); Gap detail (waves, offers, claim, money timeline: Authorized, Captured, Paid); Approvals; Money (ledger, fees, per-shift breakdown); Outbox (demo only).

**Inputs for the design brief:** money is always visible and unambiguous; states are never silent; irreversible actions need confirmation; accessible contrast and touch targets; reduced motion respected; Bryntum Scheduler needs a theme mapped to the design tokens.

---

### 10.6 Data contracts (what each Gate 1 screen receives; API DTOs must match exactly)

Money fields are integer cents, USD. Timestamps are ISO 8601 UTC. Add fields only by listing them as deviations.

- **Slot:** `id`, `role`, `venue_name`, `venue_area`, `start_at`, `end_at`, `hours`, `status` (planned, open, offering, confirmed, in_progress, pending_approval, settling, settled, unfilled, cancelled, no_show), `worker {id, name, role}` or null, `base_rate_cents`, `max_premium_pct`, `offered_rate_cents`, `fill_by`.
- **Offer:** `id`, `worker {name, role}`, `wave` (1 to 3), `rate_cents`, `status` (sent, opened, claimed, declined, expired, withdrawn), `sent_at`, `opened_at`, `claimed_at`, `expires_at`.
- **Wave summary:** `wave`, `sent_at`, `audience_count`, `rate_cents`, `capped` (boolean).
- **Payment:** `status` (none, awaiting_approval, authorized, captured, payout_pending, paid, voided, capture_declined, payout_failed), `authorized_cents`, `captured_cents`, `worker_pay_cents`, `platform_fee_cents`, `paypal_references {order, authorization, capture, payout}`, `last_error`.
- **Worker-facing offer:** slot summary (`role`, `venue_name`, `venue_area`, `start_at`, `end_at`, `hours`, `distance_mi`), `rate_cents`, `pay_total_cents`, `expires_at`, `state` (available, taken, expired, withdrawn, invalid).
- **Roster:** `resources` (workers with name, role, initials), `events` (slots as above), and a `summary` (`open_gaps`, `offering`, `shifts_today`).
- **Parse result (report a gap):** `source` ("rules" or "llm"), parsed fields (role, date, start, end, venue, base rate, max premium %), and computed money (`worker_pay_at_cap_cents`, `platform_fee_cents`, `total_hold_cents`).

---

## 11. Security and integrity checklist

- Secrets only in env; `.env*` and `CLAUDE.md` in `.gitignore` **before the first commit**; commit `.env.example` only.
- Token hashing, single-use claim, CSRF on POST, rate limits on token and claim endpoints.
- Manager routes behind session auth; worker session scoped to their own records (row-level checks in every query).
- Verify every webhook signature; never trust the body alone.
- Idempotency keys on every PayPal write.
- Server computes all amounts; client-supplied amounts are ignored. Authorization cap enforced server-side; a capture above the authorized amount is rejected.
- PII minimization; seed data is synthetic. Nothing real goes to the LLM.
- LLM guardrails (Section 9.3).
- `npm audit` before freeze; no secrets in logs.
- Demo-only controls (`/demo`, fast clock, simulate check-out) compiled out unless `DEMO_MODE=true`. `/dev/*` excluded from production builds.

---

## 12. Environment and setup runbook

### 12.1 `.env.example` (commit this, never real values)

| Variable | Purpose |
|----------|---------|
| `APP_BASE_URL` | Public HTTPS base; used to build links |
| `NODE_ENV`, `DEMO_MODE` | Mode flags |
| `DATABASE_URL` | Supabase **Session pooler** string (port 5432, SSL required), copied from Dashboard Connect. Never commit. See Section 6A |
| `SESSION_SECRET`, `CLAIM_TOKEN_PEPPER` | Session signing; token hashing pepper |
| `PAYPAL_ENV` | `sandbox` |
| `PAYPAL_API_BASE` | `https://api-m.sandbox.paypal.com` |
| `PAYPAL_CLIENT_ID`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | Client ID (public by design) |
| `PAYPAL_CLIENT_SECRET` | **Server only** |
| `PAYPAL_WEBHOOK_ID` | From webhook registration |
| `PAYPAL_PLATFORM_EMAIL` | Platform business email (self-pay guard) |
| `LLM_PROVIDER` | `gemini` |
| `GEMINI_API_KEY` | **Server only** |
| `LLM_MODEL` | `gemini-3.5-flash-lite` |
| `LLM_ENABLED`, `LLM_MAX_OUTPUT_TOKENS`, `LLM_DAILY_CALL_CAP`, `LLM_PER_USER_HOURLY_CAP` | Spend guardrails |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push (`mailto:` subject) |
| `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` | Optional real email; Outbox covers demo |
| `WAVE_INTERVAL_SECONDS` | 300 prod, ~15 demo |
| `PLATFORM_FEE_BPS`, `MAX_PREMIUM_PCT_DEFAULT` | Business config |

### 12.2 `.gitignore` (must exist in the first commit)
```
.env
.env.*
!.env.example
CLAUDE.md
CLAUDE.local.md
node_modules/
.next/
```
If `CLAUDE.md` was already committed: `git rm --cached CLAUDE.md`, commit, and confirm it holds no secrets (history keeps old copies; check before going public). Note: gitignored files do not exist in Claude Code **cloud** sessions, which clone from GitHub. That is why the agent rules live at the top of this file.

### 12.3 Order of operations
1. Repo (https://github.com/alwayskumar-global/shiftcover): first commit has `.gitignore` (12.2), `.env.example`, `LICENSE` (Apache-2.0), `PLAN.md`.
2. PayPal: create sandbox accounts (7.1) and a sandbox REST app; confirm **Payouts** is enabled on the app; copy client ID and secret into local `.env`.
3. Gemini: in AI Studio, create a dedicated project and key; confirm the project is on the **paid tier** (billing linked) so content is not used to improve products; confirm the prepaid balance; set a **project spend cap**; leave auto-reload off.
4. **Spike script** `scripts/spike-paypal.ts`: token, create AUTHORIZE order, approve with a sandbox buyer, authorize, partial capture with `final_capture: true`, payout to a worker account, GET batch, confirm balances. Add `scripts/spike-gemini.ts`: structured intake on 20 seeded phrases with `gemini-3.5-flash-lite`, validate with Zod, record schema-valid rate, accuracy, tokens, and cost. **Go/no-go gate: end of Oct 13.**
5. **Supabase:** create the `shiftcover` project (Section 6A). In the Dashboard reset or copy the DB password (never in chat), copy the **Session pooler** string into local `.env` as `DATABASE_URL`, and **turn the Data API off**. Run migrations, then the security advisors. Then deploy hello-world to Render (web and worker only; Postgres is Supabase) to get a public HTTPS URL, and claim the Render credits via the hackathon page. Create both Render services in the **Oregon** region, next to Supabase `us-west-2`.
6. Register the PayPal webhook (7.6) on that URL; set `PAYPAL_WEBHOOK_ID`; test with the simulator and one real event.
7. Generate VAPID keys: `npx web-push generate-vapid-keys`.
8. Install the Bryntum **public trial** packages (Bryntum's docs state the trial npm packages are public, so no registry login; requires Node >= 20 and React >= 16). Commands, to be **confirmed against Bryntum's current React quick-start before running**: core `npm install @bryntum/scheduler@npm:@bryntum/scheduler-trial`; wrapper `npm install @bryntum/scheduler-react`. In Next.js render Bryntum client-only (`'use client'` plus a dynamic import with `ssr: false`) and verify against Bryntum's React guide. Check trial expiry against judging dates (Section 16).
9. Start building headless (Section 13).

---

## 13. Milestones (IST dates)

| Phase | Dates | Outcome | UI |
|-------|-------|---------|----|
| **M0 Foundations** | Oct 11 to 14 | Repo, DB, auth, Render deploy, webhook registered, **PayPal and Gemini spikes pass (gate)** | none |
| **M1 Core loop (no money)** | Oct 15 to 20 | Headless: roster data, gap creation, hard filters, offers, magic link, atomic claim. **G1 UI arrives Oct 16; integrate Oct 17 to 20** | **G1** |
| **M2 Money** | Oct 21 to 26 | Headless first: authorize, capture, payout, webhooks, ledger, check-in/out, approve and pay. **G2 UI arrives Oct 22; integrate Oct 23 to 26** | **G2** |
| **M3 Intelligence and edges** | Oct 27 to Nov 2 | NL intake (Gemini plus fallback), ranking and explanations, waves and surge cap, no-show and re-offer, Web Push, reconciliation. **G3 UI arrives Oct 30; integrate Oct 31 to Nov 2** | **G3** |
| **M4 Polish and proof** | Nov 3 to 7 | Fidelity pass against designs, demo mode, seed data, README, tests, security pass, secret scan. **Code freeze Nov 7** | none |
| **M5 Ship** | Nov 8 to 11 | Flip repo public (after checklist), video, Devpost text, hosted demo check, submit by Nov 11 evening IST. Nov 12 is buffer only | none |

Each milestone ends with a deployed build and a short written status (what works, what is cut).

---

## 14. Acceptance tests (must pass before freeze)

1. 20 concurrent claims on one slot yield exactly one `CONFIRMED`.
2. Replaying the same webhook 5 times changes state once.
3. A capture request above the authorized amount is rejected server-side.
4. Retrying a payout with the same `sender_batch_id` does not double-pay.
5. Reusing or tampering with a claim token fails; a GET never consumes a token.
6. An unfilled slot voids the authorization and notifies the manager.
7. A no-show with time left (at least an hour) re-offers the shift and keeps the hold; a no-show with less than an hour left voids it. The authorization is voided only when a slot ends `UNFILLED` or `CANCELLED`, or when a no-show leaves too little time to re-offer.
8. With webhooks disabled, the reconciliation job still converges.
9. Worker A cannot read worker B's data.
10. LLM disabled (`LLM_ENABLED=false`) or over cap: intake falls back to the rules parser and the demo flow completes.
11. No secret appears in the repo or its git history (secret scan clean).
12. Judge path: fresh clone, follow README, reach a completed paid shift in demo mode in under 10 minutes.
13. Supabase: Data API disabled, RLS enabled on every app table, `anon` and `authenticated` cannot read any app table, and security advisors show no ERROR findings and no WARN findings outside the library-owned `pgboss` schema. The only expected notices are the intentional INFO "RLS enabled, no policy" ones. (Oct 12 run: 19 INFO, all intentional; the earlier WARN on `ledger_entries_append_only` is fixed. 6 `function_search_path_mutable` WARNs remain on functions in the pg-boss library schema `pgboss`; accepted because the schema is library-owned and not API-exposed. Do not modify pg-boss objects.)

---

## 15. Submission checklist

**Pre-flip checklist (repo goes public):**
- Run a secret scan over the **full git history** (for example `gitleaks detect`). Rotate any key that ever appeared.
- Confirm `CLAUDE.md` and `.env*` were never committed (`git log --all -- CLAUDE.md`).
- `LICENSE` (Apache-2.0) present and detected in the repo About section.
- README: architecture, setup, env table, sandbox test accounts, demo-mode instructions, Bryntum trial note, production caveat (7.10).
- Remove dev-only files (`/dev/*`), debug logs, and anything not meant to be public.
- Set repo description and topics.

**Devpost:** text description; tools list (Gemini models and how used, PayPal APIs, Bryntum, Render); hosted demo URL or complete run instructions; public YouTube video link.

**Video (under 3 min; worker on phone, manager on desktop; no third-party trademarks or copyrighted music beyond the required PayPal button):**

| Time | Beat |
|------|------|
| 0:00 | 6:40 AM: a cook calls in sick |
| 0:15 | Manager types the gap; parsed card; approves max cost with PayPal |
| 0:35 | Offer wave; roster highlights; surge stays under the cap |
| 0:55 | Worker phone: claim card, one tap, taken-by-others state |
| 1:15 | Money timeline: Authorized |
| 1:30 | Shift done, manager approves; Captured then Paid; worker sees "Paid" |
| 2:00 | Edge: no-show voids and re-offers |
| 2:20 | Architecture slide: PayPal Orders, Payments, Payouts, Webhooks; Gemini roles |
| 2:40 | Honest production caveat; close |

**Deadline safety:** Nov 12 12:00 PM PST = Nov 13 01:30 AM IST. Submit by Nov 11 evening IST.

---

## 16. Risks and fallbacks

| Risk | Mitigation |
|------|------------|
| Payouts unusable in sandbox | Spike gate Oct 13; Discord; fallback B plus ledger-simulated payout, stated honestly |
| Authorize approval friction | Keep one button; vaulted pre-approval is stretch only |
| **UI gate arrives late** | Continue headless work from later milestones; never improvise UI; flag the slip the same day |
| Bryntum trial (45 days) expires during judging (Dec 1 to 15) | Ask Bryntum via the PayPal Discord for an extension through Dec 15; otherwise refresh the key before submission; video and README must stand alone |
| **Gemini balance hits $0 or cap trips** | Fallback parser and templates (9.3); spend cap; no auto-reload; alert at 50% of balance |
| **Gemini abuse on the hosted demo** | Auth on intake, per-session limits, daily cap, kill switch |
| **Gemini API shape changes** | SDK pinned; all calls in `src/llm/gemini.ts` |
| Judges cannot run it | Demo mode, hosted URL, Outbox, seeded accounts, README tested from a clean clone |
| **Supabase free project pauses after 1 week of inactivity (breaks the demo during judging)** | Daily heartbeat job, calendar reminder, decide by Nov 25 on Pro for Dec 1 to 15; restore from the Dashboard if paused |
| **Supabase Data API exposes `public` tables** | Disable the Data API, RLS on all tables, revoke default grants, advisors clean (Section 6A) |
| Webhook delays | Reconciliation job |
| Web Push on iOS | Email and in-app are the reliable channels; push is progressive |
| `CLAUDE.md` missing in cloud sessions | Agent rules live in this file |
| Scope creep | Section 3 "Cut" list |

---

## 17. Decisions log and remaining items

**Resolved (Oct 11, 2026):** A1 authorize-capture-payout; A2 hospitality; A3 Bryntum with `@bryntum/scheduler-react`; A4 Next.js (React) with web and worker on Render (Oregon) and Postgres on Supabase (`us-west-2`, Oregon, free plan); A8 UI from Claude Design at gates; A9 Gemini with guardrails; A10 `CLAUDE.md` gitignored; A11 private repo until submission.

**Remaining:**
1. Confirm `gemini-3.5-flash-lite` intake quality after the Oct 13 spike.
2. Design handoff format from Claude Design (HTML/CSS/React export, tokens, screenshots). Agree before G1.
3. Ask Bryntum for a trial extension through Dec 15.
4. Decide whether `PLAN.md` stays in the public repo (it holds no secrets).

---

## 18. Reference links

**Hackathon**
- Overview: https://paypalaihackathon.devpost.com/
- Rules: https://paypalaihackathon.devpost.com/rules
- Resources: https://paypalaihackathon.devpost.com/resources
- FAQs: https://paypalaihackathon.devpost.com/details/faqs
- Updates: https://paypalaihackathon.devpost.com/updates
- Discord (PayPal and sponsors): https://discord.gg/sJ2G6DyvSK

**PayPal**
- Developer docs: https://developer.paypal.com
- Developer Dashboard (sandbox): https://developer.paypal.com/dashboard/
- Payments v2 (authorize, capture, void): https://developer.paypal.com/api/payments/v2
- Orders v2: https://developer.paypal.com/api/orders/v2/
- Payouts API: https://developer.paypal.com/docs/api/payments.payouts-batch/v1/
- Payouts overview and access: https://developer.paypal.com/payouts/use-payouts/overview
- Webhooks: https://developer.paypal.com/api/webhooks/overview
- Webhook event names: https://developer.paypal.com/api/rest/webhooks/event-names
- Sandbox getting started: https://github.com/paypaldev/getting-started-with-paypal-sandbox
- PayPal AI Toolkit: https://github.com/paypal/AI-Toolkit
- MCP quickstart: https://docs.paypal.ai/developer/tools/ai/mcp-quickstart

**Sponsors**
- Bryntum (hackathon page): https://paypalaihackathon.devpost.com/details/bryntum
- Bryntum Scheduler: https://bryntum.com/products/scheduler/
- Bryntum trial: https://bryntum.com/download
- Bryntum public trial npm packages: https://bryntum.com/products/scheduler/docs/guide/Scheduler/npm/repository/public-repository-access
- Bryntum quick start (React): https://bryntum.com/products/scheduler/docs/guide/Scheduler/quick-start/react
- Bryntum React integration guide: https://bryntum.com/products/scheduler/docs/guide/Scheduler/integration/react/guide
- Render (hackathon page): https://paypalaihackathon.devpost.com/details/render
- Render credits claim: https://credits-portal-mmdm.onrender.com/claim/paypal-ai-hackathon
- Render credits docs: https://render.com/docs/credits

**Gemini**
- Pricing: https://ai.google.dev/gemini-api/docs/pricing
- Billing, prepay, spend caps: https://ai.google.dev/gemini-api/docs/billing
- Structured outputs: https://ai.google.dev/gemini-api/docs/structured-output
- Model page (gemini-3.5-flash-lite): https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
- AI Studio usage: https://aistudio.google.com/usage
- AI Studio spend caps: https://aistudio.google.com/spend

**Supabase**
- Connect to your database (session pooler vs direct): https://supabase.com/docs/guides/database/connecting-to-postgres
- Securing your API (Data API, grants, RLS): https://supabase.com/docs/guides/api/securing-your-api
- Drizzle quickstart: https://supabase.com/docs/guides/database/drizzle
- Pricing and free-plan limits: https://supabase.com/pricing

**Repo**
- https://github.com/alwayskumar-global/shiftcover
