-- PLAN.md 6A security. The app connects as the table owner (postgres), which bypasses RLS, so this is
-- defense in depth: with RLS on and no policies, anon/authenticated are denied everything even if the
-- Supabase Data API is ever re-enabled. Runs on plain Postgres too (role steps are conditional).
-- Re-run the equivalent for any table added in a later migration; `npm run db:verify-rls` checks it.

-- 1. RLS on every table in public.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END
$$;--> statement-breakpoint

-- 2. Revoke existing grants and default privileges from the Supabase API roles (only if they exist).
DO $$
DECLARE
  r text;
  owner_role text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);

      -- Future objects: defaults are per creating role. Cover the migrator and Supabase's admin role.
      FOREACH owner_role IN ARRAY ARRAY[current_user::text, 'postgres', 'supabase_admin'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = owner_role) THEN
          BEGIN
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I', owner_role, r);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', owner_role, r);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', owner_role, r);
          EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'skipped default privileges for role % (insufficient privilege)', owner_role;
          END;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$$;
