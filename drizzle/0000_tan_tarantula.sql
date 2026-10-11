CREATE TYPE "public"."ledger_entry_type" AS ENUM('AUTHORIZED', 'CAPTURED', 'VOIDED', 'PAYOUT_SENT', 'PAID', 'PAYOUT_FAILED', 'RETURNED', 'PLATFORM_FEE', 'PAYPAL_CAPTURE_FEE', 'PAYPAL_PAYOUT_FEE');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'email', 'push');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('SENT', 'OPENED', 'CLAIMED', 'DECLINED', 'EXPIRED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('NONE', 'AUTH_PENDING_APPROVAL', 'AUTHORIZED', 'CAPTURED', 'PAYOUT_PENDING', 'PAID', 'VOIDED', 'CAPTURE_DECLINED', 'PAYOUT_FAILED', 'PAYOUT_UNCLAIMED', 'RETURNED');--> statement-breakpoint
CREATE TYPE "public"."slot_status" AS ENUM('PLANNED', 'OPEN', 'OFFERING', 'CONFIRMED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'SETTLING', 'SETTLED', 'UNFILLED', 'CANCELLED', 'NO_SHOW');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('manager');--> statement-breakpoint
CREATE TYPE "public"."worker_status" AS ENUM('invited', 'active', 'inactive');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"type" "ledger_entry_type" NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_currency_ck" CHECK ("ledger_entries"."currency" = 'USD')
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"user_key" text DEFAULT '' NOT NULL,
	"component" text NOT NULL,
	"model" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"wave" smallint NOT NULL,
	"rate_cents" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "offer_status" DEFAULT 'SENT' NOT NULL,
	"opened_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_wave_ck" CHECK ("offers"."wave" between 1 and 3),
	CONSTRAINT "offers_rate_ck" CHECK ("offers"."rate_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"paypal_order_id" text,
	"authorization_id" text,
	"capture_id" text,
	"payout_batch_id" text,
	"payout_item_id" text,
	"sender_batch_id" text,
	"authorized_cents" integer DEFAULT 0 NOT NULL,
	"captured_cents" integer DEFAULT 0 NOT NULL,
	"worker_pay_cents" integer DEFAULT 0 NOT NULL,
	"platform_fee_cents" integer DEFAULT 0 NOT NULL,
	"status" "payment_status" DEFAULT 'NONE' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_currency_ck" CHECK ("payments"."currency" = 'USD'),
	CONSTRAINT "payments_cents_ck" CHECK ("payments"."authorized_cents" >= 0 and "payments"."captured_cents" >= 0 and "payments"."worker_pay_cents" >= 0 and "payments"."platform_fee_cents" >= 0),
	CONSTRAINT "payments_capture_le_auth_ck" CHECK ("payments"."captured_cents" <= "payments"."authorized_cents")
);
--> statement-breakpoint
CREATE TABLE "paypal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"raw_json" jsonb NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"keys" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"role" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"worker_id" uuid,
	"status" "slot_status" DEFAULT 'PLANNED' NOT NULL,
	"base_rate_cents" integer NOT NULL,
	"max_premium_pct" integer DEFAULT 0 NOT NULL,
	"offered_rate_cents" integer,
	"fill_by" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slots_time_ck" CHECK ("shift_slots"."end_at" > "shift_slots"."start_at"),
	CONSTRAINT "slots_rate_ck" CHECK ("shift_slots"."base_rate_cents" >= 0),
	CONSTRAINT "slots_premium_ck" CHECK ("shift_slots"."max_premium_pct" between 0 and 100),
	CONSTRAINT "slots_offered_rate_ck" CHECK ("shift_slots"."offered_rate_cents" is null or "shift_slots"."offered_rate_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" DEFAULT 'manager' NOT NULL,
	"auth_provider" text,
	"auth_subject" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"radius_m" integer DEFAULT 150 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venues_radius_ck" CHECK ("venues"."radius_m" > 0)
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"paypal_email" text,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"certs" text[] DEFAULT '{}'::text[] NOT NULL,
	"home_lat" double precision,
	"home_lng" double precision,
	"reliability_score" double precision DEFAULT 0.5 NOT NULL,
	"status" "worker_status" DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workers_reliability_ck" CHECK ("workers"."reliability_score" between 0 and 1)
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_slot_id_shift_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."shift_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_slot_id_shift_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."shift_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD CONSTRAINT "shift_slots_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD CONSTRAINT "shift_slots_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity","entity_id","at");--> statement-breakpoint
CREATE INDEX "ledger_payment_idx" ON "ledger_entries" USING btree ("payment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_usage_bucket_uq" ON "llm_usage" USING btree ("hour_start","user_key","component","model");--> statement-breakpoint
CREATE INDEX "llm_usage_day_idx" ON "llm_usage" USING btree ("day");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient","created_at");--> statement-breakpoint
CREATE INDEX "notifications_status_idx" ON "notifications" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_token_hash_uq" ON "offers" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_slot_worker_wave_uq" ON "offers" USING btree ("slot_id","worker_id","wave");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_one_claimed_per_slot_uq" ON "offers" USING btree ("slot_id") WHERE "offers"."status" = 'CLAIMED';--> statement-breakpoint
CREATE INDEX "offers_slot_status_idx" ON "offers" USING btree ("slot_id","status");--> statement-breakpoint
CREATE INDEX "offers_worker_status_idx" ON "offers" USING btree ("worker_id","status");--> statement-breakpoint
CREATE INDEX "offers_expires_idx" ON "offers" USING btree ("expires_at") WHERE "offers"."status" in ('SENT', 'OPENED');--> statement-breakpoint
CREATE UNIQUE INDEX "payments_slot_attempt_uq" ON "payments" USING btree ("slot_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_order_uq" ON "payments" USING btree ("paypal_order_id") WHERE "payments"."paypal_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_auth_uq" ON "payments" USING btree ("authorization_id") WHERE "payments"."authorization_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_capture_uq" ON "payments" USING btree ("capture_id") WHERE "payments"."capture_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_sender_batch_uq" ON "payments" USING btree ("sender_batch_id") WHERE "payments"."sender_batch_id" is not null;--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "paypal_events_event_id_uq" ON "paypal_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "paypal_events_unprocessed_idx" ON "paypal_events" USING btree ("received_at") WHERE "paypal_events"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "push_endpoint_uq" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_worker_idx" ON "push_subscriptions" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "slots_venue_start_idx" ON "shift_slots" USING btree ("venue_id","start_at");--> statement-breakpoint
CREATE INDEX "slots_status_idx" ON "shift_slots" USING btree ("status");--> statement-breakpoint
CREATE INDEX "slots_worker_start_idx" ON "shift_slots" USING btree ("worker_id","start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth_uq" ON "users" USING btree ("auth_provider","auth_subject") WHERE "users"."auth_subject" is not null;--> statement-breakpoint
CREATE INDEX "venues_org_idx" ON "venues" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workers_org_email_uq" ON "workers" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "workers_org_status_idx" ON "workers" USING btree ("org_id","status");