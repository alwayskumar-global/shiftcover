CREATE TABLE "worker_email_changes" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"new_email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "home_area" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "notify_prefs" jsonb DEFAULT '{"offers_email":true,"offers_push":true,"pay_email":true}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_email_changes" ADD CONSTRAINT "worker_email_changes_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- rls-guard: appended by scripts/db-generate.ts
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
