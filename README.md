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
npm run db:verify-rls   # read-only: RLS on every public table, no privileges for API roles
```

6. Dashboard, Database, **Advisors** (Security): expect no ERROR findings. Re-run after every DDL change.

Connection budget: web 5 + worker 3 + worker pg-boss 2 = 10 connections maximum.

### Run

```bash
npm run dev       # web
npm run worker    # pg-boss worker (separate process)
npm test          # unit tests
npm run typecheck && npm run lint && npm run build
```

Spike scripts (`scripts/spike-gemini.ts`, `scripts/spike-paypal.ts`) call live sandbox services; run them only after the env is set.
