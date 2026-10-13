# M2: real money (PayPal sandbox)

Sandbox only, USD only. Money model A1: authorize at gap creation for the max hold, partial capture of actual pay
plus fee on settlement, instant payout to the worker. Code: [`src/paypal`](../src/paypal) (client, gateway, ids, error
mapping), [`src/services/payments.ts`](../src/services/payments.ts), [`shift-day.ts`](../src/services/shift-day.ts),
[`paypal-events.ts`](../src/services/paypal-events.ts).

## PayPal docs used (read 2026-10-13; field names below are from these)

| Area                                                          | URL                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders v2 (create, authorize, show)                           | https://developer.paypal.com/docs/api/orders/v2/ , https://developer.paypal.com/api/orders/v2/orders-authorize , schema https://developer.paypal.com/api/orders/v2/schema.json                                                                                |
| Orders v2 error codes                                         | https://developer.paypal.com/api/rest/reference/orders/v2/errors/                                                                                                                                                                                             |
| Payments v2 (authorizations capture/void/show, captures show) | https://developer.paypal.com/docs/api/payments/v2/ , https://developer.paypal.com/api/payments/v2/authorizations-capture , https://developer.paypal.com/api/payments/v2/authorizations-void , schema https://developer.paypal.com/api/payments/v2/schema.json |
| Payouts v1 (create batch, show batch)                         | https://developer.paypal.com/docs/api/payments.payouts-batch/v1/ , schema https://developer.paypal.com/api/payments.payouts-batch/v1/schema.json                                                                                                              |
| JS SDK v6, PayPal one-time payment                            | https://developer.paypal.com/docsai/payments/methods/paypal/sdk/js/v6/paypal-checkout                                                                                                                                                                         |

Facts taken from them: `PayPal-Request-Id` is an optional idempotency key (1 to 10,000 chars); `Prefer: return=representation`
is needed for the authorize response to carry `purchase_units[].payments.authorizations[]` (default `return=minimal` returns
only id, status, links); capture body `{ amount{currency_code,value}, final_capture, invoice_id, note_to_payer }`; capture
`status` is COMPLETED, DECLINED, PARTIALLY_REFUNDED, PENDING, REFUNDED or FAILED; authorization `status` is CREATED, CAPTURED,
DENIED, PARTIALLY_CAPTURED, VOIDED or PENDING; void answers 200 or 204; payout batch `batch_status` is DENIED, PENDING,
PROCESSING, SUCCESS or CANCELED; payout item `transaction_status` is SUCCESS, FAILED, PENDING, UNCLAIMED, RETURNED, ONHOLD,
BLOCKED, REFUNDED or REVERSED, with `errors{name,message}` and `payout_item_fee`; error issues ORDER_NOT_APPROVED,
PAYER_ACTION_REQUIRED, INSTRUMENT_DECLINED, ORDER_ALREADY_AUTHORIZED, DUPLICATE_INVOICE_ID (orders) and
AUTHORIZATION_VOIDED, AUTHORIZATION_EXPIRED, AUTHORIZATION_ALREADY_CAPTURED, AUTHORIZATION_AMOUNT_EXCEEDED, PAYER_ACCOUNT_*
(payments). The payouts reference names AUTHORIZATION_ERROR; INSUFFICIENT_FUNDS is not listed in the schema and is matched by
name. SDK v6: `https://www.sandbox.paypal.com/web-sdk/v6/core`, `window.paypal.createInstance({clientId, components:
['paypal-payments']})`, `findEligibleMethods()`, a `<paypal-button>` web component, `createPayPalOneTimePaymentSession`
with `onApprove({orderId})`, `onCancel`, `onError`, and `session.start({presentationMode:'auto'}, createOrderPromise)`.

## Idempotency (every write)

