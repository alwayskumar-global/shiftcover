# ShiftCover Pay

When a shift gap appears, ShiftCover Pay fills it fast, guarantees the pay up front, and pays the worker the moment the shift is approved.

PayPal AI Hackathon entry. Sandbox only, USD only. See [PLAN.md](PLAN.md) for the full build plan.

**Status:** Phase M0 (foundations) in progress. Headless only; no UI yet.

## Setup

Requirements: Node >= 20, npm.

```bash
npm install
cp .env.example .env   # then fill in values locally; .env is gitignored
```

### Database: Supabase (Postgres only)

Supabase is used as plain Postgres. Do not add `@supabase/supabase-js`, Supabase Auth, Storage, Realtime, or any anon/publishable/service-role key (PLAN.md 6A).

1. Create a project named `shiftcover` in the Supabase Dashboard.
2. Set or reset the database password in the Dashboard. Keep it out of chat, the repo and logs.
3. Dashboard, **Connect**, **Session pooler**: copy the string into `.env` as `DATABASE_URL`.
   - Port **5432**, host `*.pooler.supabase.com`, user `postgres.<project-ref>`.
   - Never port 6543 (transaction pooler); the app rejects it at startup.
   - Do not use the direct `db.<ref>.supabase.co` host (IPv6-only); the app rejects it.
   - Percent-encode special characters in the password.
4. Dashboard, Integrations, **Data API**: turn it **off**. The app never uses it.
5. Apply migrations from your machine, then verify the lockdown:

```bash
npm run db:migrate      # applies ./drizzle (schema, ledger append-only trigger, RLS lockdown)
npm run db:generate     # after editing src/db/schema.ts: drizzle-kit + automatic RLS guard for new tables
npm run db:verify-rls   # read-only: RLS on every public table, no privileges for API roles
```

6. Dashboard, Database, **Advisors** (Security): expect no ERROR findings. Re-run after every DDL change.

Connection budget: web 5 + worker 3 + worker pg-boss 2 = 10 connections maximum.

### Manager auth (Better Auth)

Managers sign in with email + password or a magic link (`/api/auth/*`, Better Auth 1.7.7 pinned, no extra env: it
reuses `SESSION_SECRET` and `APP_BASE_URL`). Sign-up is disabled; a manager exists only when provisioned by the seed
(which links `auth_user.id` to `users.auth_subject`). Until an email provider exists, sign-in links and offer links are
written to the `notifications` table (the Outbox) instead of being sent.

New env names in M1: `PAYMENTS_MODE` (`paypal` | `stub`; `stub` is rejected in production), `OFFER_TTL_SECONDS`,
and, for the seed only, `SEED_MANAGER_PASSWORD`. Set `PAYMENTS_MODE=stub` locally to authorize payments without PayPal.

### Tests

```bash
npm test            # unit tests (DB tests are skipped)
npm run test:db     # starts a throwaway local Postgres in Docker (scripts/test-db.sh) and runs everything
scripts/test-db.sh down
```

DB-backed tests only ever run against that local container (`TEST_DATABASE_URL` must be loopback), never Supabase.

### Seed (demo data, synthetic)

```bash
SEED_MANAGER_PASSWORD='...' npm run seed        # org "Maple & Rye", manager Dana Whitfield, 10 workers, today's roster
npm run seed:reset                              # deletes only the demo org's rows
```

A non-local `DATABASE_URL` additionally requires `-- --remote` (e.g. `npm run seed -- --remote`).

### Run

```bash
npm run dev       # web
npm run worker    # pg-boss worker (separate process)
npm test          # unit tests
npm run typecheck && npm run lint && npm run build
```

Spike scripts (`scripts/spike-gemini.ts`, `scripts/spike-paypal.ts`) call live sandbox services; run them only after the env is set.
