ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'CAPTURE_DECLINED';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'PAYOUT_UNCLAIMED';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'REFUNDED';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'REVERSED';--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "capture_attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payout_attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payout_status" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paypal_capture_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paypal_payout_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "authorization_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD COLUMN "check_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD COLUMN "check_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD COLUMN "check_in_by" text;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD COLUMN "check_out_by" text;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD COLUMN "actual_hours" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "shift_slots" ADD COLUMN "approved_hours" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "shift_slots" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD COLUMN "approved_by" text;