| Operation       | PayPal-Request-Id                                                 | Other key                                                                                                              |
| --------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| create order    | `order:<slotId>:<attempt>`                                        | `invoice_id = <slotId>-<attempt>`, `custom_id = <slotId>`                                                              |
| authorize order | `auth:<slotId>:<attempt>`                                         |                                                                                                                        |
| capture         | `capture:<paymentId>` (`:<n>` for the n-th retry after a decline) | `invoice_id`                                                                                                           |
| void            | `void:<paymentId>`                                                |                                                                                                                        |
| payout          | `payout:<slotId>:<attempt>`                                       | `sender_batch_id = sc-<paymentId>` (`-<n>` for a retry after a failed batch), `sender_item_id = <paymentId>-<attempt>` |

A duplicate `sender_batch_id` (HTTP 400 "Batch with given sender_batch_id already exists") is not a failure: PayPal attaches a
link to the original payout in `details[].link[]`; the gateway follows it, reads that batch, and the payment records the
original batch id and status. Without a link the payment stays `PAYOUT_PENDING` for reconcile. A second batch is never created.

A retry after a timeout or 5xx reuses the key (PayPal returns the first result, no second charge or payout). A retry after
a real failure (declined capture, failed payout) bumps the counter, because a failed attempt used its ids.

## Flows

1. **Gap created** -> payment `AUTH_PENDING_APPROVAL`; the server creates the PayPal order (intent AUTHORIZE, one purchase
   unit, amount = max hold) and stores `paypal_order_id`. If that call fails the gap still exists; the button asks again
   (`POST /api/manager/gaps/[id]/order`, idempotent).
2. **Approval**: the SDK button's `createOrder` calls the server for the order id; `onApprove({orderId})` calls
   `POST /api/manager/gaps/[id]/authorize {order_id}`. The server authorizes, requires status CREATED and an amount equal
   to the hold (otherwise it voids the stray hold and refuses), stores `authorization_id` and `authorization_expires_at`,
   sets `AUTHORIZED`, appends an AUTHORIZED ledger row. Repeating the call changes nothing. `startOffering` still requires
   AUTHORIZED.
3. **Shift day**: `POST /api/w/shifts/[id]/arrive` and `/finish` (worker session only) store `check_in_at`, `check_out_at`,
   `actual_hours`; `POST /api/manager/shifts/[id]/confirm-times` is the manager fallback. Nothing about location is stored.
4. **Settlement**: `POST /api/manager/shifts/[id]/approve-and-pay {approved_hours}`. Worker pay = approved hours x the
   claimed rate (never above the hold; hours above the scheduled hours are rejected); fee = `PLATFORM_FEE_BPS` plus
   `PLATFORM_FIXED_FEE_CENTS`; capture = pay + fee, rejected before any PayPal call if above the authorization. Capture
   (`final_capture: true`), then payout; ledger rows for every movement (CAPTURED, PLATFORM_FEE, PAYPAL_CAPTURE_FEE,
   PAYOUT_SENT, PAID, PAYPAL_PAYOUT_FEE). Resumable: calling it again, or the reconcile job, continues from the stored state.
5. **Void**: an unfilled or cancelled slot voids the authorization with the real void endpoint after the commit (a PayPal
   call never runs inside a transaction). If PayPal cannot be reached the payment stays AUTHORIZED on a finished slot and
   reconcile voids it.
6. **No-show**: see the plan update below.

## Error mapping

| PayPal                                               | Payment effect                                                        | `last_error`                         |
| ---------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------ |
| authorize ORDER_NOT_APPROVED                         | stays `AUTH_PENDING_APPROVAL` (409)                                   |                                      |
| authorize PAYER_ACTION_REQUIRED, INSTRUMENT_DECLINED | retryable, state unchanged (409)                                      |                                      |
| capture INSTRUMENT_DECLINED, PAYER_ACCOUNT_*         | `CAPTURE_DECLINED`, ledger row, manager notified                      | "PayPal declined the charge."        |
| capture AUTHORIZATION_VOIDED/EXPIRED/DENIED          | stays AUTHORIZED, manager notified: a fresh approval is needed        | "The hold is no longer valid..."     |
| capture PENDING                                      | stays AUTHORIZED with `capture_id`; webhook or reconcile completes it | `capture_pending`                    |
| payout INSUFFICIENT_FUNDS, AUTHORIZATION_ERROR       | `PAYOUT_FAILED`, ledger row                                           | "The platform balance is too low..." |
| payout item FAILED, BLOCKED                          | `PAYOUT_FAILED`                                                       | item status and error name           |
| payout item UNCLAIMED / RETURNED                     | `PAYOUT_UNCLAIMED` / `RETURNED`                                       |                                      |
| payout item ONHOLD                                   | state unchanged, note recorded                                        |                                      |
| network, 5xx, 429                                    | retryable: a 503 `unavailable`; the same call (same ids) is safe      |                                      |

