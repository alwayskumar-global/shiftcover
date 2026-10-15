# API data contracts (Section 10.6)

The public JSON shapes of the manager and worker API. `test/contract-10-6.test.ts` reads the field lists below and fails if a DTO in `src/api/dto.ts` drifts from them; additive fields are documented in [`api-m1.md`](api-m1.md) (Deviations).

## 10.6 Data contracts (what each Gate 1 screen receives; API DTOs must match exactly)

Money fields are integer cents, USD. Timestamps are ISO 8601 UTC. Add fields only by listing them as deviations.

- **Slot:** `id`, `role`, `venue_name`, `venue_area`, `start_at`, `end_at`, `hours`, `status` (planned, open, offering, confirmed, in_progress, pending_approval, settling, settled, unfilled, cancelled, no_show), `worker {id, name, role}` or null, `base_rate_cents`, `max_premium_pct`, `offered_rate_cents`, `fill_by`.
- **Offer:** `id`, `worker {name, role}`, `wave` (1 to 3), `rate_cents`, `status` (sent, opened, claimed, declined, expired, withdrawn), `sent_at`, `opened_at`, `claimed_at`, `expires_at`.
- **Wave summary:** `wave`, `sent_at`, `audience_count`, `rate_cents`, `capped` (boolean).
- **Payment:** `status` (none, awaiting_approval, authorized, captured, payout_pending, paid, voided, capture_declined, payout_failed), `authorized_cents`, `captured_cents`, `worker_pay_cents`, `platform_fee_cents`, `paypal_references {order, authorization, capture, payout}`, `last_error`.
- **Worker-facing offer:** slot summary (`role`, `venue_name`, `venue_area`, `start_at`, `end_at`, `hours`, `distance_mi`), `rate_cents`, `pay_total_cents`, `expires_at`, `state` (available, taken, expired, withdrawn, invalid).
- **Roster:** `resources` (workers with name, role, initials), `events` (slots as above), and a `summary` (`open_gaps`, `offering`, `shifts_today`).
- **Parse result (report a gap):** `source` ("rules" or "llm"), parsed fields (role, date, start, end, venue, base rate, max premium %), and computed money (`worker_pay_at_cap_cents`, `platform_fee_cents`, `total_hold_cents`).

---
