-- Supabase advisor WARN function_search_path_mutable: pin the trigger function's search_path.
-- The body only calls RAISE EXCEPTION (no table, function or operator references), so an empty
-- search_path is safe. Conditional so it is a no-op if the function is absent (plain Postgres, fresh DBs
-- are fine too: 0001 creates it first).
DO $$
BEGIN
  IF to_regprocedure('public.ledger_entries_append_only()') IS NOT NULL THEN
    ALTER FUNCTION public.ledger_entries_append_only() SET search_path = '';
  END IF;
END
$$;