Raw PayPal bodies never reach the client: errors become fixed sentences.

## Webhooks and reconcile

`process_webhook` applies one stored `paypal_events` row: authorization CREATED (no change; our authorize is the source of
truth) and VOIDED, capture COMPLETED, DECLINED, PENDING, REFUNDED, REVERSED, payout batch events (the batch is read, since
batch events carry no item detail) and payout item events. Every state change uses `tryMovePayment`, which refuses a
transition the machine does not allow from the current state, so duplicates and late events cannot regress anything.
Unknown types are marked processed. An event for a payment we cannot find yet is left unprocessed (reconcile re-enqueues it)
and closed as unmatched after 24 hours. `reconcile_payments` (every 3 minutes): re-enqueues stored events older than 5
minutes, then advances each non-terminal payment from PayPal's own records (approved-but-unauthorized orders, pending
captures, approved-but-uncaptured settlements, captured-but-unpaid, pending payouts, voids that failed, holds PayPal
released).

## Plan update (decision by Kumar): re-offer after a no-show

PLAN 4E said "No-show: void authorization (no capture); auto re-offer if time remains" and acceptance test 7 said "No-show
voids and re-offers". New rule: **the authorization stays alive across re-offers; it is voided only when the slot ends
UNFILLED or CANCELLED** (or a no-show leaves too little time to re-offer). With at least
`SHIFT_DAY.noShowReofferMinRemainingMinutes` (60) left, the slot returns to OFFERING for workers who had no offer yet, with a
`SHIFT_DAY.noShowReofferFillMinutes` (30) fill window, and the hold is untouched. Acceptance test 7 should read: "A no-show
with time left re-offers and keeps the hold; a no-show with no time left voids it."

## Fee model (config, not decided)

`platform_fee_cents = round(worker_pay * PLATFORM_FEE_BPS / 10000) + PLATFORM_FIXED_FEE_CENTS` (the fixed part only when
pay > 0). Defaults: 500 bps, 0 fixed. The hold, the settlement and the manager's money table all use the same function
(`platformFee`). The final model is Kumar's call before the first live run.

## Live sandbox run (2026-10-13, local, PayPal sandbox)

`scripts/live-sandbox-m2.ts start|finish` runs the shipped gateway against the real sandbox. The buyer approved as a sandbox
US Personal account; the payout went to a sandbox worker account. PayPal object ids are sandbox ids, not secrets; no token or
credential is recorded here.

| Step                                        | PayPal id           | Result                                                                                             |
| ------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| Order (intent AUTHORIZE, $20.00 hold)       | `4HM97957PE619254R` | PAYER_ACTION_REQUIRED, then APPROVED by the buyer                                                  |
| Authorize (amount checked against the hold) | `93J41748H4825344V` | CREATED, $20.00                                                                                    |
| Capture, partial, `final_capture: true`     | `5AE005976E123234W` | COMPLETED, $12.00, PayPal fee $0.91                                                                |
| Capture repeated with the same request id   | `5AE005976E123234W` | same capture; no second charge                                                                     |
| Payout batch ($10.00 to the worker)         | `94TJZKTHWRUJN`     | batch SUCCESS, item SUCCESS, item fee $0.25                                                        |
| Payout repeated, first run                  | (none)              | HTTP 400 "Batch with given sender_batch_id already exists" (bare 400 before the fix)               |
| Payout repeated after the fix               | `94TJZKTHWRUJN`     | resolved to the ORIGINAL batch through the link in the error (`details[].link[]`); no second batch |

The $2.00 between the capture and the payout stands in for the platform fee. After the capture the authorization reads
CAPTURED; a re-run of the script accepts that state.
