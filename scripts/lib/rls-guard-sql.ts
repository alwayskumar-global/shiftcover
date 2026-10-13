/**
 * Standard RLS block (PLAN.md 6A). Appended automatically by `npm run db:generate` to any migration that
 * creates tables, so no table can ship without RLS. Idempotent and safe on plain Postgres.
 */
export const RLS_MARKER = '-- rls-guard: appended by scripts/db-generate.ts';

export const RLS_GUARD_SQL = `${RLS_MARKER}
DO $$
DECLARE
  t record;
  r text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END
$$;
`;
